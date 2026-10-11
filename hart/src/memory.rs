//! Physical memory: RAM lives in this module's linear memory and is accessed
//! directly; everything else (devices) goes out to the JavaScript bus.

use crate::csr::*;
use crate::hart::{Hart, Result, Trap};

// Implemented by src/cpu.ts. Every call takes the hart as its first argument:
// JavaScript ignores it, but it tells the compiler the call may read and write
// the hart's state (devices raise interrupts and stop the CPU from inside
// these calls, and the virtual clock reads the instruction count), so nothing
// is kept in registers across them.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
#[allow(improper_ctypes)] // the hart only goes by as an opaque pointer
unsafe extern "C" {
    /// A device read; returns the (unsigned) value, or -1 on a bus error.
    fn bus_read(hart: *mut Hart, addr: u32, width: u32) -> f64;
    /// A device write; returns 0, or 1 on a bus error.
    fn bus_write(hart: *mut Hart, addr: u32, width: u32, value: u32) -> u32;
    /// The `time` CSR's source (mtime).
    fn read_time(hart: *mut Hart) -> f64;
}

// Native builds (cargo test) have no JavaScript side: there are no devices.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn bus_read(_: *mut Hart, _: u32, _: u32) -> f64 {
    -1.0
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn bus_write(_: *mut Hart, _: u32, _: u32, _: u32) -> u32 {
    1
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn read_time(_: *mut Hart) -> f64 {
    0.0
}

impl Hart {
    /// RAM offset of an access of `width` bytes at physical `pa`, if it's all in RAM.
    #[inline(always)]
    fn ram_offset(&self, pa: u64, width: u32) -> Option<usize> {
        let offset = pa.wrapping_sub(self.ram_base);
        (offset < self.ram_size && offset + width as u64 <= self.ram_size).then_some(offset as usize)
    }

    /// Read `width` (1, 2, 4 or 8) bytes at a physical address; None on a bus error.
    #[inline(always)]
    pub(crate) fn phys_read(&mut self, pa: u64, width: u32) -> Option<u64> {
        match self.ram_offset(pa, width) {
            // SAFETY: ram_offset checked the access is inside the RAM block.
            Some(offset) => unsafe {
                let p = self.ram.add(offset);
                Some(match width {
                    1 => *p as u64,
                    2 => p.cast::<u16>().read_unaligned() as u64,
                    4 => p.cast::<u32>().read_unaligned() as u64,
                    _ => p.cast::<u64>().read_unaligned(),
                })
            },
            None => self.device_read(pa, width),
        }
    }

    /// Write the low `width` (1, 2, 4 or 8) bytes of `value`; false on a bus error.
    #[inline(always)]
    pub(crate) fn phys_write(&mut self, pa: u64, width: u32, value: u64) -> bool {
        match self.ram_offset(pa, width) {
            // SAFETY: ram_offset checked the access is inside the RAM block.
            Some(offset) => unsafe {
                let p = self.ram.add(offset);
                match width {
                    1 => *p = value as u8,
                    2 => p.cast::<u16>().write_unaligned(value as u16),
                    4 => p.cast::<u32>().write_unaligned(value as u32),
                    _ => p.cast::<u64>().write_unaligned(value),
                }
                self.code_written(offset as u64, width as u64);
                true
            },
            None => self.device_write(pa, width, value),
        }
    }

    /// Devices sit on a 32-bit bus with registers of up to 32 bits: a 64-bit
    /// access is two 32-bit ones, low half first.
    #[inline(never)]
    fn device_read(&mut self, pa: u64, width: u32) -> Option<u64> {
        if pa.checked_add(width as u64)? > 1 << 32 {
            return None; // nothing up there
        }
        let read = |hart: &mut Hart, addr: u64, width: u32| {
            // SAFETY: an import implemented in JavaScript.
            let value = unsafe { bus_read(hart, addr as u32, width) };
            (value >= 0.0).then_some(value as u64)
        };
        if width == 8 {
            let low = read(self, pa, 4)?;
            return Some(read(self, pa + 4, 4)? << 32 | low);
        }
        read(self, pa, width)
    }

    #[inline(never)]
    fn device_write(&mut self, pa: u64, width: u32, value: u64) -> bool {
        if pa.checked_add(width as u64).is_none_or(|end| end > 1 << 32) {
            return false;
        }
        let write = |hart: &mut Hart, addr: u64, width: u32, value: u64| {
            // SAFETY: an import implemented in JavaScript.
            unsafe { bus_write(hart, addr as u32, width, value as u32) == 0 }
        };
        if width == 8 {
            return write(self, pa, 4, value) && write(self, pa + 4, 4, value >> 32);
        }
        write(self, pa, width, value)
    }

    pub(crate) fn time(&mut self) -> u64 {
        // SAFETY: an import implemented in JavaScript.
        unsafe { read_time(self) as u64 }
    }

    /// Fetch the instruction at `pc`, as raw bits: if the low two are 11, a
    /// 32-bit instruction, otherwise a compressed one in the low 16 bits (the
    /// upper half is then whatever follows it).
    #[inline(always)]
    pub(crate) fn fetch(&mut self, pc: u64) -> Result<u32> {
        let pa = if self.translate_fetch { self.translate(pc, Access::Fetch, self.priv_)? } else { pc };
        // Fast path: four bytes in RAM, on one page.
        if pc & 0xfff != 0xffe {
            if let Some(offset) = self.ram_offset(pa, 4) {
                // SAFETY: ram_offset checked the access is inside the RAM block.
                return Ok(unsafe { self.ram.add(offset).cast::<u32>().read_unaligned() });
            }
        }
        self.fetch_halves(pc, pa)
    }

    /// Fetch in 16-bit halves: at the end of RAM or of a page (a 32-bit
    /// instruction's upper half is translated on its own), or from a device.
    #[inline(never)]
    fn fetch_halves(&mut self, pc: u64, pa: u64) -> Result<u32> {
        let low = self.phys_read(pa, 2).ok_or(Trap::new(INSTRUCTION_ACCESS_FAULT, pc))? as u32;
        if low & 3 != 3 {
            return Ok(low);
        }
        let pc2 = pc.wrapping_add(2);
        let pa2 = if self.translate_fetch && pc & 0xfff == 0xffe {
            self.translate(pc2, Access::Fetch, self.priv_)?
        } else {
            pa.wrapping_add(2)
        };
        let high = self.phys_read(pa2, 2).ok_or(Trap::new(INSTRUCTION_ACCESS_FAULT, pc2))? as u32;
        Ok(high << 16 | low)
    }

    // Data accesses at virtual addresses, `width` bytes (1, 2, 4 or 8), as
    // unsigned values. An access that straddles a page boundary is done byte
    // by byte, each translated on its own (both pages must be accessible).
    // Access faults report the virtual address.

    #[inline(always)]
    pub(crate) fn load(&mut self, vaddr: u64, width: u32) -> Result<u64> {
        let pa = if !self.translate_data {
            vaddr
        } else if (vaddr & 0xfff) + width as u64 > 0x1000 {
            return self.load_split(vaddr, width);
        } else {
            self.translate_data(vaddr, Access::Load)?
        };
        self.phys_read(pa, width).ok_or(Trap::new(LOAD_ACCESS_FAULT, vaddr))
    }

    #[inline(never)]
    fn load_split(&mut self, vaddr: u64, width: u32) -> Result<u64> {
        let mut value = 0;
        for i in 0..width {
            value |= self.load(vaddr.wrapping_add(i as u64), 1)? << (8 * i);
        }
        Ok(value)
    }

    #[inline(always)]
    pub(crate) fn store(&mut self, vaddr: u64, width: u32, value: u64) -> Result<()> {
        let pa = if !self.translate_data {
            vaddr
        } else if (vaddr & 0xfff) + width as u64 > 0x1000 {
            return self.store_split(vaddr, width, value);
        } else {
            self.translate_data(vaddr, Access::Store)?
        };
        if self.phys_write(pa, width, value) { Ok(()) } else { Err(Trap::new(STORE_ACCESS_FAULT, vaddr)) }
    }

    #[inline(never)]
    fn store_split(&mut self, vaddr: u64, width: u32, value: u64) -> Result<()> {
        // Check the second page before writing anything, so a fault leaves memory untouched.
        let second_page = vaddr.wrapping_add(width as u64 - 1) & !0xfff;
        self.translate(second_page, Access::Store, self.data_priv)?;
        for i in 0..width {
            self.store(vaddr.wrapping_add(i as u64), 1, value >> (8 * i))?;
        }
        Ok(())
    }
}

/// What a memory access is for; selects permission checks and fault causes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Fetch,
    Load,
    /// Also AMOs.
    Store,
}

impl Access {
    pub fn page_fault(self) -> u32 {
        match self {
            Access::Fetch => INSTRUCTION_PAGE_FAULT,
            Access::Load => LOAD_PAGE_FAULT,
            Access::Store => STORE_PAGE_FAULT,
        }
    }

    pub fn access_fault(self) -> u32 {
        match self {
            Access::Fetch => INSTRUCTION_ACCESS_FAULT,
            Access::Load => LOAD_ACCESS_FAULT,
            Access::Store => STORE_ACCESS_FAULT,
        }
    }
}
