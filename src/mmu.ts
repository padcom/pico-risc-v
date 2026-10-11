import { type Bus, BusError } from './bus.js'
import { Priv } from './csr.js'
import { Trap, TrapCause } from './trap.js'

/** What a memory access is for; selects permission checks and fault causes. */
export const enum Access {
  Fetch = 0,
  Load = 1,
  Store = 2, // also AMOs
}

// Page table entry bits
const PTE_V = 1 << 0
const PTE_R = 1 << 1
const PTE_W = 1 << 2
const PTE_X = 1 << 3
const PTE_U = 1 << 4
const PTE_A = 1 << 6
const PTE_D = 1 << 7

const PAGE_FAULT = [TrapCause.InstructionPageFault, TrapCause.LoadPageFault, TrapCause.StorePageFault]
const ACCESS_FAULT = [TrapCause.InstructionAccessFault, TrapCause.LoadAccessFault, TrapCause.StoreAccessFault]

const TLB_SIZE = 4096 // direct mapped, indexed by the low bits of the virtual page number
const PAGE = 4096
const TWO_32 = 0x1_0000_0000

/**
 * Sv32 address translation: two-level page tables, 4 KiB pages and 4 MiB
 * megapages, 34-bit physical addresses (anything above 4 GiB faults: there's
 * nothing there). Accessed/dirty bits are updated by "hardware" (here).
 *
 * The TLB caches what the page tables say (physical page + PTE flags) for a
 * virtual page; permissions are checked on every access against the current
 * privilege and SUM/MXR, so the TLB only needs flushing when the page tables
 * or satp change (SFENCE.VMA / satp writes).
 */
export class Sv32Mmu {
  private readonly tlbVpn = new Int32Array(TLB_SIZE).fill(-1)
  private readonly tlbPpn = new Int32Array(TLB_SIZE)
  private readonly tlbFlags = new Uint8Array(TLB_SIZE)

  constructor(private readonly bus: Bus) {}

  flush(): void {
    this.tlbVpn.fill(-1)
  }

  /**
   * Translate `vaddr` for an access by `priv` (the effective privilege: for
   * loads/stores mstatus.MPRV may substitute MPP). Throws a page or access
   * fault Trap. `rootPpn` is satp.PPN.
   */
  translate(vaddr: number, access: Access, priv: Priv, sum: boolean, mxr: boolean, rootPpn: number): number {
    const vpn = vaddr >>> 12
    const i = vpn & (TLB_SIZE - 1)
    if (this.tlbVpn[i] === vpn) {
      const flags = this.tlbFlags[i]!
      // A first store to a clean page goes through the walk to set D.
      if (!(access === Access.Store && !(flags & PTE_D))) {
        if (!permitted(flags, access, priv, sum, mxr)) throw new Trap(PAGE_FAULT[access]!, vaddr)
        return this.tlbPpn[i]! * PAGE + (vaddr & 0xfff)
      }
    }
    return this.walk(vaddr, access, priv, sum, mxr, rootPpn)
  }

  private walk(vaddr: number, access: Access, priv: Priv, sum: boolean, mxr: boolean, rootPpn: number): number {
    const fault = () => new Trap(PAGE_FAULT[access]!, vaddr)
    let tableBase = rootPpn * PAGE
    let pteAddr = 0
    let pte = 0
    let level = 1
    for (;;) {
      pteAddr = tableBase + ((level === 1 ? vaddr >>> 22 : (vaddr >>> 12) & 0x3ff) << 2)
      pte = this.readPte(pteAddr, access, vaddr)
      if (!(pte & PTE_V) || (!(pte & PTE_R) && pte & PTE_W)) throw fault()
      if (pte & (PTE_R | PTE_X)) break // leaf
      if (level === 0) throw fault()
      level = 0
      tableBase = (pte >>> 10) * PAGE
    }

    if (!permitted(pte, access, priv, sum, mxr)) throw fault()
    let ppn = pte >>> 10
    if (level === 1) {
      if (ppn & 0x3ff) throw fault() // misaligned megapage
      ppn |= (vaddr >>> 12) & 0x3ff
    }
    if (ppn >= TWO_32 / PAGE) throw new Trap(ACCESS_FAULT[access]!, vaddr) // beyond our 32-bit bus

    const updated = pte | PTE_A | (access === Access.Store ? PTE_D : 0)
    if (updated !== pte) {
      this.writePte(pteAddr, updated, access, vaddr)
      pte = updated
    }

    const vpn = vaddr >>> 12
    const i = vpn & (TLB_SIZE - 1)
    this.tlbVpn[i] = vpn
    this.tlbPpn[i] = ppn
    this.tlbFlags[i] = pte & 0xff
    return ppn * PAGE + (vaddr & 0xfff)
  }

  private readPte(addr: number, access: Access, vaddr: number): number {
    if (addr >= TWO_32) throw new Trap(ACCESS_FAULT[access]!, vaddr)
    try {
      return this.bus.read32(addr)
    } catch (e) {
      if (e instanceof BusError) throw new Trap(ACCESS_FAULT[access]!, vaddr)
      throw e
    }
  }

  private writePte(addr: number, value: number, access: Access, vaddr: number): void {
    try {
      this.bus.write32(addr, value)
    } catch (e) {
      if (e instanceof BusError) throw new Trap(ACCESS_FAULT[access]!, vaddr)
      throw e
    }
  }
}

function permitted(flags: number, access: Access, priv: Priv, sum: boolean, mxr: boolean): boolean {
  if (flags & PTE_U) {
    // User pages: fine for U-mode; S-mode may load/store them only with SUM, never execute.
    if (priv === Priv.Supervisor && (access === Access.Fetch || !sum)) return false
  } else if (priv === Priv.User) {
    return false
  }
  switch (access) {
    case Access.Fetch: return (flags & PTE_X) !== 0
    case Access.Load: return (flags & PTE_R) !== 0 || (mxr && (flags & PTE_X) !== 0)
    case Access.Store: return (flags & PTE_W) !== 0
  }
}
