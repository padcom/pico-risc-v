//! Sv32 address translation: two-level page tables, 4 KiB pages and 4 MiB
//! megapages, 34-bit physical addresses (anything above 4 GiB faults: there's
//! nothing there). Accessed/dirty bits are updated by "hardware" (here).
//!
//! The TLB caches what the page tables say (physical page + PTE flags) for a
//! virtual page; permissions are checked on every access against the current
//! privilege and SUM/MXR, so the TLB only needs flushing when the page tables
//! or satp change (SFENCE.VMA / satp writes).

use crate::csr::*;
use crate::hart::{Hart, Result, Trap};
use crate::memory::Access;

// Page table entry bits
const PTE_V: u32 = 1 << 0;
const PTE_R: u32 = 1 << 1;
const PTE_W: u32 = 1 << 2;
const PTE_X: u32 = 1 << 3;
const PTE_U: u32 = 1 << 4;
const PTE_A: u32 = 1 << 6;
const PTE_D: u32 = 1 << 7;

/// Direct mapped, indexed by the low bits of the virtual page number.
pub const TLB_SIZE: usize = 4096;
/// Marks an empty TLB entry (virtual page numbers have only 20 bits).
pub const TLB_EMPTY: u32 = u32::MAX;

impl Hart {
    pub(crate) fn flush_tlb(&mut self) {
        self.tlb_vpn.fill(TLB_EMPTY);
    }

    /// Translate `vaddr` for an access by `priv_` (the effective privilege: for
    /// loads/stores mstatus.MPRV may substitute MPP).
    #[inline(always)]
    pub(crate) fn translate(&mut self, vaddr: u32, access: Access, priv_: u32) -> Result<u32> {
        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        if self.tlb_vpn[i] == vpn {
            let flags = self.tlb_flags[i] as u32;
            // A first store to a clean page goes through the walk to set D.
            if !(access == Access::Store && flags & PTE_D == 0) {
                if !self.permitted(flags, access, priv_) {
                    return Err(Trap::new(access.page_fault(), vaddr));
                }
                return Ok(self.tlb_ppn[i] << 12 | (vaddr & 0xfff));
            }
        }
        self.walk(vaddr, access, priv_)
    }

    #[inline(never)]
    fn walk(&mut self, vaddr: u32, access: Access, priv_: u32) -> Result<u32> {
        let fault = Trap::new(access.page_fault(), vaddr);
        let mut table = ((self.satp & SATP_PPN) as u64) << 12;
        let mut level = 1;
        let mut pte_addr;
        let mut pte;
        loop {
            let index = if level == 1 { vaddr >> 22 } else { (vaddr >> 12) & 0x3ff };
            pte_addr = table + index as u64 * 4;
            pte = self.read_pte(pte_addr, access, vaddr)?;
            if pte & PTE_V == 0 || (pte & PTE_R == 0 && pte & PTE_W != 0) {
                return Err(fault);
            }
            if pte & (PTE_R | PTE_X) != 0 {
                break; // leaf
            }
            if level == 0 {
                return Err(fault);
            }
            level = 0;
            table = ((pte >> 10) as u64) << 12;
        }

        if !self.permitted(pte, access, priv_) {
            return Err(fault);
        }
        let mut ppn = pte >> 10;
        if level == 1 {
            if ppn & 0x3ff != 0 {
                return Err(fault); // misaligned megapage
            }
            ppn |= (vaddr >> 12) & 0x3ff;
        }
        if ppn >= 1 << 20 {
            return Err(Trap::new(access.access_fault(), vaddr)); // beyond our 32-bit bus
        }

        let updated = pte | PTE_A | if access == Access::Store { PTE_D } else { 0 };
        if updated != pte {
            if !self.phys_write(pte_addr as u32, 4, updated) {
                return Err(Trap::new(access.access_fault(), vaddr));
            }
            pte = updated;
        }

        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        self.tlb_vpn[i] = vpn;
        self.tlb_ppn[i] = ppn;
        self.tlb_flags[i] = pte as u8;
        Ok(ppn << 12 | (vaddr & 0xfff))
    }

    fn read_pte(&mut self, addr: u64, access: Access, vaddr: u32) -> Result<u32> {
        let fault = Trap::new(access.access_fault(), vaddr);
        if addr >= 1 << 32 {
            return Err(fault);
        }
        self.phys_read(addr as u32, 4).ok_or(fault)
    }

    #[inline(always)]
    fn permitted(&self, flags: u32, access: Access, priv_: u32) -> bool {
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
