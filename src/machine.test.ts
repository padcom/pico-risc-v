import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Clint } from './clint.js'
import { MIP_MSIP, MIP_MTIP } from './csr.js'
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
})
