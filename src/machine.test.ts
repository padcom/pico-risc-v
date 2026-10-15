import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { asm as a, toBytes, Clint, Csr, MIP_MSIP, MIP_MTIP, Syscon, Terminal } from '@padcom/pico-risc-v-hart'
import { Machine, MemoryMap } from './machine.js'

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
    t.write8(7, 0x42) // other registers ignore writes
    expect(out).toEqual([0x41])
  })

  it('takes the baud-rate divisor at offsets 0 and 1 while LCR.DLAB is set, without transmitting it', () => {
    const out: number[] = []
    const t = new Terminal(b => out.push(b))
    t.write8(Terminal.LCR, 0x03 | Terminal.LCR_DLAB) // 8N1, divisor latch on (as Linux sets a speed)
    t.write8(Terminal.DLL, 0x6d)
    t.write8(Terminal.DLM, 0x00)
    expect(t.read8(Terminal.DLL)).toBe(0x6d)
    expect(t.read8(Terminal.LCR)).toBe(0x83)
    t.write8(Terminal.LCR, 0x03)
    t.write8(Terminal.THR, 0x41)
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

  it('raises its interrupt for received data while enabled, until it is read', () => {
    const line: boolean[] = []
    const t = new Terminal(() => {}, high => line.push(high))
    t.type('a')
    expect(line.at(-1)).toBe(false) // not enabled
    expect(t.read8(Terminal.IIR)).toBe(Terminal.IIR_NO_INT)
    t.write8(Terminal.IER, Terminal.IER_RDI)
    expect(line.at(-1)).toBe(true)
    expect(t.read8(Terminal.IIR)).toBe(Terminal.IIR_RDI)
    expect(t.read8(Terminal.RBR)).toBe(0x61)
    expect(line.at(-1)).toBe(false)
    expect(t.read8(Terminal.IIR)).toBe(Terminal.IIR_NO_INT)
  })

  it('raises its transmitter interrupt when enabled and after each character, until IIR reports it', () => {
    const line: boolean[] = []
    const out: number[] = []
    const t = new Terminal(b => out.push(b), high => line.push(high))
    t.write8(Terminal.FCR, Terminal.FCR_ENABLE_FIFO)
    t.write8(Terminal.IER, Terminal.IER_THRI)
    expect(line.at(-1)).toBe(true)
    expect(t.read8(Terminal.IIR)).toBe(Terminal.IIR_THRI | Terminal.IIR_FIFOS)
    expect(line.at(-1)).toBe(false)
    expect(t.read8(Terminal.IIR)).toBe(Terminal.IIR_NO_INT | Terminal.IIR_FIFOS)
    t.write8(Terminal.THR, 0x41)
    expect(line.at(-1)).toBe(true)
    t.write8(Terminal.IER, 0) // as Linux does when it has nothing more to send
    expect(line.at(-1)).toBe(false)
    expect(out).toEqual([0x41])
  })

  it('has its interrupt off after a reset', () => {
    const line: boolean[] = []
    const t = new Terminal(() => {}, high => line.push(high))
    t.write8(Terminal.IER, Terminal.IER_THRI)
    t.reset()
    expect(line.at(-1)).toBe(false)
    expect(t.read8(Terminal.IER)).toBe(0)
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

  it('has an msip and an mtimecmp per hart', () => {
    let now = 0
    const mip = [0, 0, 0, 0]
    const c = new Clint(
      () => now,
      (bit, on, hart) => (mip[hart] = on ? mip[hart]! | bit : mip[hart]! & ~bit),
      4,
    )
    c.reset()
    c.write32(Clint.MSIP + 4 * 2, 1)
    expect(mip.map(m => m & MIP_MSIP)).toEqual([0, 0, MIP_MSIP, 0])
    expect(c.read32(Clint.MSIP + 4 * 2)).toBe(1)
    c.write32(Clint.MTIMECMP + 8 * 3 + 4, 0)
    c.write32(Clint.MTIMECMP + 8 * 3, 50)
    expect(c.timecmp(3)).toBe(50)
    now = 50
    c.update()
    expect(mip.map(m => m & MIP_MTIP)).toEqual([0, 0, 0, MIP_MTIP])
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
        a.auipc(5, 0), a.addi(5, 5, 0x100), a.csrrw(0, Csr.mtvec, 5), // the handler: RAM + 0x100 (this is at RAM + 0)
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

describe.each([
  ['interpreter', false],
  ['JIT', { threshold: 1, batch: 1 }],
] as const)('decoded-instruction cache (%s)', (_, jit) => {
  // A function at RAM + 0x40 returning a constant (addi a0, zero, n; ret),
  // called, patched by the program itself (a plain store, no FENCE.I) and
  // called again: the second call must run the new instruction.
  const RETURN = (n: number) => a.addi(10, 0, n)
  const program = [
    a.auipc(5, 0), // 0x00: t0 = RAM
    a.jal(1, 0x3c), // 0x04: call 0x40
    a.addi(9, 10, 0), // 0x08: s1 = the first call's result
    a.lw(6, 5, 0x80), // 0x0c: t1 = the new instruction
    a.sw(6, 5, 0x40), // 0x10: patch the function
    a.jal(1, 0x2c), // 0x14: call 0x40 again
    a.lui(5, MemoryMap.SYSCON), a.lui(6, 0x5000), a.addi(6, 6, 0x555), a.sw(6, 5, 0), // 0x18: power off
  ]
  const boot = () => {
    const m = new Machine({ ramSize: 1024 * 1024, clock: 'virtual', jit })
    const image = new Uint8Array(0x84)
    image.set(toBytes(program))
    image.set(toBytes([RETURN(1), a.jalr(0, 1, 0)]), 0x40)
    image.set(toBytes([RETURN(2)]), 0x80)
    m.boot(image)
    return m
  }

  it('sees code the program modifies, without FENCE.I', () => {
    const m = boot()
    expect(m.run(10_000)).toBe('poweroff')
    expect([m.cpu.x[9], m.cpu.x[10]]).toEqual([1, 2])
  })

  it('sees code a device writes (DMA), once told through codeWritten', () => {
    const m = boot()
    m.run(10_000) // decodes (and caches) the function, as patched: returns 2
    m.ram.write32(0x40, RETURN(3)) // as a device would write it...
    m.cpu.codeWritten(MemoryMap.RAM + 0x40, 4) // ...through Machine's DMA, which says so
    m.cpu.write('pc', MemoryMap.RAM)
    expect(m.run(10_000)).toBe('poweroff')
    expect([m.cpu.x[9], m.cpu.x[10]]).toEqual([3, 2])
  })
})

describe.each([
  ['interpreter', false],
  ['JIT', { threshold: 1, batch: 1 }],
] as const)('loads and stores across a page boundary (%s)', (_, jit) => {
  // t1 = RAM + 0x3000 - 8: 0(t1) on one page, 8(t1) on the next (one memory
  // group for the JIT, its range on both), 100 times; s1 sums what it reads.
  const start = [
    a.auipc(5, 0), a.lui(6, 0x3000), a.add(6, 6, 5), a.addi(6, 6, -8), // t1
    a.addi(9, 0, 0), a.addi(12, 0, 100), a.addi(13, 0, 1), // s1 = 0, a2 = 100, a3 = 1
  ]
  const powerOff = [a.lui(5, MemoryMap.SYSCON), a.lui(6, 0x5000), a.addi(6, 6, 0x555), a.sw(6, 5, 0)]
  const run = (program: number[], at0x3040: number[] = []) => {
    const m = new Machine({ ramSize: 1024 * 1024, clock: 'virtual', jit })
    const image = new Uint8Array(0x3040 + 4 * at0x3040.length)
    image.set(toBytes(program))
    image.set(toBytes(at0x3040), 0x3040)
    m.boot(image)
    expect(m.run(100_000)).toBe('poweroff')
    return m.cpu.x[9]
  }

  it('reads what it wrote on both pages', () => {
    const loop = [
      a.sd(13, 6, 0), a.addi(14, 13, 1000), a.sd(14, 6, 8), // 0(t1) = a3, 8(t1) = a3 + 1000
      a.ld(15, 6, 0), a.ld(16, 6, 8), a.add(9, 9, 15), a.add(9, 9, 16),
      a.addi(13, 13, 1), a.addi(12, 12, -1),
    ]
    const program = [...start, ...loop, a.bne(12, 0, -4 * loop.length), ...powerOff]
    expect(run(program)).toBe(5050 + 5050 + 100 * 1000)
  })

  it('sees code it writes on the second page: a function there, rewritten each time before it is called', () => {
    // The same group also writes 0x48(t1): the function's first two
    // instructions (at RAM + 0x3040), addi a0, zero, a3; ret. (Its 8(t1),
    // data on the function's page, puts that page in the JIT's TLB.)
    const RET = 0x8067 // jalr zero, 0(ra)
    const loop = [
      a.sd(13, 6, 0), a.sd(13, 6, 8), a.slli(14, 13, 20), a.ori(14, 14, 0x513), a.or(14, 14, 7), a.sd(14, 6, 0x48),
      a.jal(1, 0), // (the call: its offset below)
      a.add(9, 9, 10), a.ld(15, 6, 0), a.add(9, 9, 15), // s1 += what it returned, + 0(t1)
      a.addi(13, 13, 1), a.addi(12, 12, -1),
    ]
    const program = [...start, a.lui(7, RET & ~0xfff), a.addi(7, 7, RET & 0xfff), a.slli(7, 7, 32), ...loop]
    const call = program.length - loop.length + 6
    program[call] = a.jal(1, 0x3040 - 4 * call)
    program.push(a.bne(12, 0, -4 * loop.length), ...powerOff)
    expect(run(program, [a.addi(10, 0, 0), a.jalr(0, 1, 0)])).toBe(5050 + 5050)
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
    for (const s of ['console=ttyS0 quiet', 'rv64imafdc', 'ns16550a', 'sifive,clint0', 'syscon-poweroff']) {
      expect(text).toContain(s)
    }
  })

  it('places an initrd below itself, and says where in /chosen', () => {
    const m = new Machine({ ramSize: 4 * 1024 * 1024 })
    const initrd = Uint8Array.from({ length: 10000 }, (_, i) => i % 253)
    m.boot([0x73, 0x00, 0x10, 0x00], { initrd }) // ebreak
    const dtb = m.ram.bytes.subarray((m.cpu.x[11]! >>> 0) - MemoryMap.RAM)
    const chosen = fdtProperties(dtb, 'chosen')
    const start = chosen.get('linux,initrd-start')!.getUint32(0)
    const end = chosen.get('linux,initrd-end')!.getUint32(0)
    expect(end - start).toBe(initrd.length)
    expect(start % 4096).toBe(0)
    expect(end).toBeLessThanOrEqual(m.cpu.x[11]! >>> 0)
    expect(m.ram.bytes.subarray(start - MemoryMap.RAM, end - MemoryMap.RAM)).toEqual(initrd)
  })

  it('describes the screen, a framebuffer at the top of RAM, above the RAM the OS gets and itself', () => {
    const m = new Machine({ ramSize: 8 * 1024 * 1024, display: { width: 640, height: 480 } })
    m.boot([0x73, 0x00, 0x10, 0x00]) // ebreak
    const fbAddr = MemoryMap.RAM + 8 * 1024 * 1024 - 640 * 480 * 4
    const dtbAddr = m.cpu.x[11]! >>> 0
    const dtb = m.ram.bytes.subarray(dtbAddr - MemoryMap.RAM)
    const fb = fdtProperties(dtb, `framebuffer@${fbAddr.toString(16)}`)
    const cell = (name: string, i = 0) => fb.get(name)!.getUint32(i * 4)
    const text = (name: string) => new TextDecoder().decode(fb.get(name)!).replace(/\0$/, '')
    expect(text('compatible')).toBe('simple-framebuffer')
    expect([0, 1, 2, 3].map(i => cell('reg', i))).toEqual([0, fbAddr, 0, 640 * 480 * 4])
    expect([cell('width'), cell('height'), cell('stride'), text('format')]).toEqual([640, 480, 640 * 4, 'x8r8g8b8'])
    const memory = fdtProperties(dtb, `memory@${MemoryMap.RAM.toString(16)}`).get('reg')!
    expect(MemoryMap.RAM + memory.getUint32(12)).toBeLessThanOrEqual(fbAddr)
    expect(dtbAddr + new DataView(dtb.buffer, dtb.byteOffset).getUint32(4)).toBeLessThanOrEqual(fbAddr)

    // What the guest writes there is on the screen.
    m.bus.write32(fbAddr + 4, 0x00ff8040)
    const pixels = new Uint8Array(640 * 480 * 4)
    m.screen!.draw(pixels)
    expect([...pixels.subarray(4, 8)]).toEqual([0xff, 0x80, 0x40, 0xff])
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
  it.each([
    ['interpreter', false],
    ['JIT', { threshold: 1, batch: 1 }],
  ] as const)('smp.c: 4 harts update shared counters atomically (AMOADD, LR/SC, a spinlock) (%s)', (_, jit) => {
    let screen = ''
    const machine = new Machine({ clock: 'virtual', harts: 4, jit, output: byte => (screen += String.fromCharCode(byte)) })
    machine.boot(readFileSync(new URL('../examples/build/smp.bin', import.meta.url)))
    expect(machine.run(100_000_000)).toBe('poweroff')
    expect(screen).toBe('harts 4\namoadd 80000\nlr/sc 80000\nlocked 80000\n')
  })

  it('smp.c: the same on 4 threads (runThreaded), every time', { timeout: 60_000 }, async () => {
    // The harts really run at the same time now, differently each time.
    for (let i = 0; i < 5; i++) {
      let screen = ''
      const machine = new Machine({ harts: 4, output: byte => (screen += String.fromCharCode(byte)) })
      machine.boot(readFileSync(new URL('../examples/build/smp.bin', import.meta.url)))
      expect(await machine.runThreaded()).toBe('poweroff')
      expect(screen).toBe('harts 4\namoadd 80000\nlr/sc 80000\nlocked 80000\n')
    }
  })

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

  it('matmul.c multiplies two 3x3 matrices (signed, via libgcc __muldi3)', () => {
    const { machine, result, screen } = boot('matmul')
    expect(screen()).toBe(MATMUL_OUTPUT)
    expect(result).toBe('poweroff')
    expect(machine.cpu.x[10]).toBe(0)
  })

  it('matmul.c built for RV64IM gives the same result with hardware MUL/DIV, in fewer instructions', () => {
    const soft = boot('matmul').machine.cpu.instret
    const { machine, result, screen } = boot('matmul-m')
    expect(screen()).toBe(MATMUL_OUTPUT)
    expect(result).toBe('poweroff')
    expect(machine.cpu.instret).toBeLessThan(soft / 2)
  })

  // The benchmark (examples/bench) prints a checksum: 'checksum 991869f2' is
  // also what the same C code prints compiled for the host.
  const runBench = (program: string) => {
    let screen = ''
    const machine = new Machine({ clock: 'virtual', output: b => (screen += String.fromCharCode(b)) })
    machine.boot(readFileSync(new URL(`../examples/build/${program}.bin`, import.meta.url)))
    return { result: machine.run(500_000_000), screen }
  }

  it('the benchmark computes what it does on the host, built with compressed instructions or without', () => {
    const plain = runBench('bench')
    const compressed = runBench('bench-c')
    expect(plain.result).toBe('poweroff')
    expect(compressed.result).toBe('poweroff')
    expect(compressed.screen).toBe('checksum 991869f2\n')
    expect(compressed.screen).toBe(plain.screen)
  })

  it('floating point gives the same bits as the same C code on the host', () => {
    // examples/fbench prints the exact bits of its results; this is what the
    // same program prints compiled natively (Apple Silicon, no FMA contraction).
    const expected = ['mandelbrot 40ef46b9389c4324', 'nbody 3fe6787f5c2f0c63', 'singles 42e9fd5a', '8ebc280f4d0ed7a4', ''].join('\n')
    const { result, screen } = runBench('fbench')
    expect(result).toBe('poweroff')
    expect(screen).toBe(expected)
  })
})

/** The properties of a top-level node of a flattened device tree (big-endian values). */
function fdtProperties(dtb: Uint8Array, node: string): Map<string, DataView> {
  const view = new DataView(dtb.buffer, dtb.byteOffset)
  const structs = view.getUint32(8)
  const strings = view.getUint32(12)
  const text = (at: number) => new TextDecoder().decode(dtb.subarray(at, dtb.indexOf(0, at)))
  const props = new Map<string, DataView>()
  let depth = 0
  let inside = false
  for (let at = structs; ; ) {
    const token = view.getUint32(at)
    at += 4
    if (token === 1) {
      // BEGIN_NODE: a name, NUL-terminated, padded to 4 bytes
      const name = text(at)
      at += (name.length + 4) & ~3
      depth++
      inside = depth === 2 && name === node
    } else if (token === 2) {
      depth--
      inside = false
    } else if (token === 3) {
      const length = view.getUint32(at)
      const name = text(strings + view.getUint32(at + 4))
      if (inside) props.set(name, new DataView(dtb.buffer, dtb.byteOffset + at + 8, length))
      at += 8 + ((length + 3) & ~3)
    } else if (token === 9) {
      return props
    }
  }
}
