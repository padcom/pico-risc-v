//! Virtual memory: Sv39 (three-level page tables, 4 KiB, 2 MiB and 1 GiB
//! pages, 39-bit virtual addresses). Physical memory is below 4 GiB (there's
//! nothing above, so mapping it raises an access fault). Accessed/dirty bits are
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
/// PTE bits 63:54 (N, PBMT, reserved): none of those extensions here, so they must be 0.
const PTE_RESERVED: u64 = 0x3ff << 54;

/// Direct mapped, indexed by the low bits of the virtual page number.
pub const TLB_SIZE: usize = 4096;
/// Marks an empty TLB entry (virtual page numbers have at most 52 bits).
pub const TLB_EMPTY: u64 = u64::MAX;

// tlb_ok: in the low bits whether loads and stores are allowed, above them
// the context that was checked for (Hart::data_ok_tag); 0: not checked.
pub const DATA_LOAD_OK: u8 = 1;
pub const DATA_STORE_OK: u8 = 2;

/// Address translation modes (from satp).
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Paging {
    Bare,
    Sv39,
}

impl Hart {
    /// Translate a load's or store's `vaddr` (the access within one page), for
    /// the current data privilege. Each TLB entry remembers whether loads and
    /// stores were allowed the last time it was checked, and in which context
    /// (`data_ok_tag`: privilege, SUM, MXR); while that's the current one,
    /// that's the whole check.
    #[inline(always)]
    pub(crate) fn translate_data(&mut self, vaddr: u64, access: Access) -> Result<u64> {
        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        let ok = self.tlb_ok[i];
        let bit = if access == Access::Store { DATA_STORE_OK } else { DATA_LOAD_OK };
        if self.tlb_vpn[i] == vpn && ok & !(DATA_LOAD_OK | DATA_STORE_OK) == self.data_ok_tag && ok & bit != 0 {
            return Ok((self.tlb_ppn[i] as u64) << 12 | (vaddr & 0xfff));
        }
        self.translate_data_slow(vaddr, access)
    }

    #[inline(never)]
    fn translate_data_slow(&mut self, vaddr: u64, access: Access) -> Result<u64> {
        let pa = self.translate(vaddr, access, self.data_priv)?;
        let i = (vaddr >> 12) as usize & (TLB_SIZE - 1);
        if self.tlb_vpn[i] == vaddr >> 12 {
            let flags = self.tlb_flags[i] as u64;
            let load = self.permitted(flags, Access::Load, self.data_priv);
            // (A store to a clean page also has to go through the walk, to set D.)
            let store = flags & PTE_D != 0 && self.permitted(flags, Access::Store, self.data_priv);
            self.tlb_ok[i] = self.data_ok_tag | if load { DATA_LOAD_OK } else { 0 } | if store { DATA_STORE_OK } else { 0 };
        }
        Ok(pa)
    }

    pub(crate) fn flush_tlb(&mut self) {
        self.tlb_vpn.fill(TLB_EMPTY);
        self.fetch_vpage = TLB_EMPTY;
    }

    /// Translate `vaddr` for an access by `priv_` (the effective privilege: for
    /// loads/stores mstatus.MPRV may substitute MPP).
    #[inline(always)]
    pub(crate) fn translate(&mut self, vaddr: u64, access: Access, priv_: u32) -> Result<u64> {
        // The tag is the whole address above the page offset, so non-canonical
        // addresses never hit (only canonical ones get into the TLB).
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
        // Bits 63:39 must all equal bit 38.
        if ((vaddr << 25) as i64 >> 25) as u64 != vaddr {
            return Err(fault);
        }

        // Three levels of 512 eight-byte entries, 9 bits of the VPN each.
        let mut table = (self.satp & SATP_PPN) << 12;
        let mut level = 2;
        let mut pte_addr;
        let mut pte;
        loop {
            let index = (vaddr >> (12 + level * 9)) & 0x1ff;
            pte_addr = table + index * 8;
            pte = self.phys_read(pte_addr, 8).ok_or(Trap::new(access.access_fault(), vaddr))?;
            if pte & PTE_RESERVED != 0 {
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
            let low_bits = (1 << (level * 9)) - 1;
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
        self.tlb_ok[i] = 0;
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
