import { describe, expect, it } from 'vitest'
import { asm as a, toBytes, toCode } from './asm.js'
import { CPU } from './cpu.js'
import { Csr, MIP_MTIP, MSTATUS_MIE, MSTATUS_MPIE, MSTATUS_MPP, Priv } from './csr.js'
import { RAM } from './ram.js'
import { TrapCause } from './trap.js'

/** Where test programs install their trap handler (a single WFI, which stops `run()`). */
const HANDLER = 0x100
const INT32_MIN = -0x8000_0000n
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

/** Load a program at 0 (and a WFI at HANDLER), run it until it stops, return the CPU. */
function run(program: number[], setup?: (cpu: CPU, ram: RAM) => void) {
  const ram = new RAM(64 * 1024)
  ram.load(0, toBytes(program))
  ram.write32(HANDLER, a.wfi())
  const cpu = new CPU(ram, { breakOnEbreak: true })
  setup?.(cpu, ram)
  const stop = cpu.run(10_000)
  return { cpu, ram, stop }
}

/** Run `program` with mtvec pointing at HANDLER; expects the program to trap. */
function runTrapping(program: number[], setup?: (cpu: CPU, ram: RAM) => void) {
  const result = run(program, (cpu, ram) => {
    cpu.mtvec = HANDLER
    setup?.(cpu, ram)
  })
  expect(result.stop).toBe('wfi')
  expect(result.cpu.pc).toBe(HANDLER + 4)
  return result
}

describe('encoder sanity (against GNU as output)', () => {
  it.each([
    [a.addi(10, 0, 1), 0x00100513],
    [a.lui(10, 0x12345000), 0x12345537],
    [a.sw(1, 2, 12), 0x00112623],
    [a.lw(10, 2, 0), 0x00012503],
    [a.beq(10, 11, 8), 0x00b50463],
    [a.beq(0, 0, -4), 0xfe000ee3],
    [a.jal(1, 16), 0x010000ef],
    [a.jal(0, -8), 0xff9ff06f],
    [a.add(10, 10, 11), 0x00b50533],
    [a.sub(10, 10, 11), 0x40b50533],
    [a.srai(10, 10, 3), 0x40355513],
    [a.mul(10, 11, 12), 0x02c58533],
    [a.mulhsu(10, 11, 12), 0x02c5a533],
    [a.remu(10, 11, 12), 0x02c5f533],
    [a.lrw(10, 11), 0x1005a52f],
    [a.scw(10, 12, 11), 0x18c5a52f],
    [a.amoaddw(10, 12, 11), 0x00c5a52f],
    [a.amomaxuw(10, 12, 11), 0xe0c5a52f],
    [a.csrrw(10, Csr.mtvec, 11), 0x30559573],
    [a.csrrc(10, Csr.mie, 11), 0x3045b573],
    [a.csrrwi(10, Csr.mscratch, 5), 0x3402d573],
    [a.csrrci(10, Csr.mstatus, 8), 0x30047573],
    [a.ld(10, 2, 8), 0x00813503],
    [a.lwu(10, 11, -4), 0xffc5e503],
    [a.sd(11, 2, 16), 0x00b13823],
    [a.addiw(10, 11, -1), 0xfff5851b],
    [a.slliw(10, 11, 31), 0x01f5951b],
    [a.sraiw(10, 11, 3), 0x4035d51b],
    [a.subw(10, 11, 12), 0x40c5853b],
    [a.sraw(10, 11, 12), 0x40c5d53b],
    [a.divuw(10, 11, 12), 0x02c5d53b],
    [a.slli(10, 11, 63), 0x03f59513],
    [a.srai(10, 11, 63), 0x43f5d513],
    [a.lrd(10, 11), 0x1005b52f],
    [a.scd(10, 12, 11), 0x18c5b52f],
    [a.amomaxud(10, 12, 11), 0xe0c5b52f],
  ])('%s === %s', (got, want) => expect(got).toBe(want))
})

describe('RV64I', () => {
  it('x0 is hardwired to zero', () => {
    const { cpu } = run([a.addi(0, 0, 42), a.ebreak()])
    expect(cpu.x[0]).toBe(0)
  })

  it('ADDI / ADD / SUB with 64-bit wraparound', () => {
    const { cpu } = run([
      a.addi(1, 0, -1), // x1 = -1
      a.addi(2, 0, 1),
      a.add(3, 1, 2), // -1 + 1 = 0
      a.slli(4, 2, 63), // INT64_MIN
      a.sub(5, 4, 2), // INT64_MIN - 1 wraps to INT64_MAX
      a.ebreak(),
    ])
    expect(cpu.x64[1]).toBe(-1n)
    expect(cpu.x64[3]).toBe(0n)
    expect(cpu.x64[4]).toBe(INT64_MIN)
    expect(cpu.x64[5]).toBe(INT64_MAX)
  })

  it('LUI + ADDI builds a 32-bit constant, sign-extended to 64 bits', () => {
    // 0xDEADBEEF: low 12 bits 0xEEF are negative as imm, so upper is 0xDEADC
    const { cpu } = run([a.lui(1, 0xdeadc000), a.addi(1, 1, 0xeef - 0x1000), a.ebreak()])
    expect(cpu.x64[1]).toBe(BigInt.asIntN(64, 0xffff_ffff_dead_beefn))
  })

  it('AUIPC is relative to its own address', () => {
    const { cpu } = run([a.addi(0, 0, 0), a.auipc(1, 0x1000), a.ebreak()])
    expect(cpu.x[1]).toBe(0x1004)
  })

  it('shifts (6-bit amounts) and comparisons (signed vs unsigned)', () => {
    const { cpu } = run([
      a.addi(1, 0, -16),
      a.srai(2, 1, 2), // -4
      a.srli(3, 1, 60), // 0xF
      a.slli(4, 1, 1), // -32
      a.slti(5, 1, 0), // -16 < 0 → 1
      a.sltiu(6, 1, 0), // 0xFFFF_FFFF_FFFF_FFF0 < 0 → 0
      a.sltu(7, 0, 1), // 0 < 0xFFFF_FFFF_FFFF_FFF0 → 1
      a.slt(8, 0, 1), // 0 < -16 → 0
      a.addi(9, 0, 33),
      a.sll(10, 9, 9), // shift amounts come from the low 6 bits: 33 << 33
      a.ebreak(),
    ])
    expect([...cpu.x64.slice(2, 9)]).toEqual([-4n, 0xfn, -32n, 1n, 0n, 1n, 0n])
    expect(cpu.x64[10]).toBe(33n << 33n)
  })

  it('loads sign/zero-extend, stores are little-endian', () => {
    const { cpu, ram } = run([
      a.lui(1, 0x1000), // base = 0x1000
      a.addi(2, 0, -2), // 0xFFFF_FFFF_FFFF_FFFE
      a.sd(2, 1, 0),
      a.lb(3, 1, 0),
      a.lbu(4, 1, 0),
      a.lh(5, 1, 0),
      a.lhu(6, 1, 0),
      a.lw(7, 1, 0),
      a.lwu(8, 1, 0),
      a.ld(9, 1, 0),
      a.addi(10, 0, 0x7f),
      a.sb(10, 1, 8),
      a.ebreak(),
    ])
    expect([...cpu.x64.slice(3, 10)]).toEqual([-2n, 0xfen, -2n, 0xfffen, -2n, 0xffff_fffen, -2n])
    expect(ram.read32(0x1004)).toBe(0xffffffff)
    expect(ram.read8(0x1000)).toBe(0xfe)
    expect(ram.read8(0x1008)).toBe(0x7f)
  })

  it('32-bit operations (*W) wrap at 32 bits and sign-extend the result', () => {
    const { cpu } = run([
      a.lui(1, 0x80000000), // INT32_MIN, sign-extended: 0xFFFF_FFFF_8000_0000
      a.addiw(2, 1, -1), // wraps to INT32_MAX
      a.addi(3, 1, -1), // 64-bit: no wrap
      a.addi(4, 0, 1),
      a.slliw(5, 4, 31), // INT32_MIN
      a.srliw(6, 1, 4), // 0x0800_0000 (zeros shifted in at bit 31)
      a.sraiw(7, 1, 4), // 0xF800_0000, sign-extended
      a.addw(8, 1, 1), // 0x8000_0000 + 0x8000_0000 = 0 in 32 bits
      a.subw(9, 0, 1), // 0 - INT32_MIN = INT32_MIN
      a.ebreak(),
    ])
    expect(cpu.x64[1]).toBe(INT32_MIN)
    expect(cpu.x64[2]).toBe(0x7fff_ffffn)
    expect(cpu.x64[3]).toBe(INT32_MIN - 1n)
    expect([...cpu.x64.slice(5, 10)]).toEqual([INT32_MIN, 0x0800_0000n, -0x0800_0000n, 0n, INT32_MIN])
  })

  it('loops with branches: sum 1..10', () => {
    const { cpu } = run([
      a.addi(1, 0, 10), // counter
      a.addi(2, 0, 0), // sum
      a.add(2, 2, 1), // loop:
      a.addi(1, 1, -1),
      a.bne(1, 0, -8), //   → loop
      a.ebreak(),
    ])
    expect(cpu.x[2]).toBe(55)
  })

  it('JAL / JALR call and return', () => {
    const { cpu } = run([
      a.jal(1, 12), // 0: call fn at 12
      a.addi(10, 10, 100), // 4: after return
      a.ebreak(), // 8
      a.addi(10, 0, 1), // 12: fn
      a.jalr(0, 1, 0), // 16: ret
    ])
    expect(cpu.x[10]).toBe(101)
    expect(cpu.x[1]).toBe(4)
  })

  it('breakOnEbreak stops on the EBREAK without retiring it', () => {
    const { cpu, stop } = run([a.addi(1, 0, 1), a.ebreak()])
    expect(stop).toBe('breakpoint')
    expect(cpu.pc).toBe(4)
    expect(cpu.instret).toBe(1)
  })
})

describe('M', () => {
  // Operands and results as 64-bit register values (all ones = -1n is also
  // the unsigned maximum).
  it.each([
    ['mul', a.mul, 7n, -3n, -21n],
    ['mul overflow', a.mul, INT64_MAX, 2n, -2n],
    ['mulh -1*-1', a.mulh, -1n, -1n, 0n],
    ['mulh INT64_MIN²', a.mulh, INT64_MIN, INT64_MIN, 1n << 62n],
    ['mulh -2*3', a.mulh, -2n, 3n, -1n],
    ['mulhu max²', a.mulhu, -1n, -1n, -2n],
    ['mulhu 2^63*2', a.mulhu, INT64_MIN, 2n, 1n],
    ['mulhsu -1*max', a.mulhsu, -1n, -1n, -1n],
    ['mulhsu 2*2^63', a.mulhsu, 2n, INT64_MIN, 1n],
    ['div', a.div, -7n, 2n, -3n],
    ['rem', a.rem, -7n, 2n, -1n],
    ['divu', a.divu, -7n, 2n, INT64_MAX - 3n],
    ['remu', a.remu, -7n, 2n, 1n],
    ['div by zero', a.div, 5n, 0n, -1n],
    ['divu by zero', a.divu, 5n, 0n, -1n],
    ['rem by zero', a.rem, 5n, 0n, 5n],
    ['remu by zero', a.remu, 5n, 0n, 5n],
    ['div overflow', a.div, INT64_MIN, -1n, INT64_MIN],
    ['rem overflow', a.rem, INT64_MIN, -1n, 0n],
    // 32-bit versions: on the low halves, results sign-extended
    ['mulw overflow', a.mulw, 0x7fff_ffffn, 2n, -2n],
    ['divw overflow', a.divw, INT32_MIN, -1n, INT32_MIN],
    ['divw by zero', a.divw, 5n, 0n, -1n],
    ['divuw', a.divuw, -7n, 2n, 0x7fff_fffcn],
    ['remw', a.remw, -7n, 2n, -1n],
    ['remuw by zero', a.remuw, 0x8000_0000n, 0n, INT32_MIN],
  ] as const)('%s', (_, op, x1, x2, expected) => {
    const { cpu } = run([op(3, 1, 2), a.ebreak()], cpu => {
      cpu.x64[1] = x1
      cpu.x64[2] = x2
    })
    expect(cpu.x64[3]).toBe(expected)
  })
})

describe('A', () => {
  const ADDR = 0x1000
  it.each([
    ['amoswap', a.amoswapw, 10, 5, 5],
    ['amoadd', a.amoaddw, 10, 5, 15],
    ['amoxor', a.amoxorw, 0b1100, 0b1010, 0b0110],
    ['amoand', a.amoandw, 0b1100, 0b1010, 0b1000],
    ['amoor', a.amoorw, 0b1100, 0b1010, 0b1110],
    ['amomin', a.amominw, -5, 3, -5],
    ['amomax', a.amomaxw, -5, 3, 3],
    ['amominu', a.amominuw, -5, 3, 3],
    ['amomaxu', a.amomaxuw, -5, 3, -5],
  ] as const)('%s.w returns the old value (sign-extended) and stores the result', (_, op, old, src, stored) => {
    const { cpu, ram } = run([op(3, 2, 1), a.ebreak()], (cpu, ram) => {
      cpu.x[1] = ADDR
      cpu.x[2] = src
      ram.write32(ADDR, old)
    })
    expect(cpu.x64[3]).toBe(BigInt(old))
    expect(ram.read32(ADDR) | 0).toBe(stored)
  })

  it('.D: AMOs on 64 bits; LR/SC pairs', () => {
    const { cpu, ram } = run(
      [
        a.amoaddd(3, 2, 1), // x3 = old, mem = old + 1
        a.amomaxud(4, 0, 1), // max(mem, 0) unsigned: unchanged
        a.lrd(5, 1),
        a.scd(6, 2, 1), // succeeds: mem = 1
        a.ebreak(),
      ],
      (cpu, ram) => {
        cpu.x[1] = ADDR
        cpu.x[2] = 1
        new DataView(ram.bytes.buffer).setBigUint64(ADDR, 0xffff_ffffn, true)
      },
    )
    expect(cpu.x64[3]).toBe(0xffff_ffffn)
    expect(cpu.x64[4]).toBe(0x1_0000_0000n) // the carry went into the upper half
    expect(cpu.x64[5]).toBe(0x1_0000_0000n)
    expect(cpu.x64[6]).toBe(0n)
    expect(new DataView(ram.bytes.buffer).getBigUint64(ADDR, true)).toBe(1n)
  })

  it('LR/SC succeeds on a valid reservation, then fails once it is used up', () => {
    const { cpu, ram } = run(
      [
        a.lrw(3, 1),
        a.addi(3, 3, 1),
        a.scw(4, 3, 1), // succeeds: x4 = 0
        a.scw(5, 3, 1), // reservation consumed: x5 = 1
        a.ebreak(),
      ],
      (cpu, ram) => {
        cpu.x[1] = ADDR
        ram.write32(ADDR, 41)
      },
    )
    expect(cpu.x[4]).toBe(0)
    expect(cpu.x[5]).toBe(1)
    expect(ram.read32(ADDR)).toBe(42)
  })

  it('SC without a reservation fails and does not store', () => {
    const { cpu, ram } = run([a.scw(4, 2, 1), a.ebreak()], cpu => {
      cpu.x[1] = ADDR
      cpu.x[2] = 99
    })
    expect(cpu.x[4]).toBe(1)
    expect(ram.read32(ADDR)).toBe(0)
  })
})

describe('Zicsr', () => {
  it('CSRRW swaps, CSRRS / CSRRC set and clear bits, immediates work', () => {
    const { cpu } = run(
      [
        a.csrrw(3, Csr.mscratch, 1), // x3 = old mscratch (0), mscratch = 0x55
        a.csrrs(4, Csr.mscratch, 2), // x4 = 0x55, mscratch |= 0x0a → 0x5f
        a.csrrci(5, Csr.mscratch, 0x0f), // x5 = 0x5f, mscratch &= ~0xf → 0x50
        a.csrrsi(6, Csr.mscratch, 0), // read only
        a.ebreak(),
      ],
      cpu => {
        cpu.x[1] = 0x55
        cpu.x[2] = 0x0a
      },
    )
    expect([cpu.x[3], cpu.x[4], cpu.x[5], cpu.x[6]]).toEqual([0, 0x55, 0x5f, 0x50])
    expect(cpu.mscratch).toBe(0x50)
  })

  it('misa reports RV64 with I, M, A, F, D, C, S and U', () => {
    const { cpu } = run([a.csrrs(1, Csr.misa, 0), a.ebreak()])
    const misa = BigInt.asUintN(64, cpu.x64[1]!)
    expect(misa >> 62n).toBe(2n)
    for (const ext of 'IMAFDCSU') expect(misa & (1n << BigInt(ext.charCodeAt(0) - 65))).not.toBe(0n)
  })

  it('mepc keeps bit 1 (instructions are 2-byte aligned)', () => {
    const { cpu } = run([a.addi(1, 0, 7), a.csrrw(0, Csr.mepc, 1), a.csrrs(2, Csr.mepc, 0), a.ebreak()])
    expect(cpu.x[2]).toBe(6)
  })

  it('cycle / instret count retired instructions', () => {
    const { cpu } = run([a.addi(0, 0, 0), a.addi(0, 0, 0), a.csrrs(1, Csr.instret, 0), a.csrrs(2, Csr.cycle, 0), a.ebreak()])
    expect(cpu.x[1]).toBe(2)
    expect(cpu.x[2]).toBe(3)
  })

  it('unknown CSR is an illegal instruction, as are RV32-only ones (cycleh, mstatush)', () => {
    for (const csr of [0x7c0, 0xc80, 0x310]) {
      const inst = a.csrrs(1, csr, 0)
      const { cpu } = runTrapping([inst])
      expect(cpu.mcause).toBe(TrapCause.IllegalInstruction)
      expect(cpu.mtval).toBe(inst)
    }
  })

  it('writing a read-only CSR is illegal, but reading it is fine', () => {
    const { cpu } = runTrapping([a.csrrs(1, Csr.mhartid, 0), a.csrrw(0, Csr.mhartid, 2)])
    expect(cpu.mcause).toBe(TrapCause.IllegalInstruction)
    expect(cpu.mepc).toBe(4)
  })

  it('time CSR is illegal without a time source', () => {
    const { cpu } = runTrapping([a.csrrs(1, Csr.time, 0)])
    expect(cpu.mcause).toBe(TrapCause.IllegalInstruction)
  })
})

describe('traps', () => {
  it('records cause, epc and status, and jumps to mtvec', () => {
    const { cpu } = runTrapping([a.addi(0, 0, 0), a.ecall()], cpu => (cpu.mstatus = MSTATUS_MIE))
    expect(cpu.mcause).toBe(TrapCause.EnvironmentCallFromMMode)
    expect(cpu.mepc).toBe(4)
    expect(cpu.mstatus & MSTATUS_MIE).toBe(0) // interrupts disabled in the handler
    expect(cpu.mstatus & MSTATUS_MPIE).not.toBe(0) // ...and remembered
    expect(cpu.mstatus & MSTATUS_MPP).toBe(MSTATUS_MPP) // came from M-mode
  })

  it('EBREAK traps with mtval = pc when not debugging', () => {
    const { cpu } = runTrapping([a.addi(0, 0, 0), a.ebreak()], cpu => (cpu.breakOnEbreak = false))
    expect(cpu.mcause).toBe(TrapCause.Breakpoint)
    expect(cpu.mtval).toBe(4)
  })

  it('illegal instruction reports the instruction bits', () => {
    const { cpu } = runTrapping([0xffffffff])
    expect(cpu.mcause).toBe(TrapCause.IllegalInstruction)
    expect(cpu.mtval).toBe(0xffffffff)
  })

  it('load / store access faults report the address', () => {
    const base = [a.addi(1, 0, 1), a.slli(1, 1, 31)] // 0x8000_0000: nothing there
    const load = runTrapping([...base, a.lw(2, 1, 8)]).cpu
    expect([load.mcause, load.mepc, load.mtval]).toEqual([TrapCause.LoadAccessFault, 8, 0x80000008])
    const store = runTrapping([...base, a.sd(2, 1, 0)]).cpu
    expect([store.mcause, store.mtval]).toEqual([TrapCause.StoreAccessFault, 0x80000000])
  })

  it('an illegal compressed instruction reports its 16 bits in mtval', () => {
    const { cpu } = runTrapping([0x6081]) // C.LUI with immediate 0 (reserved)
    expect([cpu.mcause, cpu.mepc, cpu.mtval]).toEqual([TrapCause.IllegalInstruction, 0, 0x6081])
    const zero = runTrapping([0]).cpu // all zeros is illegal by design
    expect([zero.mcause, zero.mtval]).toEqual([TrapCause.IllegalInstruction, 0])
  })

  it('misaligned AMO', () => {
    const { cpu } = runTrapping([a.addi(1, 0, 0x402), a.amoaddw(2, 0, 1)])
    expect([cpu.mcause, cpu.mtval]).toEqual([TrapCause.StoreAddressMisaligned, 0x402])
  })

  it('a trapping instruction does not retire or write its destination', () => {
    const { cpu } = runTrapping([a.lui(1, 0x80000000), a.lw(1, 1, 0)])
    expect(cpu.x64[1]).toBe(INT32_MIN)
    expect(cpu.instret).toBe(2) // the LUI and the handler's WFI, not the LW
  })

  it('MRET drops to U-mode; ECALL there reports U-mode; U-mode cannot touch M CSRs', () => {
    // 0: set mepc to 0x20 and MPP = U, then mret
    const { cpu } = runTrapping(
      [
        a.addi(1, 0, 0x20),
        a.csrrw(0, Csr.mepc, 1),
        a.addi(2, 0, 0), // MPP stays 0 (U)
        a.csrrw(0, Csr.mstatus, 2),
        a.mret(),
        0, 0, 0,
        a.ecall(), // 0x20, runs in U-mode
      ],
    )
    expect(cpu.mcause).toBe(TrapCause.EnvironmentCallFromUMode)
    expect(cpu.mepc).toBe(0x20)
    expect(cpu.priv).toBe(Priv.Machine)
    expect(cpu.mstatus & MSTATUS_MPP).toBe(0) // came from U

    const u = runTrapping([a.mret(), a.csrrs(1, Csr.mscratch, 0)], cpu => (cpu.mepc = 4)).cpu
    expect([u.mcause, u.mepc]).toEqual([TrapCause.IllegalInstruction, 4])
  })

  it('MRET jumps to mepc, restores MIE from MPIE and the privilege from MPP', () => {
    const { cpu, stop } = run([a.mret()], (cpu, ram) => {
      ram.write32(0x40, a.ebreak())
      cpu.mepc = 0x40
      cpu.mstatus = MSTATUS_MPIE | MSTATUS_MPP // return to M-mode with interrupts on
    })
    expect(stop).toBe('breakpoint')
    expect(cpu.pc).toBe(0x40)
    expect(cpu.priv).toBe(Priv.Machine)
    expect(cpu.mstatus & MSTATUS_MIE).not.toBe(0)
    expect(cpu.mstatus & MSTATUS_MPIE).not.toBe(0) // set to 1
    expect(cpu.mstatus & MSTATUS_MPP).toBe(0) // set to U
  })
})

describe('interrupts', () => {
  const enableTimer = (cpu: CPU) => {
    cpu.mtvec = HANDLER
    cpu.mie = MIP_MTIP
    cpu.mstatus = MSTATUS_MIE
  }

  it('a pending, enabled timer interrupt is taken before the next instruction', () => {
    const ram = new RAM(4096)
    ram.load(0, toBytes([a.addi(1, 0, 1), a.addi(2, 0, 2)]))
    const cpu = new CPU(ram)
    enableTimer(cpu)
    cpu.step()
    cpu.setInterruptPending(MIP_MTIP, true)
    cpu.step()
    expect(cpu.read('mcause')).toBe(1n << 63n | 7n) // interrupt bit (63), cause 7
    expect(cpu.mepc).toBe(4) // resumes at the instruction that hadn't run yet
    expect(cpu.pc).toBe(HANDLER)
    expect(cpu.x[2]).toBe(0)
  })

  it('is masked by mstatus.MIE in M-mode', () => {
    const ram = new RAM(4096)
    ram.write32(0, a.addi(0, 0, 0))
    const cpu = new CPU(ram)
    enableTimer(cpu)
    cpu.mstatus = 0
    cpu.setInterruptPending(MIP_MTIP, true)
    cpu.step()
    expect(cpu.pc).toBe(4)
  })

  it('vectored mtvec jumps to base + 4 * cause', () => {
    const cpu = new CPU(new RAM(4096))
    enableTimer(cpu)
    cpu.mtvec = HANDLER | 1
    cpu.setInterruptPending(MIP_MTIP, true)
    cpu.step()
    expect(cpu.pc).toBe(HANDLER + 4 * 7)
  })

  it('WFI waits until an interrupt is pending in mie, then continues even with MIE clear', () => {
    const ram = new RAM(4096)
    ram.load(0, toBytes([a.wfi(), a.addi(1, 0, 7), a.ebreak()]))
    const cpu = new CPU(ram, { breakOnEbreak: true })
    cpu.mie = MIP_MTIP
    expect(cpu.run(100)).toBe('wfi')
    expect(cpu.run(100)).toBe('wfi') // still asleep
    cpu.setInterruptPending(MIP_MTIP, true)
    expect(cpu.run(100)).toBe('breakpoint')
    expect(cpu.x[1]).toBe(7)
  })
})

describe('compressed instructions (C extension)', () => {
  // A few compressed encodings (from GNU as; the core's own tests cover all of them).
  const C_LI_A0_5 = 0x4515 // c.li a0, 5
  const C_ADDI_A0_1 = 0x0505 // c.addi a0, 1
  const C_MV_A1_A0 = 0x85aa // c.mv a1, a0
  const C_NOP = 0x0001
  const C_EBREAK = 0x9002

  function runCode(insts: number[]) {
    const ram = new RAM(4096)
    ram.load(0, toCode(insts))
    const cpu = new CPU(ram, { breakOnEbreak: true })
    return { cpu, stop: cpu.run(100) }
  }

  it('mix with 32-bit instructions, which may then sit at 2-byte aligned addresses', () => {
    const { cpu, stop } = runCode([C_LI_A0_5, a.addi(12, 0, 7), C_ADDI_A0_1, C_MV_A1_A0, C_EBREAK])
    expect(stop).toBe('breakpoint')
    expect([cpu.x[10], cpu.x[11], cpu.x[12]]).toEqual([6, 6, 7])
    expect(cpu.pc).toBe(10) // 2 + 4 + 2 + 2 bytes in
    expect(cpu.instret).toBe(4)
  })

  it('jumps may target 2-byte aligned addresses (no misaligned-target exceptions)', () => {
    const { cpu, stop } = runCode([a.addi(1, 0, 10), a.jalr(0, 1, 0), C_NOP, C_EBREAK])
    expect(stop).toBe('breakpoint')
    expect(cpu.pc).toBe(10)
  })

  it('c.jalr links to the next 2-byte instruction', () => {
    const ram = new RAM(4096)
    ram.load(0, toCode([0x9582, C_EBREAK, C_NOP, C_EBREAK])) // c.jalr a1; c.ebreak; c.nop; c.ebreak
    const cpu = new CPU(ram, { breakOnEbreak: true })
    cpu.x[11] = 6
    expect(cpu.run(10)).toBe('breakpoint')
    expect([cpu.pc, cpu.x[1]]).toEqual([6, 2])
  })
})

