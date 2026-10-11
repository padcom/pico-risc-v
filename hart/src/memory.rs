//! Physical memory: RAM lives in this module's linear memory and is accessed
//! directly; everything else (devices) goes out to the JavaScript bus.

use crate::csr::*;
use crate::hart::{Hart, Result, Trap};

// Implemented by src/cpu.ts. Every call takes the hart as its first argument:
// JavaScript ignores it, but it tells the compiler the call may read and write
// the hart's state (devices raise interrupts and stop the CPU from inside
// these calls, and the virtual clock reads instret), so nothing is kept in
// registers across them.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
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
    fn ram_offset(&self, pa: u32, width: u32) -> Option<usize> {
        let offset = pa.wrapping_sub(self.ram_base);
        (offset as u64 + width as u64 <= self.ram_size as u64).then_some(offset as usize)
    }

    /// Read `width` (1, 2 or 4) bytes at a physical address; None on a bus error.
    #[inline(always)]
    pub(crate) fn phys_read(&mut self, pa: u32, width: u32) -> Option<u32> {
        match self.ram_offset(pa, width) {
            // SAFETY: ram_offset checked the access is inside the RAM block.
            Some(offset) => unsafe {
                let p = self.ram.add(offset);
                Some(match width {
                    1 => *p as u32,
                    2 => p.cast::<u16>().read_unaligned() as u32,
                    _ => p.cast::<u32>().read_unaligned(),
                })
            },
            None => self.device_read(pa, width),
        }
    }

    /// Write the low `width` (1, 2 or 4) bytes of `value`; false on a bus error.
    #[inline(always)]
    pub(crate) fn phys_write(&mut self, pa: u32, width: u32, value: u32) -> bool {
        match self.ram_offset(pa, width) {
            // SAFETY: ram_offset checked the access is inside the RAM block.
            Some(offset) => unsafe {
                let p = self.ram.add(offset);
                match width {
                    1 => *p = value as u8,
                    2 => p.cast::<u16>().write_unaligned(value as u16),
                    _ => p.cast::<u32>().write_unaligned(value),
                }
                true
            },
            None => self.device_write(pa, width, value),
        }
    }

    #[inline(never)]
    fn device_read(&mut self, pa: u32, width: u32) -> Option<u32> {
        // SAFETY: an import implemented in JavaScript.
        let value = unsafe { bus_read(self, pa, width) };
        (value >= 0.0).then_some(value as u32)
    }

    #[inline(never)]
    fn device_write(&mut self, pa: u32, width: u32, value: u32) -> bool {
        // SAFETY: an import implemented in JavaScript.
        unsafe { bus_write(self, pa, width, value) == 0 }
    }

    pub(crate) fn time(&mut self) -> u64 {
        // SAFETY: an import implemented in JavaScript.
        unsafe { read_time(self) as u64 }
    }

    // Instruction fetch and data accesses (virtual addresses). A data access
    // that straddles a page boundary is split, each part translated on its
    // own (both pages must be accessible).

    /// Fetch the instruction at `pc`, as raw bits: if the low two are 11, a
    /// 32-bit instruction, otherwise a compressed one in the low 16 bits (the
    /// upper half is then whatever follows it).
    #[inline(always)]
    pub(crate) fn fetch(&mut self, pc: u32) -> Result<u32> {
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
    fn fetch_halves(&mut self, pc: u32, pa: u32) -> Result<u32> {
        let low = self.phys_read(pa, 2).ok_or(Trap::new(INSTRUCTION_ACCESS_FAULT, pc))?;
        if low & 3 != 3 {
            return Ok(low);
        }
        let pc2 = pc.wrapping_add(2);
        let pa2 = if self.translate_fetch && pc & 0xfff == 0xffe {
            self.translate(pc2, Access::Fetch, self.priv_)?
        } else {
            pa.wrapping_add(2)
        };
        let high = self.phys_read(pa2, 2).ok_or(Trap::new(INSTRUCTION_ACCESS_FAULT, pc2))?;
        Ok(high << 16 | low)
    }

    #[inline(always)]
    fn read_data(&mut self, pa: u32, width: u32) -> Result<u32> {
        self.phys_read(pa, width).ok_or(Trap::new(LOAD_ACCESS_FAULT, pa))
    }

    #[inline(always)]
    fn write_data(&mut self, pa: u32, width: u32, value: u32) -> Result<()> {
        if self.phys_write(pa, width, value) { Ok(()) } else { Err(Trap::new(STORE_ACCESS_FAULT, pa)) }
    }

    #[inline(always)]
    pub(crate) fn load8(&mut self, addr: u32) -> Result<u32> {
        let pa = if self.translate_data { self.translate(addr, Access::Load, self.data_priv)? } else { addr };
        self.read_data(pa, 1)
    }

    #[inline(always)]
    pub(crate) fn load16(&mut self, addr: u32) -> Result<u32> {
        if !self.translate_data {
            return self.read_data(addr, 2);
        }
        if addr & 0xfff > 0xffe {
            return Ok(self.load8(addr)? | self.load8(addr.wrapping_add(1))? << 8);
        }
        let pa = self.translate(addr, Access::Load, self.data_priv)?;
        self.read_data(pa, 2)
    }

    #[inline(always)]
    pub(crate) fn load32(&mut self, addr: u32) -> Result<u32> {
        if !self.translate_data {
            return self.read_data(addr, 4);
        }
        if addr & 0xfff > 0xffc {
            return Ok(self.load16(addr)? | self.load16(addr.wrapping_add(2))? << 16);
        }
        let pa = self.translate(addr, Access::Load, self.data_priv)?;
        self.read_data(pa, 4)
    }

    #[inline(always)]
    pub(crate) fn store8(&mut self, addr: u32, value: u32) -> Result<()> {
        let pa = if self.translate_data { self.translate(addr, Access::Store, self.data_priv)? } else { addr };
        self.write_data(pa, 1, value)
    }

    #[inline(always)]
    pub(crate) fn store16(&mut self, addr: u32, value: u32) -> Result<()> {
        if !self.translate_data {
            return self.write_data(addr, 2, value);
        }
        if addr & 0xfff > 0xffe {
            // Check both pages before writing either, so a fault leaves memory untouched.
            self.translate(addr.wrapping_add(1), Access::Store, self.data_priv)?;
            self.store8(addr, value)?;
            return self.store8(addr.wrapping_add(1), value >> 8);
        }
        let pa = self.translate(addr, Access::Store, self.data_priv)?;
        self.write_data(pa, 2, value)
    }

    #[inline(always)]
    pub(crate) fn store32(&mut self, addr: u32, value: u32) -> Result<()> {
        if !self.translate_data {
            return self.write_data(addr, 4, value);
        }
        if addr & 0xfff > 0xffc {
            self.translate(addr.wrapping_add(3) & !0xfff, Access::Store, self.data_priv)?; // the second page
            self.store16(addr, value)?;
            return self.store16(addr.wrapping_add(2), value >> 16);
        }
        let pa = self.translate(addr, Access::Store, self.data_priv)?;
        self.write_data(pa, 4, value)
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
