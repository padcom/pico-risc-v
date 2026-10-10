import { Clint } from './clint.js'
import { CPU } from './cpu.js'
import { encodeFdt, type FdtNode } from './fdt.js'
import { RAM } from './ram.js'
import { SystemBus } from './system-bus.js'
import { Syscon } from './syscon.js'
import { Terminal } from './terminal.js'

/**
 * Physical memory map. Compatible with mini-rv32ima, so its Linux kernel
 * images boot unmodified (and close to QEMU's `virt` board):
 *
 *   0x1000_0000 - 0x1000_00ff   Terminal (16550-style UART)
 *   0x1100_0000 - 0x1100_ffff   CLINT (timer + software interrupt)
 *   0x1110_0000 - 0x1110_0fff   Syscon (power-off / reboot)
 *   0x8000_0000 - ...           RAM; execution starts at its first byte,
 *                               the device tree sits in its last page(s)
 */
export const MemoryMap = {
  TERMINAL: 0x1000_0000,
  CLINT: 0x1100_0000,
  SYSCON: 0x1110_0000,
  RAM: 0x8000_0000,
} as const

/** mtime ticks per second, advertised to the OS as timebase-frequency. */
export const TIMEBASE_HZ = 1_000_000

export const DEFAULT_BOOTARGS = 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0'

export interface MachineOptions {
  /** RAM size in bytes (default 64 MiB). */
  ramSize?: number
  /** Called with every byte the program writes to the terminal. */
  output?: (byte: number) => void
  /**
   * Where mtime comes from:
   *  - 'realtime': wall-clock microseconds (interactive use)
   *  - 'virtual':  derived from the instruction count, and fast-forwarded
   *                while the CPU idles in WFI — fully deterministic (tests)
   */
  clock?: 'realtime' | 'virtual'
  /** Virtual clock speed: instructions per microsecond (default 10, i.e. a 10 MIPS machine). */
  instructionsPerMicrosecond?: number
  /** Kernel command line placed in the device tree's /chosen node. */
  bootargs?: string
}

/**
 * Why `run()` returned:
 *  - poweroff / reboot: the program asked the syscon to do so
 *  - breakpoint:        EBREAK with `cpu.breakOnEbreak` set
 *  - idle:              CPU sleeps in WFI and time must pass in the real world
 *                       (realtime clock), or nothing will ever wake it
 *  - limit:             the step budget ran out
 */
export type RunResult = 'poweroff' | 'reboot' | 'breakpoint' | 'idle' | 'limit'

/** How many instructions to run between timer updates. */
const SLICE = 10_000

/** A complete computer: CPU + RAM + terminal + timer + syscon on one bus. */
export class Machine {
  readonly bus = new SystemBus()
  readonly ram: RAM
  readonly terminal: Terminal
  readonly clint: Clint
  readonly syscon: Syscon
  readonly cpu: CPU

  private readonly bootargs: string
  private readonly virtual: boolean
  private readonly ipu: number
  private skippedMicros = 0
  private readonly epoch = performance.now()
  private exit: 'poweroff' | 'reboot' | undefined
  private image: Uint8Array | undefined

  constructor({
    ramSize = 64 * 1024 * 1024,
    output,
    clock = 'realtime',
    instructionsPerMicrosecond = 10,
    bootargs = DEFAULT_BOOTARGS,
  }: MachineOptions = {}) {
    this.bootargs = bootargs
    this.virtual = clock === 'virtual'
    this.ipu = instructionsPerMicrosecond

    this.ram = new RAM(ramSize)
    this.terminal = new Terminal(output)
    this.cpu = new CPU(this.bus, { resetVector: MemoryMap.RAM, readTime: () => this.clint.mtime })
    this.clint = new Clint(
      () => this.now(),
      (bit, pending) => this.cpu.setInterruptPending(bit, pending),
    )
    this.syscon = new Syscon(command => {
      this.exit = command
      this.cpu.stop()
    })

    this.bus
      .map(MemoryMap.RAM, ramSize, this.ram)
      .map(MemoryMap.TERMINAL, Terminal.SIZE, this.terminal)
      .map(MemoryMap.CLINT, Clint.SIZE, this.clint)
      .map(MemoryMap.SYSCON, Syscon.SIZE, this.syscon)
  }

  /**
   * Power on with a flat binary image (a Linux `Image`, or `objcopy -O binary`
   * output) at the start of RAM. Like a boot ROM, this places a device tree at
   * the top of RAM and enters the image with a0 = hart id, a1 = DTB address.
   */
  boot(image: ArrayLike<number>): void {
    this.image = Uint8Array.from(image)
    this.reboot()
  }

  /** Reset everything and start the last booted image again. */
  reboot(): void {
    if (!this.image) throw new Error('Nothing to reboot: call boot() first')
    const dtb = this.deviceTree()
    const dtbOffset = this.dtbOffset(dtb.length)
    if (this.image.length > dtbOffset) {
      throw new Error(`Image (${this.image.length} bytes) does not fit in RAM below the device tree`)
    }

    this.ram.bytes.fill(0)
    this.ram.load(0, this.image)
    this.ram.load(dtbOffset, dtb)

    this.exit = undefined
    this.skippedMicros = 0
    this.cpu.reset(MemoryMap.RAM)
    this.clint.reset()
    this.cpu.x[10] = 0 // a0: hart id
    this.cpu.x[11] = MemoryMap.RAM + dtbOffset // a1: device tree
  }

  /** Execute up to `maxInstructions` instructions; see RunResult for why it stopped. */
  run(maxInstructions = Infinity): RunResult {
    const end = this.cpu.instret + maxInstructions
    while (this.cpu.instret < end) {
      this.clint.update()
      switch (this.cpu.run(Math.min(SLICE, end - this.cpu.instret))) {
        case 'stopped':
          if (this.exit) return this.exit
          break
        case 'breakpoint':
          return 'breakpoint'
        case 'wfi':
          if (!this.virtual || !this.fastForwardToTimer()) return 'idle'
          break
      }
    }
    return 'limit'
  }

  /** Microseconds until the timer interrupt fires (Infinity if never armed). */
  microsUntilTimer(): number {
    const delta = this.clint.mtimecmp - this.clint.mtime
    return delta >= 2 ** 53 ? Infinity : Math.max(0, delta)
  }

  /** The device tree describing this machine to the OS. */
  deviceTree(): Uint8Array {
    // The memory node excludes the DTB itself; its size doesn't depend on the
    // value, so encode once to learn the size, then again with the real one.
    const build = (memSize: number) => encodeFdt(this.describe(memSize))
    return build(this.dtbOffset(build(0).length))
  }

  private now(): number {
    if (this.virtual) return Math.floor(this.cpu.instret / this.ipu) + this.skippedMicros
    return Math.floor((performance.now() - this.epoch) * 1000)
  }

  /** Virtual clock: skip idle time up to the next timer deadline. */
  private fastForwardToTimer(): boolean {
    const wait = this.microsUntilTimer()
    if (wait === Infinity) return false
    this.skippedMicros += wait
    this.clint.update()
    return true
  }

  /** The DTB goes into the last page-aligned chunk of RAM that fits it. */
  private dtbOffset(dtbSize: number): number {
    return (this.ram.size - dtbSize) & ~0xfff
  }

  private describe(memSize: number): FdtNode {
    const reg = (addr: number, size: number) => [0, addr, 0, size] // 2 address + 2 size cells
    const CPU_PHANDLE = 1
    const INTC_PHANDLE = 2
    const SYSCON_PHANDLE = 3
    return {
      props: {
        '#address-cells': 2,
        '#size-cells': 2,
        compatible: 'riscv-minimal-nommu',
        model: 'risc-emulator (TypeScript RV32IMA)',
      },
      children: {
        chosen: { props: { bootargs: this.bootargs } },
        [`memory@${hex(MemoryMap.RAM)}`]: {
          props: { device_type: 'memory', reg: reg(MemoryMap.RAM, memSize) },
        },
        cpus: {
          props: { '#address-cells': 1, '#size-cells': 0, 'timebase-frequency': TIMEBASE_HZ },
          children: {
            'cpu@0': {
              props: {
                phandle: CPU_PHANDLE,
                device_type: 'cpu',
                reg: 0,
                status: 'okay',
                compatible: 'riscv',
                // Old-style ISA string, plus the newer binding that kernels
                // built without CONFIG_RISCV_ISA_FALLBACK (6.x) insist on.
                'riscv,isa': 'rv32ima',
                'riscv,isa-base': 'rv32i',
                'riscv,isa-extensions': ['i', 'm', 'a', 'zicsr', 'zifencei', 'zicntr'],
                'mmu-type': 'riscv,none',
              },
              children: {
                'interrupt-controller': {
                  props: {
                    '#interrupt-cells': 1,
                    'interrupt-controller': true,
                    compatible: 'riscv,cpu-intc',
                    phandle: INTC_PHANDLE,
                  },
                },
              },
            },
            'cpu-map': { children: { cluster0: { children: { core0: { props: { cpu: CPU_PHANDLE } } } } } },
          },
        },
        soc: {
          props: { '#address-cells': 2, '#size-cells': 2, compatible: 'simple-bus', ranges: true },
          children: {
            [`uart@${hex(MemoryMap.TERMINAL)}`]: {
              props: {
                'clock-frequency': 0x1000000,
                reg: reg(MemoryMap.TERMINAL, Terminal.SIZE),
                compatible: 'ns16850',
              },
            },
            poweroff: {
              props: { value: Syscon.POWEROFF, offset: 0, regmap: SYSCON_PHANDLE, compatible: 'syscon-poweroff' },
            },
            reboot: {
              props: { value: Syscon.REBOOT, offset: 0, regmap: SYSCON_PHANDLE, compatible: 'syscon-reboot' },
            },
            [`syscon@${hex(MemoryMap.SYSCON)}`]: {
              props: { phandle: SYSCON_PHANDLE, reg: reg(MemoryMap.SYSCON, Syscon.SIZE), compatible: 'syscon' },
            },
            [`clint@${hex(MemoryMap.CLINT)}`]: {
              props: {
                // machine software (3) and machine timer (7) interrupts of hart 0
                'interrupts-extended': [INTC_PHANDLE, 3, INTC_PHANDLE, 7],
                reg: reg(MemoryMap.CLINT, Clint.SIZE),
                compatible: ['sifive,clint0', 'riscv,clint0'],
              },
            },
          },
        },
      },
    }
  }
}

const hex = (n: number) => n.toString(16)
