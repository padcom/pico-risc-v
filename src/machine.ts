import type { BlockStorage } from './block-storage.js'
import { Clint } from './clint.js'
import { CPU } from './cpu.js'
import { encodeFdt, type FdtNode } from './fdt.js'
import { GoldfishRtc } from './goldfish-rtc.js'
import { Plic } from './plic.js'
import type { RAM } from './ram.js'
import { SystemBus } from './system-bus.js'
import { Syscon } from './syscon.js'
import { Terminal } from './terminal.js'
import { VirtioBlock } from './virtio-blk.js'
import { type NetworkBackend, VirtioNet } from './virtio-net.js'

/**
 * Physical memory map. Compatible with mini-rv32ima, so its Linux kernel
 * images boot unmodified (and close to QEMU's `virt` board):
 *
 *   0x0010_1000 - 0x0010_1fff   RTC (Goldfish, host time of day), PLIC source 3
 *   0x0c00_0000 - 0x0fff_ffff   PLIC (external interrupts)
 *   0x1000_0000 - 0x1000_00ff   Terminal (16550-style UART)
 *   0x1000_1000 - 0x1000_1fff   virtio block device (if a disk is attached), PLIC source 1
 *   0x1000_2000 - 0x1000_2fff   virtio network card (if a network is attached), PLIC source 2
 *   0x1100_0000 - 0x1100_ffff   CLINT (timer + software interrupt)
 *   0x1110_0000 - 0x1110_0fff   Syscon (power-off / reboot)
 *   0x8000_0000 - ...           RAM; execution starts at its first byte,
 *                               the device tree sits in its last page(s)
 */
export const MemoryMap = {
  RTC: 0x0010_1000,
  PLIC: 0x0c00_0000,
  TERMINAL: 0x1000_0000,
  VIRTIO_DISK: 0x1000_1000,
  VIRTIO_NET: 0x1000_2000,
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
  /** Disk attached as a virtio block device (/dev/vda in Linux). */
  disk?: BlockStorage
  /** Network the virtio network card (eth0 in Linux) is plugged into. */
  network?: NetworkBackend
  /** The card's MAC address (default 52:54:00:12:34:56). */
  mac?: Uint8Array
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

export interface BootOptions {
  /** Further images to place in RAM, at offsets from its start (e.g. a kernel). */
  load?: { offset: number; data: ArrayLike<number> }[]
  /**
   * For OpenSBI's fw_dynamic firmware: where the next stage (the kernel) is and
   * which mode to enter it in. Passed in a2 as a struct fw_dynamic_info, so the
   * firmware needs no built-in load addresses and leaves the DTB where it is.
   */
  next?: { offset: number; mode?: 'S' | 'M' }
}

/** sizeof(struct fw_dynamic_info) on RV32, rounded up to keep the DTB 8-byte aligned. */
const FW_DYNAMIC_INFO_SIZE = 32

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
  readonly plic: Plic
  readonly rtc = new GoldfishRtc()
  readonly disk: VirtioBlock | undefined
  readonly nic: VirtioNet | undefined
  private readonly network: NetworkBackend | undefined
  readonly cpu: CPU

  private readonly bootargs: string
  private readonly virtual: boolean
  private readonly ipu: number
  private skippedMicros = 0
  private readonly epoch = performance.now()
  private exit: 'poweroff' | 'reboot' | undefined
  private images: { offset: number; data: Uint8Array }[] = []
  private next: BootOptions['next']

  constructor({
    ramSize = 64 * 1024 * 1024,
    output,
    clock = 'realtime',
    instructionsPerMicrosecond = 10,
    bootargs = DEFAULT_BOOTARGS,
    disk,
    network,
    mac = Uint8Array.of(0x52, 0x54, 0x00, 0x12, 0x34, 0x56),
  }: MachineOptions = {}) {
    this.bootargs = bootargs
    this.virtual = clock === 'virtual'
    this.ipu = instructionsPerMicrosecond

    this.terminal = new Terminal(output)
    // RAM lives inside the CPU core (fast); devices reach it through the bus.
    this.cpu = new CPU(this.bus, {
      resetVector: MemoryMap.RAM,
      readTime: () => this.clint.mtime,
      ram: { base: MemoryMap.RAM, size: ramSize },
    })
    this.ram = this.cpu.ram!
    this.clint = new Clint(
      () => this.now(),
      (bit, pending) => this.cpu.setInterruptPending(bit, pending),
    )
    this.syscon = new Syscon(command => {
      this.exit = command
      this.cpu.stop()
    })
    this.plic = new Plic((bit, pending) => this.cpu.setInterruptPending(bit, pending))
    const dma = (addr: number, length: number) => this.guestMemory(addr, length)
    this.disk = disk && new VirtioBlock(disk, dma, high => this.plic.setLevel(DISK_IRQ, high))
    this.network = network
    this.nic = network && new VirtioNet(network, mac, dma, high => this.plic.setLevel(NET_IRQ, high))

    this.bus
      .map(MemoryMap.RAM, ramSize, this.ram)
      .map(MemoryMap.RTC, GoldfishRtc.SIZE, this.rtc)
      .map(MemoryMap.PLIC, Plic.SIZE, this.plic)
      .map(MemoryMap.TERMINAL, Terminal.SIZE, this.terminal)
      .map(MemoryMap.CLINT, Clint.SIZE, this.clint)
      .map(MemoryMap.SYSCON, Syscon.SIZE, this.syscon)
    if (this.disk) this.bus.map(MemoryMap.VIRTIO_DISK, VirtioBlock.SIZE, this.disk)
    if (this.nic) this.bus.map(MemoryMap.VIRTIO_NET, VirtioNet.SIZE, this.nic)
  }

  /** DMA for devices: a view of guest RAM at a physical address. */
  private guestMemory(addr: number, length: number): Uint8Array {
    const offset = addr - MemoryMap.RAM
    if (offset < 0 || offset + length > this.ram.size) {
      throw new RangeError(`DMA outside RAM: 0x${addr.toString(16)}+${length}`)
    }
    return this.ram.bytes.subarray(offset, offset + length)
  }

  /**
   * Power on with a flat binary image at the start of RAM: a Linux `Image`, a
   * bare-metal program (`objcopy -O binary` output), or firmware such as
   * OpenSBI's fw_dynamic.bin. Like a boot ROM, this places a device tree at the
   * top of RAM and enters the image in M-mode with a0 = hart id, a1 = DTB.
   */
  boot(image: ArrayLike<number>, { load = [], next }: BootOptions = {}): void {
    this.images = [{ offset: 0, data: image }, ...load].map(({ offset, data }) => ({
      offset,
      data: Uint8Array.from(data),
    }))
    this.next = next
    this.reboot()
  }

  /** Reset everything and start the last booted image(s) again. */
  reboot(): void {
    if (!this.images.length) throw new Error('Nothing to reboot: call boot() first')
    const dtb = this.deviceTree()
    const dtbOffset = this.dtbOffset(dtb.length)
    // OpenSBI's fw_dynamic_info, if any, goes right below the device tree.
    const infoOffset = dtbOffset - FW_DYNAMIC_INFO_SIZE
    const freeEnd = this.next ? infoOffset : dtbOffset
    for (const { offset, data } of this.images) {
      if (offset + data.length > freeEnd) {
        throw new Error(`Image at offset 0x${offset.toString(16)} (${data.length} bytes) does not fit in RAM below the device tree`)
      }
    }

    this.ram.bytes.fill(0)
    for (const { offset, data } of this.images) this.ram.load(offset, data)
    this.ram.load(dtbOffset, dtb)

    this.exit = undefined
    this.skippedMicros = 0
    this.cpu.reset(MemoryMap.RAM)
    this.clint.reset()
    this.plic.reset()
    this.disk?.reset()
    this.nic?.reset()
    this.cpu.x[10] = 0 // a0: hart id
    this.cpu.x[11] = MemoryMap.RAM + dtbOffset // a1: device tree
    if (this.next) {
      // struct fw_dynamic_info (OpenSBI include/sbi/fw_dynamic.h), passed in a2
      const info = [
        0x4942534f, // magic "OSBI"
        2, // version
        MemoryMap.RAM + this.next.offset, // next_addr
        { S: 1, M: 3 }[this.next.mode ?? 'S'], // next_mode
        0, // options
        0, // boot_hart
      ]
      info.forEach((word, i) => this.ram.write32(infoOffset + i * 4, word))
      this.cpu.x[12] = MemoryMap.RAM + infoOffset
    }
  }

  /**
   * Execute up to `maxSteps` steps; see RunResult for why it stopped. A step
   * is an instruction or a trap entry (which retires nothing), and every round
   * uses up at least one, so neither a guest stuck in a trap loop nor one
   * idling in WFI (with the virtual clock skipping ahead) keeps us here forever.
   */
  run(maxSteps = Infinity): RunResult {
    let remaining = maxSteps
    while (remaining > 0) {
      this.clint.update()
      const slice = Math.min(SLICE, remaining)
      const before = this.cpu.instret
      const result = this.cpu.run(slice)
      remaining -= result === 'limit' ? slice : Math.max(1, this.cpu.instret - before)
      switch (result) {
        case 'stopped':
          if (this.exit) return this.exit
          break
        case 'breakpoint':
          return 'breakpoint'
        case 'wfi':
          if (!this.wake()) return 'idle'
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

  /**
   * The CPU sleeps in WFI: see whether it can be woken without waiting in the
   * real world. The timer line is only re-evaluated between slices, so a
   * deadline may have passed since; with the virtual clock, idle time up to the
   * next deadline is skipped (unless the network is busy). Returns false if the
   * CPU stays asleep.
   */
  private wake(): boolean {
    this.clint.update()
    if (this.cpu.mip & this.cpu.mie) return true
    // While the guest waits on the real world (network), virtual time must not
    // race ahead: its timeouts would expire before the host answers.
    if (!this.virtual || this.network?.busy) return false
    const wait = this.microsUntilTimer()
    if (wait === Infinity) return false
    this.skippedMicros += wait
    this.clint.update()
    return (this.cpu.mip & this.cpu.mie) !== 0
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
    const PLIC_PHANDLE = 4
    return {
      props: {
        '#address-cells': 2,
        '#size-cells': 2,
        compatible: 'riscv-minimal-nommu',
        model: 'risc-emulator (RV32IMA)',
      },
      children: {
        chosen: {
          // stdout-path tells firmware (OpenSBI) where its console is
          props: { bootargs: this.bootargs, 'stdout-path': `/soc/uart@${hex(MemoryMap.TERMINAL)}` },
        },
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
                'mmu-type': 'riscv,sv32',
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
                // Linux picks the first (as mini-rv32ima's kernel expects);
                // OpenSBI's console driver knows the second.
                compatible: ['ns16850', 'ns16550a'],
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
            [`plic@${hex(MemoryMap.PLIC)}`]: {
              props: {
                phandle: PLIC_PHANDLE,
                compatible: ['sifive,plic-1.0.0', 'riscv,plic0'],
                reg: reg(MemoryMap.PLIC, Plic.SIZE),
                'interrupt-controller': true,
                '#interrupt-cells': 1,
                '#address-cells': 0,
                'riscv,ndev': Plic.SOURCES - 1,
                // context 0: machine external (11), context 1: supervisor external (9) of hart 0
                'interrupts-extended': [INTC_PHANDLE, 11, INTC_PHANDLE, 9],
              },
            },
            [`rtc@${hex(MemoryMap.RTC)}`]: {
              props: {
                compatible: 'google,goldfish-rtc',
                reg: reg(MemoryMap.RTC, GoldfishRtc.SIZE),
                // The alarm never fires, but Linux's driver wants an interrupt.
                'interrupt-parent': PLIC_PHANDLE,
                interrupts: RTC_IRQ,
              },
            },
            ...(this.nic && {
              [`virtio_mmio@${hex(MemoryMap.VIRTIO_NET)}`]: {
                props: {
                  compatible: 'virtio,mmio',
                  reg: reg(MemoryMap.VIRTIO_NET, VirtioNet.SIZE),
                  'interrupt-parent': PLIC_PHANDLE,
                  interrupts: NET_IRQ,
                },
              },
            }),
            ...(this.disk && {
              [`virtio_mmio@${hex(MemoryMap.VIRTIO_DISK)}`]: {
                props: {
                  compatible: 'virtio,mmio',
                  reg: reg(MemoryMap.VIRTIO_DISK, VirtioBlock.SIZE),
                  'interrupt-parent': PLIC_PHANDLE,
                  interrupts: DISK_IRQ,
                },
              },
            }),
          },
        },
      },
    }
  }
}

const hex = (n: number) => n.toString(16)

/** PLIC interrupt sources of the devices. */
const DISK_IRQ = 1
const NET_IRQ = 2
const RTC_IRQ = 3
