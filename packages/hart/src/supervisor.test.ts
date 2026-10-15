import { describe, expect, it } from 'vitest'
import { asm as a, toBytes } from './asm.js'
import { CPU } from './cpu.js'
import {
  Csr,
  MIP_MTIP,
  MIP_SSIP,
  MIP_STIP,
  MSTATUS_FS,
  MSTATUS_MIE,
  MSTATUS_MPRV,
  MSTATUS_MXR,
  MSTATUS_SD,
  MSTATUS_SIE,
  MSTATUS_SPIE,
  MSTATUS_SPP,
  MSTATUS_SUM,
  MSTATUS_UXL_SXL_64,
  Priv,
  SATP_MODE_SV39,
} from './csr.js'
import { RAM } from './ram.js'
import { TrapCause } from './trap.js'

/*
 * Memory layout used by these tests (64 KiB of RAM at physical 0):
 *
 *   0x0000  M-mode prologue: load satp/mstatus/mepc from x5/x6/x7, MRET
 *   0x0100  M-mode trap handler (EBREAK → run() stops there with 'breakpoint';
 *           not WFI, which wouldn't stall while an interrupt is still pending)
 *   0x0200  S-mode trap handler (EBREAK)
 *   0x0400  the code under test, entered in S- or U-mode
 *   0x1000  root page table (Sv39: three levels, 8-byte entries): entry 0
 *           identity-maps the first GiB (a gigapage), entry 1 (virtual
 *           0x4000_0000-0x7fff_ffff) points to the middle-level table at L1
 *   0x2000  last-level table (L0) for virtual 0x4000_0000-0x401f_ffff
 *   0x3000, 0x4000  data pages
 *   0x5000  middle-level table (L1): entry 0 points to L0
 */
const M_HANDLER = 0x100
const S_HANDLER = 0x200
const CODE = 0x400
const ROOT = 0x1000
const L0 = 0x2000
const L1 = 0x5000
const VA = 0x40000000 // → L1 → L0

const V = 1, R = 2, W = 4, X = 8, U = 16, A = 64, D = 128
/** A page table entry (the emulator's physical addresses fit in its low 32 bits). */
const pte = (ppn: number, flags: number) => ((ppn << 10) | flags) >>> 0
const SATP = SATP_MODE_SV39 | BigInt(ROOT >>> 12)

/** Page tables for `run()`'s mappings, user-accessible or not. */
function mapPages(ram: RAM, user: boolean) {
  ram.write32(ROOT, pte(0, V | R | W | X | A | D | (user ? U : 0)))
  ram.write32(ROOT + 8, pte(L1 >>> 12, V))
  ram.write32(L1, pte(L0 >>> 12, V))
}

interface Options {
  /** Mode the code at CODE runs in. */
  mode: Priv.Supervisor | Priv.User
  /** Enable Sv39 paging (the identity-mapped first GiB, plus VA → L0). */
  paging?: boolean
  /** Extra mstatus bits to set on entry (SUM, MXR, ...). */
  mstatus?: number
  setup?: (cpu: CPU, ram: RAM) => void
}

function run(code: number[], { mode, paging = true, mstatus = 0, setup }: Options) {
  const ram = new RAM(64 * 1024)
  ram.load(0, toBytes([a.csrrw(0, Csr.satp, 5), a.csrrw(0, Csr.mstatus, 6), a.csrrw(0, Csr.mepc, 7), a.mret()]))
  ram.write32(M_HANDLER, a.ebreak())
  ram.write32(S_HANDLER, a.ebreak())
  ram.load(CODE, toBytes(code))
  mapPages(ram, mode === Priv.User)

  const cpu = new CPU(ram, { breakOnEbreak: true })
  cpu.x64[5] = paging ? SATP : 0n
  cpu.x[6] = (mode << 11) | mstatus
  cpu.x[7] = CODE
  cpu.mtvec = M_HANDLER
  cpu.stvec = S_HANDLER
  setup?.(cpu, ram)
  const stop = cpu.run(1000)
  return { cpu, ram, stop }
}

/** Expect the run to end in the M-mode trap handler with the given cause / tval. */
function expectMachineTrap(r: ReturnType<typeof run>, cause: number, tval?: number) {
  expect(r.stop).toBe('breakpoint')
  expect(r.cpu.pc).toBe(M_HANDLER)
  expect(r.cpu.mcause).toBe(cause)
  if (tval !== undefined) expect(r.cpu.mtval).toBe(tval)
}

describe('Sv39 address translation', () => {
  it('loads and stores through a 4 KiB page, setting the A and D bits', () => {
    const { cpu, ram, stop } = run([a.lw(10, 11, 4), a.sw(12, 11, 8), a.ebreak()], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W))
        ram.write32(0x3004, 1234)
        cpu.x[11] = VA
        cpu.x[12] = 5678
      },
    })
    expect(stop).toBe('breakpoint')
    expect(cpu.priv).toBe(Priv.Supervisor)
    expect(cpu.x[10]).toBe(1234)
    expect(ram.read32(0x3008)).toBe(5678)
    expect(ram.read32(L0) & (A | D)).toBe(A | D)
  })

  it('a load only sets A, not D', () => {
    const { ram } = run([a.lw(10, 11, 0), a.ebreak()], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W))
        cpu.x[11] = VA
      },
    })
    expect(ram.read32(L0) & (A | D)).toBe(A)
  })

  it('an unmapped address raises a load page fault with the virtual address', () => {
    const r = run([a.lw(10, 11, 0)], { mode: Priv.Supervisor, setup: cpu => (cpu.x[11] = VA + 0x2000) })
    expectMachineTrap(r, TrapCause.LoadPageFault, VA + 0x2000)
    expect(r.cpu.mepc).toBe(CODE)
  })

  it('a store to a read-only page raises a store page fault', () => {
    const r = run([a.sw(0, 11, 0)], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R))
        cpu.x[11] = VA
      },
    })
    expectMachineTrap(r, TrapCause.StorePageFault, VA)
  })

  it('fetching from a page without X raises an instruction page fault', () => {
    const r = run([a.jalr(0, 11, 0)], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W))
        cpu.x[11] = VA
      },
    })
    expectMachineTrap(r, TrapCause.InstructionPageFault, VA)
  })

  it('U-mode cannot access supervisor pages', () => {
    const r = run([a.lw(10, 11, 0)], {
      mode: Priv.User,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W))
        cpu.x[11] = VA
      },
    })
    expectMachineTrap(r, TrapCause.LoadPageFault, VA)
  })

  it('S-mode can access user pages only with SUM', () => {
    const userPage = (cpu: CPU, ram: RAM) => {
      ram.write32(L0, pte(3, V | R | W | U))
      ram.write32(0x3000, 42)
      cpu.x[11] = VA
    }
    expectMachineTrap(run([a.lw(10, 11, 0)], { mode: Priv.Supervisor, setup: userPage }), TrapCause.LoadPageFault)
    const { cpu } = run([a.lw(10, 11, 0), a.ebreak()], { mode: Priv.Supervisor, mstatus: MSTATUS_SUM, setup: userPage })
    expect(cpu.x[10]).toBe(42)
  })

  it('a permission checked once is checked again when SUM changes (same page, same TLB entry)', () => {
    // VA + 4K: its TLB entry isn't the code's (VA's would be, and every fetch
    // would replace it), so the second load finds the first one's.
    const r = run([a.lw(10, 11, 0), a.addi(12, 0, 0), a.csrrc(0, Csr.sstatus, 13), a.lw(12, 11, 0)], {
      mode: Priv.Supervisor,
      mstatus: MSTATUS_SUM,
      setup: (cpu, ram) => {
        ram.write32(L0 + 8, pte(3, V | R | W | U))
        ram.write32(0x3000, 42)
        cpu.x[11] = VA + 0x1000
        cpu.x[13] = MSTATUS_SUM
      },
    })
    expect(r.cpu.x[10]).toBe(42) // with SUM
    expectMachineTrap(r, TrapCause.LoadPageFault, VA + 0x1000) // and without
    expect(r.cpu.mepc).toBe(CODE + 12)
  })

  it('MXR makes execute-only pages readable', () => {
    const execOnly = (cpu: CPU, ram: RAM) => {
      ram.write32(L0, pte(3, V | X))
      ram.write32(0x3000, 7)
      cpu.x[11] = VA
    }
    expectMachineTrap(run([a.lw(10, 11, 0)], { mode: Priv.Supervisor, setup: execOnly }), TrapCause.LoadPageFault)
    const { cpu } = run([a.lw(10, 11, 0), a.ebreak()], { mode: Priv.Supervisor, mstatus: MSTATUS_MXR, setup: execOnly })
    expect(cpu.x[10]).toBe(7)
  })

  it('a megapage whose physical page number is not 2 MiB aligned faults', () => {
    const r = run([a.lw(10, 11, 0)], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L1, pte(3, V | R | W)) // a leaf one level up: a 2 MiB page
        cpu.x[11] = VA
      },
    })
    expectMachineTrap(r, TrapCause.LoadPageFault, VA)
  })

  it('non-canonical addresses (bits 63:39 not all equal to bit 38) fault', () => {
    const r = run([a.lw(10, 11, 0)], { mode: Priv.Supervisor, setup: cpu => (cpu.x64[11] = 1n << 38n) })
    expectMachineTrap(r, TrapCause.LoadPageFault, 2 ** 38)
  })

  it('satp ignores writes selecting a mode it lacks (Sv48), as Linux expects', () => {
    const { cpu } = run([a.csrrw(0, Csr.satp, 11), a.ebreak()], {
      mode: Priv.Supervisor,
      setup: cpu => (cpu.x64[11] = BigInt.asIntN(64, (9n << 60n) | 7n)),
    })
    expect(cpu.read('satp')).toBe(SATP)
  })

  it('an access straddling two pages is translated per page', () => {
    // VA+0xffe, reached as (VA+0x800)+0x7fe: 12-bit immediates are signed.
    const { cpu, ram } = run([a.lw(10, 11, 0x7fe), a.sw(12, 11, 0x7fe), a.ebreak()], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W)) // VA        → 0x3000
        ram.write32(L0 + 8, pte(4, V | R | W)) // VA+4K → 0x4000 (adjacent here, but walked separately)
        ram.write16(0x3ffe, 0x2211)
        ram.write16(0x4000, 0x4433)
        cpu.x[11] = VA + 0x800
        cpu.x[12] = 0x88776655
      },
    })
    expect(cpu.x[10]! >>> 0).toBe(0x44332211)
    expect(ram.read16(0x3ffe)).toBe(0x6655)
    expect(ram.read16(0x4000)).toBe(0x8877)
  })

  it('a 32-bit instruction straddling two pages is fetched from both', () => {
    // At VA+0xffe (→ 0x3ffe): addi a0, zero, 42, its upper half on the next
    // page (→ 0x4000), followed by c.ebreak.
    const addi = a.addi(10, 0, 42)
    const setup = (secondPage: boolean) => (_cpu: CPU, ram: RAM) => {
      ram.write32(L0, pte(3, V | R | X))
      if (secondPage) ram.write32(L0 + 8, pte(4, V | R | X))
      ram.write16(0x3ffe, addi & 0xffff)
      ram.write16(0x4000, addi >>> 16)
      ram.write16(0x4002, 0x9002) // c.ebreak
    }
    const jump = [a.lui(1, VA + 0x1000), a.jalr(0, 1, -2)]

    const { cpu, stop } = run(jump, { mode: Priv.Supervisor, setup: setup(true) })
    expect(stop).toBe('breakpoint')
    expect([cpu.x[10], cpu.pc]).toEqual([42, VA + 0x1002])

    // Without the second page: a page fault for the instruction, reporting
    // the address of the part that's missing.
    const r = run(jump, { mode: Priv.Supervisor, setup: setup(false) })
    expectMachineTrap(r, TrapCause.InstructionPageFault, VA + 0x1000)
    expect(r.cpu.mepc).toBe(VA + 0xffe)
  })

  it('a straddling store faults before writing anything if the second page is read-only', () => {
    const r = run([a.sw(12, 11, 0x7fe)], {
      mode: Priv.Supervisor,
      setup: (cpu, ram) => {
        ram.write32(L0, pte(3, V | R | W))
        ram.write32(L0 + 8, pte(4, V | R))
        cpu.x[11] = VA + 0x800
        cpu.x[12] = -1
      },
    })
    expectMachineTrap(r, TrapCause.StorePageFault, VA + 0x1000)
    expect(r.ram.read16(0x3ffe)).toBe(0)
  })

  it('SFENCE.VMA makes page table changes visible', () => {
    const { cpu } = run(
      [
        a.lw(10, 11, 0), // through the old mapping → 0x3000 (and cached in the TLB)
        a.sw(13, 14, 0), // repoint the PTE to 0x4000
        a.sfenceVma(),
        a.lw(15, 11, 0), // → 0x4000
        a.ebreak(),
      ],
      {
        mode: Priv.Supervisor,
        setup: (cpu, ram) => {
          ram.write32(L0, pte(3, V | R | W))
          ram.write32(0x3000, 111)
          ram.write32(0x4000, 222)
          cpu.x[11] = VA
          cpu.x[13] = pte(4, V | R | W)
          cpu.x[14] = L0
        },
      },
    )
    expect([cpu.x[10], cpu.x[15]]).toEqual([111, 222])
  })

  // SFENCE.VMA with an address: the translations that may map it go, even
  // those of other 4 KiB pages of the same superpage (the TLB keeps a
  // superpage's translations a 4 KiB page each).
  it.each([
    ['a 4 KiB page', L0 + 3 * 8, pte(3, V | R | W), 0x3000],
    ['a megapage', L1, pte(0, V | R | W), 0x5000],
    ['a gigapage', ROOT + 8, pte(0, V | R | W), 0x205000],
  ])('SFENCE.VMA with an address forgets its translation: %s', (_, entry, leaf, other) => {
    // VA + 0x3000 → physical 0x3000, through the leaf entry at `entry`.
    const r = run(
      [
        a.lw(10, 11, 0), // the translation is in the TLB now
        a.sw(0, 14, 0), // the leaf entry goes
        a.sfenceVma(13), // for VA + other
        a.lw(10, 11, 0), // faults
        a.ebreak(),
      ],
      {
        mode: Priv.Supervisor,
        setup: (cpu, ram) => {
          ram.write32(entry, leaf)
          ram.write32(0x3000, 111)
          cpu.x[11] = VA + 0x3000
          cpu.x[13] = VA + other
          cpu.x[14] = entry
        },
      },
    )
    expectMachineTrap(r, TrapCause.LoadPageFault, VA + 0x3000)
    expect(r.cpu.x[10]).toBe(111)
  })

  it('with satp in bare mode S-mode addresses are physical', () => {
    const { cpu } = run([a.lw(10, 11, 0), a.ebreak()], {
      mode: Priv.Supervisor,
      paging: false,
      setup: (cpu, ram) => {
        ram.write32(0x3000, 99)
        cpu.x[11] = 0x3000
      },
    })
    expect(cpu.x[10]).toBe(99)
  })

  it('MPRV makes M-mode loads use the MPP privilege (and translation)', () => {
    const ram = new RAM(64 * 1024)
    ram.load(0, toBytes([a.csrrw(0, Csr.satp, 5), a.csrrw(0, Csr.mstatus, 6), a.lw(10, 11, 0), a.ebreak()]))
    mapPages(ram, false)
    ram.write32(L0, pte(3, V | R | W))
    ram.write32(0x3000, 31337)
    const cpu = new CPU(ram, { breakOnEbreak: true })
    cpu.x64[5] = SATP
    cpu.x[6] = MSTATUS_MPRV | (Priv.Supervisor << 11)
    cpu.x[11] = VA
    expect(cpu.run(100)).toBe('breakpoint') // fetches stayed physical (M-mode)
    expect(cpu.x[10]).toBe(31337)
  })
})

describe('supervisor mode and delegation', () => {
  it('ECALL from U-mode goes to S-mode when delegated in medeleg', () => {
    const { cpu, stop } = run([a.ecall()], {
      mode: Priv.User,
      paging: false,
      setup: cpu => (cpu.medeleg = 1 << TrapCause.EnvironmentCallFromUMode),
    })
    expect(stop).toBe('breakpoint')
    expect(cpu.pc).toBe(S_HANDLER)
    expect(cpu.priv).toBe(Priv.Supervisor)
    expect(cpu.scause).toBe(TrapCause.EnvironmentCallFromUMode)
    expect(cpu.sepc).toBe(CODE)
    expect(cpu.mstatus & MSTATUS_SPP).toBe(0) // came from U
  })

  it('ECALL from S-mode reports cause 9 (to M-mode when not delegated)', () => {
    const r = run([a.ecall()], { mode: Priv.Supervisor, paging: false })
    expectMachineTrap(r, TrapCause.EnvironmentCallFromSMode)
  })

  it('traps taken in M-mode are never delegated', () => {
    const ram = new RAM(4096)
    ram.write32(0, 0xffffffff)
    ram.write32(M_HANDLER, a.ebreak())
    const cpu = new CPU(ram, { breakOnEbreak: true })
    cpu.mtvec = M_HANDLER
    cpu.stvec = S_HANDLER
    cpu.medeleg = 1 << TrapCause.IllegalInstruction
    expect(cpu.run(10)).toBe('breakpoint')
    expect(cpu.pc).toBe(M_HANDLER)
    expect(cpu.mcause).toBe(TrapCause.IllegalInstruction)
  })

  it('SRET returns to the mode in SPP and restores SIE from SPIE', () => {
    const { cpu, stop } = run(
      [a.addi(8, 0, CODE + 0x40), a.csrrw(0, Csr.sepc, 8), a.addi(9, 0, MSTATUS_SPIE), a.csrrw(0, Csr.sstatus, 9), a.sret()],
      { mode: Priv.Supervisor, paging: false, setup: (_, ram) => ram.write32(CODE + 0x40, a.ebreak()) },
    )
    expect(stop).toBe('breakpoint')
    expect(cpu.pc).toBe(CODE + 0x40)
    expect(cpu.priv).toBe(Priv.User)
    expect(cpu.mstatus & MSTATUS_SIE).not.toBe(0)
    expect(cpu.mstatus & MSTATUS_SPIE).not.toBe(0)
  })

  it('SRET and MRET are illegal in lower modes', () => {
    expectMachineTrap(run([a.sret()], { mode: Priv.User, paging: false }), TrapCause.IllegalInstruction)
    expectMachineTrap(run([a.mret()], { mode: Priv.Supervisor, paging: false }), TrapCause.IllegalInstruction)
  })

  it('S-mode cannot access machine CSRs, U-mode cannot access supervisor CSRs', () => {
    expectMachineTrap(run([a.csrrs(1, Csr.mstatus, 0)], { mode: Priv.Supervisor, paging: false }), TrapCause.IllegalInstruction)
    expectMachineTrap(run([a.csrrs(1, Csr.sstatus, 0)], { mode: Priv.User, paging: false }), TrapCause.IllegalInstruction)
  })

  it('sstatus is a restricted view of mstatus', () => {
    const { cpu } = run([a.addi(9, 0, -1), a.csrrw(10, Csr.sstatus, 9), a.csrrs(11, Csr.sstatus, 0), a.ebreak()], {
      mode: Priv.Supervisor,
      paging: false,
    })
    // FS written as dirty (3) also shows as SD, the top bit; UXL (64-bit U-mode) is read-only.
    expect(BigInt.asUintN(64, cpu.x64[11]!)).toBe(
      BigInt(MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_FS | MSTATUS_SUM | MSTATUS_MXR) |
        (MSTATUS_UXL_SXL_64 & (3n << 32n)) |
        MSTATUS_SD,
    )
    expect(cpu.mstatus & MSTATUS_MIE).toBe(0) // M bits untouched
  })

  it('sie / sip only expose interrupts delegated in mideleg', () => {
    const { cpu } = run([a.addi(9, 0, -1), a.csrrw(0, Csr.sie, 9), a.csrrs(10, Csr.sie, 0), a.csrrs(11, Csr.sip, 0), a.ebreak()], {
      mode: Priv.Supervisor,
      paging: false,
      setup: cpu => {
        cpu.mideleg = MIP_STIP
        cpu.mip = MIP_MTIP | MIP_STIP
      },
    })
    expect(cpu.x[10]).toBe(MIP_STIP)
    expect(cpu.x[11]).toBe(MIP_STIP)
    expect(cpu.mie).toBe(MIP_STIP)
  })

  it('S-mode can raise and clear its own software interrupt through sip', () => {
    const { cpu } = run([a.csrrsi(0, Csr.sip, MIP_SSIP), a.csrrs(10, Csr.sip, 0), a.ebreak()], {
      mode: Priv.Supervisor,
      paging: false,
      setup: cpu => (cpu.mideleg = MIP_SSIP),
    })
    expect(cpu.x[10]).toBe(MIP_SSIP)
  })
})

describe('supervisor interrupts', () => {
  const pendingSupervisorTimer = (cpu: CPU) => {
    cpu.mideleg = MIP_STIP
    cpu.mie = MIP_STIP
    cpu.setInterruptPending(MIP_STIP, true)
  }

  it('a delegated timer interrupt is taken in U-mode, into S-mode', () => {
    const { cpu } = run([a.addi(0, 0, 0)], { mode: Priv.User, paging: false, setup: pendingSupervisorTimer })
    expect(cpu.pc).toBe(S_HANDLER)
    expect(cpu.read('scause')).toBe(1n << 63n | 5n)
    expect(cpu.sepc).toBe(CODE)
  })

  it('in S-mode it waits for sstatus.SIE', () => {
    const masked = run([a.ebreak()], { mode: Priv.Supervisor, paging: false, setup: pendingSupervisorTimer })
    expect(masked.stop).toBe('breakpoint')
    const enabled = run([a.ebreak()], {
      mode: Priv.Supervisor,
      paging: false,
      mstatus: MSTATUS_SIE,
      setup: pendingSupervisorTimer,
    })
    expect(enabled.cpu.read('scause')).toBe(1n << 63n | 5n)
  })

  it('is never taken in M-mode', () => {
    const ram = new RAM(4096)
    ram.write32(0, a.ebreak())
    const cpu = new CPU(ram, { breakOnEbreak: true })
    cpu.mstatus = MSTATUS_MIE | MSTATUS_SIE
    pendingSupervisorTimer(cpu)
    expect(cpu.run(10)).toBe('breakpoint')
  })

  it('machine interrupts take priority over supervisor ones', () => {
    const { cpu } = run([a.addi(0, 0, 0)], {
      mode: Priv.User,
      paging: false,
      setup: cpu => {
        pendingSupervisorTimer(cpu)
        cpu.mie |= MIP_MTIP
        cpu.setInterruptPending(MIP_MTIP, true)
      },
    })
    expect(cpu.pc).toBe(M_HANDLER)
    expect(cpu.read('mcause')).toBe(1n << 63n | 7n)
  })
})
