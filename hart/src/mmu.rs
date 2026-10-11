//! Virtual memory: Sv32 (RV32: two-level page tables, 4 KiB pages and 4 MiB
//! megapages) and Sv39 (RV64: three levels, 4 KiB, 2 MiB and 1 GiB pages,
//! 39-bit virtual addresses). Physical memory is below 4 GiB (there's nothing
//! above, so mapping it raises an access fault). Accessed/dirty bits are
//! updated by "hardware" (here).
//!
//! The TLB caches what the page tables say (physical page + PTE flags) for a
//! virtual page; permissions are checked on every access against the current
//! privilege and SUM/MXR, so the TLB only needs flushing when the page tables
//! or satp change (SFENCE.VMA / satp writes).

use crate::csr::*;
use crate::hart::{Hart, Result, Trap};
use crate::memory::Access;

// Page table entry bits
const PTE_V: u64 = 1 << 0;
const PTE_R: u64 = 1 << 1;
const PTE_W: u64 = 1 << 2;
const PTE_X: u64 = 1 << 3;
const PTE_U: u64 = 1 << 4;
const PTE_A: u64 = 1 << 6;
const PTE_D: u64 = 1 << 7;
/// Sv39 PTE bits 63:54 (N, PBMT, reserved): none of those extensions here, so they must be 0.
const PTE_SV39_RESERVED: u64 = 0x3ff << 54;

/// Direct mapped, indexed by the low bits of the virtual page number.
pub const TLB_SIZE: usize = 4096;
/// Marks an empty TLB entry (virtual page numbers have at most 52 bits).
pub const TLB_EMPTY: u64 = u64::MAX;

/// Address translation modes (from satp).
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Paging {
    Bare,
    Sv32,
    Sv39,
}

impl Hart {
    pub(crate) fn flush_tlb(&mut self) {
        self.tlb_vpn.fill(TLB_EMPTY);
    }

    /// Translate `vaddr` for an access by `priv_` (the effective privilege: for
    /// loads/stores mstatus.MPRV may substitute MPP).
    #[inline(always)]
    pub(crate) fn translate(&mut self, vaddr: u64, access: Access, priv_: u32) -> Result<u64> {
        // The tag is the whole address above the page offset, so non-canonical
        // Sv39 addresses never hit (only canonical ones get into the TLB).
        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        if self.tlb_vpn[i] == vpn {
            let flags = self.tlb_flags[i] as u64;
            // A first store to a clean page goes through the walk to set D.
            if !(access == Access::Store && flags & PTE_D == 0) {
                if !self.permitted(flags, access, priv_) {
                    return Err(Trap::new(access.page_fault(), vaddr));
                }
                return Ok((self.tlb_ppn[i] as u64) << 12 | (vaddr & 0xfff));
            }
        }
        self.walk(vaddr, access, priv_)
    }

    #[inline(never)]
    fn walk(&mut self, vaddr: u64, access: Access, priv_: u32) -> Result<u64> {
        let fault = Trap::new(access.page_fault(), vaddr);
        // Levels, PTE size, VPN bits per level, root page table.
        let (levels, pte_size, vpn_bits, root) = match self.paging {
            Paging::Sv32 => (2, 4, 10, self.satp & SATP32_PPN),
            _ => {
                // Bits 63:39 must all equal bit 38.
                if ((vaddr << 25) as i64 >> 25) as u64 != vaddr {
                    return Err(fault);
                }
                (3, 8, 9, self.satp & SATP64_PPN)
            }
        };

        let mut table = root << 12;
        let mut level = levels - 1;
        let mut pte_addr;
        let mut pte;
        loop {
            let index = (vaddr >> (12 + level * vpn_bits)) & ((1 << vpn_bits) - 1);
            pte_addr = table + index * pte_size as u64;
            pte = self.phys_read(pte_addr, pte_size).ok_or(Trap::new(access.access_fault(), vaddr))?;
            if pte_size == 8 && pte & PTE_SV39_RESERVED != 0 {
                return Err(fault);
            }
            if pte & PTE_V == 0 || (pte & PTE_R == 0 && pte & PTE_W != 0) {
                return Err(fault);
            }
            if pte & (PTE_R | PTE_X) != 0 {
                break; // leaf
            }
            if level == 0 {
                return Err(fault);
            }
            level -= 1;
            table = (pte >> 10) << 12;
        }

        if !self.permitted(pte, access, priv_) {
            return Err(fault);
        }
        let mut ppn = pte >> 10;
        if level > 0 {
            // A superpage: its physical page number must be aligned to its size.
            let low_bits = (1 << (level * vpn_bits)) - 1;
            if ppn & low_bits != 0 {
                return Err(fault);
            }
            ppn |= (vaddr >> 12) & low_bits;
        }
        if ppn >= 1 << 20 {
            return Err(Trap::new(access.access_fault(), vaddr)); // beyond our 32-bit bus
        }

        let updated = pte | PTE_A | if access == Access::Store { PTE_D } else { 0 };
        if updated != pte {
            // A and D are in the low byte; the rest of the entry stays as it is.
            if !self.phys_write(pte_addr, 1, updated) {
                return Err(Trap::new(access.access_fault(), vaddr));
            }
            pte = updated;
        }

        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        self.tlb_vpn[i] = vpn;
        self.tlb_ppn[i] = ppn as u32;
        self.tlb_flags[i] = pte as u8;
        Ok(ppn << 12 | (vaddr & 0xfff))
    }

    #[inline(always)]
    fn permitted(&self, flags: u64, access: Access, priv_: u32) -> bool {
        if flags & PTE_U != 0 {
            // User pages: fine for U-mode; S-mode may load/store them only with SUM, never execute.
            if priv_ == PRIV_S && (access == Access::Fetch || self.mstatus & MSTATUS_SUM == 0) {
                return false;
            }
        } else if priv_ == PRIV_U {
            return false;
        }
        match access {
            Access::Fetch => flags & PTE_X != 0,
            Access::Load => flags & PTE_R != 0 || (self.mstatus & MSTATUS_MXR != 0 && flags & PTE_X != 0),
            Access::Store => flags & PTE_W != 0,
        }
    }
}
