import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { asm as a, toBytes } from './asm.js'
import { Clint } from './clint.js'
import { Csr, MIP_MSIP, MIP_MTIP } from './csr.js'
import { Machine, MemoryMap } from './machine.js'
import { Syscon } from './syscon.js'
import { Terminal } from './terminal.js'

function boot(program: string) {
  let screen = ''
  const machine = new Machine({ clock: 'virtual', output: byte => (screen += String.fromCharCode(byte)) })
  machine.boot(readFileSync(new URL(`../examples/build/${program}.bin`, import.meta.url)))
  const result = machine.run(1_000_000)
  return { machine, result, screen: () => screen }
}

describe('Terminal device', () => {
  it('transmits bytes written to THR', () => {
    const out: number[] = []
    const t = new Terminal(b => out.push(b))
    t.write8(Terminal.THR, 0x41)
    t.write8(3, 0x42) // other registers ignore writes
    expect(out).toEqual([0x41])
  })

  it('reports readiness and delivers typed input via LSR/RBR', () => {
    const t = new Terminal()
    expect(t.read8(Terminal.LSR) & Terminal.LSR_THRE).toBeTruthy()
    expect(t.read8(Terminal.LSR) & Terminal.LSR_DR).toBe(0)
    t.type('hi')
    expect(t.read8(Terminal.LSR) & Terminal.LSR_DR).toBeTruthy()
    expect(t.read8(Terminal.RBR)).toBe(0x68)
    expect(t.read8(Terminal.RBR)).toBe(0x69)
    expect(t.read8(Terminal.LSR) & Terminal.LSR_DR).toBe(0)
  })

  it('is reachable through the system bus at its mapped address', () => {
    let out = ''
    const m = new Machine({ output: b => (out += String.fromCharCode(b)) })
    m.bus.write8(MemoryMap.TERMINAL + Terminal.THR, 0x21)
    expect(out).toBe('!')
  })
})

describe('CLINT', () => {
  function clint() {
    let now = 0
    let mip = 0
    const c = new Clint(
      () => now,
      (bit, on) => (mip = on ? mip | bit : mip & ~bit),
    )
    c.reset()
    return { c, tick: (us: number) => (now += us), mip: () => mip }
  }

  it('counts time in mtime', () => {
    const { c, tick } = clint()
    tick(0x1_2345_6789)
    expect(c.read32(Clint.MTIME)).toBe(0x2345_6789)
    expect(c.read32(Clint.MTIME + 4)).toBe(1)
  })

  it('raises MTIP once mtime reaches mtimecmp, clears it when mtimecmp moves on', () => {
    const { c, tick, mip } = clint()
    c.write32(Clint.MTIMECMP + 4, 0)
    c.write32(Clint.MTIMECMP, 100)
    tick(99)
    c.update()
    expect(mip() & MIP_MTIP).toBe(0)
    tick(1)
    c.update()
    expect(mip() & MIP_MTIP).not.toBe(0)
    c.write32(Clint.MTIMECMP, 200)
    expect(mip() & MIP_MTIP).toBe(0)
  })

  it('never fires after reset (mtimecmp = 2^64 - 1)', () => {
    const { c, tick, mip } = clint()
    expect(c.read32(Clint.MTIMECMP + 4)).toBe(0xffff_ffff)
    tick(1e12)
    c.update()
    expect(mip() & MIP_MTIP).toBe(0)
  })

  it('msip drives the software interrupt', () => {
    const { c, mip } = clint()
    c.write32(Clint.MSIP, 1)
    expect(mip() & MIP_MSIP).not.toBe(0)
    c.write32(Clint.MSIP, 0)
    expect(mip() & MIP_MSIP).toBe(0)
  })
})

describe('Machine.run with the virtual clock', () => {
  const MTIMECMP = MemoryMap.CLINT + Clint.MTIMECMP
  // t0..t3 = x5..x7, x28
  const setDeadline = (lo: number) => [a.lui(5, MTIMECMP), a.sw(0, 5, 4), a.addi(6, 0, lo), a.sw(6, 5, 0)]
  const powerOff = [a.lui(5, MemoryMap.SYSCON), a.lui(6, 0x5000), a.addi(6, 6, 0x555), a.sw(6, 5, 0), a.jal(0, 0)]

  function machine(main: number[], handler: number[] = []) {
    const m = new Machine({ ramSize: 1024 * 1024, clock: 'virtual' })
    const image = new Uint8Array(0x200)
    image.set(toBytes(main))
    image.set(toBytes(handler), 0x100)
    m.boot(image)
    return m
  }

  it('returns even when the guest only ever idles in WFI between timer ticks', () => {
    const m = machine(
      [
        a.lui(5, MemoryMap.RAM), a.addi(5, 5, 0x100), a.csrrw(0, Csr.mtvec, 5),
        ...setDeadline(1000),
        a.addi(7, 0, MIP_MTIP), a.csrrw(0, Csr.mie, 7), a.csrrsi(0, Csr.mstatus, 8),
        a.wfi(), a.jal(0, -4), // idle loop
      ],
      [a.lui(5, MTIMECMP), a.lw(6, 5, 0), a.addi(6, 6, 1000), a.sw(6, 5, 0), a.mret()], // re-arm, return
    )
    expect(m.run(100_000)).toBe('limit')
    // Each tick costs a handful of steps, so the budget covers some 14 000
    // ticks (14 s). Without the budget counting partial slices, run() would
    // keep skipping ahead (until mtimecmp's low word wrapped after 4295 s).
    expect(m.clint.mtime).toBeGreaterThan(10_000_000)
    expect(m.clint.mtime).toBeLessThan(60_000_000)
  })

  it('a deadline that passes mid-slice wakes a CPU that then executes WFI', () => {
    const m = machine([
      ...setDeadline(50), // 50 µs = 500 instructions at the default 10 per µs
      a.addi(7, 0, MIP_MTIP), a.csrrw(0, Csr.mie, 7), // enabled in mie, but MIE off: WFI just resumes
      a.addi(28, 0, 2000), a.addi(28, 28, -1), a.bne(28, 0, -4), // ~4000 instructions
      a.wfi(),
      ...powerOff,
    ])
    expect(m.run(1_000_000)).toBe('poweroff')
  })

  it('the RTC starts at startTime and advances with virtual time', () => {
    const start = Date.UTC(2030, 0, 1)
    const m = new Machine({ ramSize: 1024 * 1024, clock: 'virtual', startTime: start })
    m.boot(toBytes([a.jal(0, 0)])) // spin
    const timeOfDay = () => {
      const low = m.bus.read32(MemoryMap.RTC) // latches the high half
      return Number((BigInt(m.bus.read32(MemoryMap.RTC + 4)) << 32n) | BigInt(low)) / 1e6 // ms
    }
    expect(timeOfDay()).toBe(start)
    m.run(10_000_000) // 1 s at 10 instructions per µs
    expect(timeOfDay()).toBe(start + 1000)
  })
})

describe('Syscon', () => {
  it('reports power-off and reboot commands', () => {
    const seen: string[] = []
    const s = new Syscon(cmd => seen.push(cmd))
    s.write32(0, 0x1234)
    s.write32(0, Syscon.POWEROFF)
    s.write32(0, Syscon.REBOOT)
    expect(seen).toEqual(['poweroff', 'reboot'])
  })
})

describe('Device tree', () => {
  it('passes the OS a random seed in /chosen/rng-seed: fresh on every power-on, unless fixed', () => {
    const seedOf = (m: Machine) => {
      const dtb = m.deviceTree()
      const text = new TextDecoder('latin1').decode(dtb)
      expect(text).toContain('rng-seed')
      return dtb
    }
    const m = new Machine({ ramSize: 1024 * 1024 })
    m.boot([0x73, 0, 0, 0])
    const first = seedOf(m)
    m.reboot()
    expect(seedOf(m)).not.toEqual(first)

    const fixed = new Uint8Array(64).fill(0xa5)
    const reproducible = new Machine({ ramSize: 1024 * 1024, rngSeed: fixed })
    const dtb = seedOf(reproducible)
    expect(Buffer.from(dtb).includes(Buffer.from(fixed))).toBe(true)
  })

  it('is a valid FDT that describes the RAM below itself', () => {
    const m = new Machine({ ramSize: 8 * 1024 * 1024, bootargs: 'console=ttyS0 quiet' })
    const dtb = m.deviceTree()
    const view = new DataView(dtb.buffer)
    expect(view.getUint32(0)).toBe(0xd00dfeed)
    expect(view.getUint32(4)).toBe(dtb.length) // totalsize
    expect(view.getUint32(20)).toBe(17) // version
    const text = new TextDecoder('latin1').decode(dtb)
    for (const s of ['console=ttyS0 quiet', 'rv32ima', 'ns16850', 'sifive,clint0', 'syscon-poweroff']) {
      expect(text).toContain(s)
    }
  })

  it('is passed to the program in a1, with the hart id in a0', () => {
    const m = new Machine({ ramSize: 1024 * 1024 })
    m.boot([0x73, 0x00, 0x10, 0x00]) // ebreak
    expect(m.cpu.x[10]).toBe(0)
    const dtbAddr = m.cpu.x[11]! >>> 0
    expect(m.bus.read32(dtbAddr)).toBe(0xedfe0dd0) // FDT magic, read little-endian
  })
})

describe('C programs compiled with GNU toolchain', () => {
  it('hello.c prints its greeting, returns 0 from main and powers off', () => {
    const { machine, result, screen } = boot('hello')
    expect(screen()).toBe('Hello, world! from RISC-V emulator\n')
    expect(result).toBe('poweroff')
    expect(machine.cpu.x[10]).toBe(0) // a0 = main's return value
  })

  const MATMUL_OUTPUT = [
    'A =',
    '1 2 3',
    '4 5 6',
    '7 8 9',
    'B =',
    '9 -8 7',
    '-6 5 -4',
    '3 -2 1',
    'A x B =',
    '6 -4 2',
    '24 -19 14',
    '42 -34 26',
    '',
  ].join('\n')

  it('matmul.c multiplies two 3x3 matrices (signed, via libgcc __mulsi3)', () => {
    const { machine, result, screen } = boot('matmul')
    expect(screen()).toBe(MATMUL_OUTPUT)
    expect(result).toBe('poweroff')
    expect(machine.cpu.x[10]).toBe(0)
  })

  it('matmul.c built for RV32IM gives the same result with hardware MUL/DIV, in fewer instructions', () => {
    const soft = boot('matmul').machine.cpu.instret
    const { machine, result, screen } = boot('matmul-m')
    expect(screen()).toBe(MATMUL_OUTPUT)
    expect(result).toBe('poweroff')
    expect(machine.cpu.instret).toBeLessThan(soft / 2)
  })

  // The benchmark (examples/bench) prints a checksum: 'checksum 991869f2' is
  // also what the same C code prints compiled for the host.
  const runBench = (program: string, xlen: 32 | 64 = 32) => {
    let screen = ''
    const machine = new Machine({ xlen, clock: 'virtual', output: b => (screen += String.fromCharCode(b)) })
    machine.boot(readFileSync(new URL(`../examples/build/${program}.bin`, import.meta.url)))
    return { result: machine.run(500_000_000), screen }
  }

  it('the benchmark built with compressed instructions computes the same as when built without', () => {
    const plain = runBench('bench')
    const compressed = runBench('bench-c')
    expect(compressed.result).toBe('poweroff')
    expect(compressed.screen).toBe('checksum 991869f2\n')
    expect(compressed.screen).toBe(plain.screen)
  })

  it('the benchmark built for RV64 computes the same on an RV64 machine', () => {
    const rv64 = runBench('bench64', 64)
    expect(rv64.result).toBe('poweroff')
    expect(rv64.screen).toBe('checksum 991869f2\n')
  })
})
