import type { BlockStorage } from './block-storage.js'
import { BusError } from './bus.js'
import { Clint } from './clint.js'
import { CPU, type CPUOptions } from './cpu.js'
import { encodeFdt, type FdtNode } from './fdt.js'
import { Framebuffer } from './framebuffer.js'
import { GoldfishRtc } from './goldfish-rtc.js'
import type { HartThreadData } from './hart-worker.js'
import { Plic } from './plic.js'
import type { RAM } from './ram.js'
import { SystemBus } from './system-bus.js'
import { Syscon } from './syscon.js'
import { Terminal } from './terminal.js'
import { VirtioBlock } from './virtio-blk.js'
import { VirtioConsole } from './virtio-console.js'
import { VirtioInput } from './virtio-input.js'
import { type NetworkBackend, VirtioNet } from './virtio-net.js'

/**
 * Physical memory map (close to QEMU's `virt` board):
 *
 *   0x0010_1000 - 0x0010_1fff   RTC (Goldfish, host time of day), PLIC source 3
 *   0x0c00_0000 - 0x0fff_ffff   PLIC (external interrupts)
 *   0x1000_0000 - 0x1000_00ff   Terminal (16550-style UART)
 *   0x1000_1000 - 0x1000_1fff   virtio block device (if a disk is attached), PLIC source 1
 *   0x1000_2000 - 0x1000_2fff   virtio network card (if a network is attached), PLIC source 2
 *   0x1000_3000 - 0x1000_3fff   virtio console (unless turned off), PLIC source 5
 *   0x1000_4000 - 0x1000_4fff   virtio keyboard (with a screen), PLIC source 6
 *   0x1000_5000 - 0x1000_5fff   virtio tablet (with a screen), PLIC source 7
 *   0x1100_0000 - 0x1100_ffff   CLINT (timer + software interrupt)
 *   0x1110_0000 - 0x1110_0fff   Syscon (power-off / reboot)
 *   0x8000_0000 - ...           RAM; execution starts at its first byte,
 *                               the device tree sits in its last page(s),
 *                               or below the screen's framebuffer, if any,
 *                               which takes the very last ones
 */
export const MemoryMap = {
  RTC: 0x0010_1000,
  PLIC: 0x0c00_0000,
  TERMINAL: 0x1000_0000,
  VIRTIO_DISK: 0x1000_1000,
  VIRTIO_NET: 0x1000_2000,
  VIRTIO_CONSOLE: 0x1000_3000,
  VIRTIO_KEYBOARD: 0x1000_4000,
  VIRTIO_TABLET: 0x1000_5000,
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
  /** Called with every byte the program writes to the terminal (the serial port or the console). */
  output?: (byte: number) => void
  /**
   * A virtio console (default true): a second terminal (hvc0 in Linux),
   * which, unlike the serial port, can tell the guest its size (resize()).
   */
  console?: boolean
  /**
   * Where mtime comes from:
   *  - 'realtime': wall-clock microseconds (interactive use)
   *  - 'virtual':  derived from the instruction count, and fast-forwarded
   *                while the CPU idles in WFI — fully deterministic (tests)
   */
  clock?: 'realtime' | 'virtual'
  /** Virtual clock speed: instructions per microsecond (default 10, i.e. a 10 MIPS machine). */
  instructionsPerMicrosecond?: number
  /**
   * With the virtual clock, the time of day (RTC) at power-on, in ms since
   * 1970; it then advances with virtual time. Defaults to the host's time at
   * power-on; a fixed value makes runs exactly reproducible. (With the
   * realtime clock, the RTC is the host's time.)
   */
  startTime?: number
  /**
   * Random bytes for the OS to seed its random number generator with, passed
   * like real boot firmware does (device tree /chosen/rng-seed). Without them
   * Linux can take minutes to have randomness ready (the emulated CPU's
   * perfectly regular timing yields none), and until then programs that need
   * it, such as TLS in curl, block. Defaults to 64 fresh random bytes on every
   * power-on; fix it (with startTime) to make runs exactly reproducible.
   */
  rngSeed?: Uint8Array
  /** Kernel command line placed in the device tree's /chosen node. */
  bootargs?: string
  /** The CPU's JIT (see CPUOptions); on by default. */
  jit?: CPUOptions['jit']
  /**
   * How many harts (CPU cores) the machine has (default 1). They take turns,
   * `SLICE` steps each.
   */
  harts?: number
  /**
   * A screen, `width` × `height` pixels: a framebuffer at the top of RAM
   * (not part of the RAM the OS is told about), see Framebuffer. With
   * it come a keyboard and a mouse (a tablet), see VirtioInput.
   */
  display?: { width: number; height: number }
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
  /**
   * An initramfs for Linux: placed at the top of the free RAM (below the
   * device tree and fw_dynamic_info), and passed in the device tree's
   * /chosen (linux,initrd-start / -end).
   */
  initrd?: ArrayLike<number>
}

/** Room left after the DTB for firmware to add to it. */
const FDT_ROOM = 4096

/** sizeof(struct fw_dynamic_info): six `unsigned long`s (rounded up to keep the DTB 8-byte aligned). */
const FW_DYNAMIC_INFO_SIZE = 48

/**
 * Why `run()` returned:
 *  - poweroff / reboot: the program asked the syscon to do so
 *  - breakpoint:        EBREAK with `cpu.breakOnEbreak` set
 *  - idle:              CPU sleeps in WFI and time must pass in the real world
 *                       (realtime clock), or nothing will ever wake it
 *  - limit:             the step budget ran out
 */
export type RunResult = 'poweroff' | 'reboot' | 'breakpoint' | 'idle' | 'limit'

/** How many instructions to run between timer updates (and each hart's turn). */
const SLICE = 10_000

/**
 * runThreaded()'s threads (hart-worker.ts), and how they talk to this one:
 * an Int32Array on shared memory, `Control`. Word 0 is the doorbell, which a
 * thread bumps (and notifies) when it wants something; then come BOX words
 * per hart: a mailbox for a device access (STATE: 1 when the thread has
 * filled in OP, ADDR, WIDTH, VALUE; 2 when this thread has answered in
 * RESULT and FAULT), WAKE, which this thread bumps (and notifies) to wake
 * the hart from WFI, and EVENT, set when run() stopped otherwise (a
 * breakpoint: run()'s code).
 */
const WORKER = new URL(import.meta.url.endsWith('.ts') ? './hart-worker.ts' : './hart-worker.js', import.meta.url)
// Threads are worker_threads Workers in Node, Web Workers in browsers.
const threads = typeof process !== 'undefined' && process.versions?.node !== undefined ? await import('node:worker_threads') : undefined
/**
 * Without Atomics.waitAsync (some browsers), the threads also post a message
 * when they ring the doorbell, which wakes this thread instead.
 */
const waitAsync = typeof Atomics.waitAsync === 'function'
const DOORBELL = 0
const BOX = 16
const STATE = 0
const OP = 1
const ADDR = 2
const WIDTH = 3
const VALUE = 4
const RESULT = 5
const FAULT = 6
const WAKE = 7
const EVENT = 8
/** run()'s code for a breakpoint (cpu.ts: STOP_REASONS). */
const BREAKPOINT = 2
/** How long runThreaded() waits for the harts at most before looking again (ms). */
const MAX_WAIT = 10

/** A complete computer: CPUs + RAM + terminal + timer + syscon on one bus. */
export class Machine {
  readonly bus = new SystemBus()
  readonly ram: RAM
  readonly terminal: Terminal
  readonly clint: Clint
  readonly syscon: Syscon
  readonly plic: Plic
  readonly rtc = new GoldfishRtc(() => this.timeOfDay())
  readonly disk: VirtioBlock | undefined
  readonly console: VirtioConsole | undefined
  readonly nic: VirtioNet | undefined
  /** The screen, if the machine has one (MachineOptions.display). */
  readonly screen: Framebuffer | undefined
  /** The screen's keyboard and mouse (an absolute one: a tablet), if it has one. */
  readonly keyboard: VirtioInput | undefined
  readonly tablet: VirtioInput | undefined
  private readonly network: NetworkBackend | undefined
  /** The harts, by mhartid. */
  readonly cpus: CPU[]
  /** Hart 0. */
  readonly cpu: CPU

  private readonly bootargs: string
  private readonly virtual: boolean
  private readonly ipu: number
  private skippedMicros = 0
  /**
   * The virtual clock's instruction count: how far the harts got, together
   * (each round adds the most any hart retired; with one hart, its count).
   * The hart running now adds its progress in this round; what the clock
   * returned last keeps it from going back for the next hart.
   */
  private ticks = 0
  private lastTicks = 0
  private running: CPU | undefined
  private runningFrom = 0
  /** While runThreaded() runs: Control, and the clock the threads share (hart-worker.ts). */
  private threads: { control: Int32Array; clock: Float64Array } | undefined
  private readonly startTime: number | undefined
  private readonly fixedRngSeed: Uint8Array | undefined
  /** This power-on's rng-seed. */
  private rngSeed: Uint8Array
  /** Time of day at power-on (ms since 1970), for the virtual clock. */
  private powerOnTime = 0
  /** The realtime clock's start (ms, absolute: the same in every thread). */
  private readonly epoch = performance.timeOrigin + performance.now()
  private exit: 'poweroff' | 'reboot' | undefined
  private images: { offset: number; data: Uint8Array }[] = []
  private next: BootOptions['next']
  private initrd: Uint8Array | undefined
  /** Where the initrd goes in RAM (offset), worked out with the device tree. */
  private initrdAt = 0

  constructor({
    ramSize = 64 * 1024 * 1024,
    output,
    clock = 'realtime',
    instructionsPerMicrosecond = 10,
    startTime,
    rngSeed,
    bootargs = DEFAULT_BOOTARGS,
    disk,
    network,
    mac = Uint8Array.of(0x52, 0x54, 0x00, 0x12, 0x34, 0x56),
    jit,
    harts = 1,
    console = true,
    display,
  }: MachineOptions = {}) {
    this.bootargs = bootargs
    this.virtual = clock === 'virtual'
    this.ipu = instructionsPerMicrosecond
    this.startTime = startTime
    this.fixedRngSeed = rngSeed
    this.rngSeed = this.newRngSeed()

    this.terminal = new Terminal(output, high => this.plic.setLevel(TERMINAL_IRQ, high))
    // RAM lives inside the CPU core (fast); devices reach it through the bus.
    this.cpus = CPU.harts(this.bus, harts, {
      resetVector: MemoryMap.RAM,
      readTime: () => this.clint.mtime,
      ram: { base: MemoryMap.RAM, size: ramSize },
      jit,
    })
    this.cpu = this.cpus[0]!
    this.ram = this.cpu.ram!
    if (display) {
      const size = Framebuffer.size(display.width, display.height)
      if (size > ramSize / 2) throw new RangeError(`The screen (${size} bytes) takes too much of the RAM`)
      this.screen = new Framebuffer(display.width, display.height, this.ram.bytes.subarray(ramSize - size))
    }
    const raise = (bit: number, pending: boolean, hart: number) => {
      const cpu = this.cpus[hart]!
      const before = this.threads && cpu.mip
      cpu.setInterruptPending(bit, pending)
      if (pending && this.threads && cpu.mip !== before) {
        // Wake it, in case it waits in WFI.
        Atomics.add(this.threads.control, BOX * (hart + 1) + WAKE, 1)
        Atomics.notify(this.threads.control, BOX * (hart + 1) + WAKE)
      }
    }
    this.clint = new Clint(() => this.now(), raise, harts)
    this.syscon = new Syscon(command => {
      this.exit = command
      for (const cpu of this.cpus) cpu.stop()
    })
    this.plic = new Plic(raise, harts)
    const dma = (addr: number, length: number) => this.guestMemory(addr, length)
    this.disk = disk && new VirtioBlock(disk, dma, high => this.plic.setLevel(DISK_IRQ, high))
    this.network = network
    this.nic = network && new VirtioNet(network, mac, dma, high => this.plic.setLevel(NET_IRQ, high))
    this.console = console ? new VirtioConsole(dma, high => this.plic.setLevel(CONSOLE_IRQ, high), output ?? (() => {})) : undefined
    this.keyboard = display && VirtioInput.keyboard(dma, high => this.plic.setLevel(KEYBOARD_IRQ, high))
    this.tablet = display && VirtioInput.tablet(dma, high => this.plic.setLevel(TABLET_IRQ, high))

    this.bus
      .map(MemoryMap.RAM, ramSize, this.ram)
      .map(MemoryMap.RTC, GoldfishRtc.SIZE, this.rtc)
      .map(MemoryMap.PLIC, Plic.SIZE, this.plic)
      .map(MemoryMap.TERMINAL, Terminal.SIZE, this.terminal)
      .map(MemoryMap.CLINT, Clint.SIZE, this.clint)
      .map(MemoryMap.SYSCON, Syscon.SIZE, this.syscon)
    if (this.disk) this.bus.map(MemoryMap.VIRTIO_DISK, VirtioBlock.SIZE, this.disk)
    if (this.nic) this.bus.map(MemoryMap.VIRTIO_NET, VirtioNet.SIZE, this.nic)
    if (this.console) this.bus.map(MemoryMap.VIRTIO_CONSOLE, VirtioConsole.SIZE, this.console)
    if (this.keyboard) this.bus.map(MemoryMap.VIRTIO_KEYBOARD, VirtioInput.SIZE, this.keyboard)
    if (this.tablet) this.bus.map(MemoryMap.VIRTIO_TABLET, VirtioInput.SIZE, this.tablet)
  }

  /**
   * Keyboard input: to the console once the guest uses it (a login is
   * there), before that to the serial port (firmware, bootloaders).
   */
  type(data: string | ArrayLike<number>): void {
    if (this.console?.inUse) this.console.type(data)
    else this.terminal.type(data)
  }

  /** The terminal is `cols` × `rows` characters (now): the console tells the guest. */
  resize(cols: number, rows: number): void {
    this.console?.resize(cols, rows)
  }

  /**
   * DMA for devices: a view of guest RAM at a physical address. The device may
   * write through it, so the CPU forgets any instructions it decoded from
   * there (they'd be stale).
   */
  private guestMemory(addr: number, length: number): Uint8Array {
    const offset = addr - MemoryMap.RAM
    if (offset < 0 || offset + length > this.ram.size) {
      throw new RangeError(`DMA outside RAM: 0x${addr.toString(16)}+${length}`)
    }
    this.cpu.codeWritten(addr, length)
    return this.ram.bytes.subarray(offset, offset + length)
  }

  /**
   * Power on with a flat binary image at the start of RAM: a Linux `Image`, a
   * bare-metal program (`objcopy -O binary` output), or firmware such as
   * OpenSBI's fw_dynamic.bin. Like a boot ROM, this places a device tree at the
   * top of RAM and enters the image in M-mode with a0 = hart id, a1 = DTB.
   */
  boot(image: ArrayLike<number>, { load = [], next, initrd }: BootOptions = {}): void {
    this.images = [{ offset: 0, data: image }, ...load].map(({ offset, data }) => ({
      offset,
      data: Uint8Array.from(data),
    }))
    this.next = next
    this.initrd = initrd && Uint8Array.from(initrd)
    this.reboot()
  }

  /** Reset everything and start the last booted image(s) again. */
  reboot(): void {
    if (!this.images.length) throw new Error('Nothing to reboot: call boot() first')
    this.rngSeed = this.newRngSeed()
    const dtb = this.deviceTree()
    const dtbOffset = this.dtbOffset(dtb.length)
    // OpenSBI's fw_dynamic_info, if any, goes right below the device tree,
    // the initrd, if any, below that (deviceTree() worked out where).
    const infoOffset = dtbOffset - FW_DYNAMIC_INFO_SIZE
    const freeEnd = this.initrd ? this.initrdAt : this.next ? infoOffset : dtbOffset
    for (const { offset, data } of this.images) {
      if (offset + data.length > freeEnd) {
        throw new Error(`Image at offset 0x${offset.toString(16)} (${data.length} bytes) does not fit in RAM below the device tree`)
      }
    }

    this.ram.bytes.fill(0)
    for (const { offset, data } of this.images) this.ram.load(offset, data)
    if (this.initrd) this.ram.load(this.initrdAt, this.initrd)
    this.ram.load(dtbOffset, dtb)

    this.exit = undefined
    this.skippedMicros = 0
    this.ticks = this.lastTicks = 0
    this.powerOnTime = this.startTime ?? Date.now()
    for (const cpu of this.cpus) cpu.reset(MemoryMap.RAM)
    this.clint.reset()
    this.terminal.reset()
    this.plic.reset()
    this.disk?.reset()
    this.nic?.reset()
    this.console?.reset()
    this.keyboard?.reset()
    this.tablet?.reset()
    // All harts start at the start of RAM (firmware picks one to boot).
    for (const cpu of this.cpus) {
      cpu.setRegister(10, cpu.id) // a0: hart id
      cpu.setRegister(11, MemoryMap.RAM + dtbOffset) // a1: device tree
    }
    if (this.next) {
      // struct fw_dynamic_info (OpenSBI include/sbi/fw_dynamic.h), passed in
      // a2: `unsigned long` fields, 64 bits each (little-endian, < 2^32 here).
      const info = [
        0x4942534f, // magic "OSBI"
        2, // version
        MemoryMap.RAM + this.next.offset, // next_addr
        { S: 1, M: 3 }[this.next.mode ?? 'S'], // next_mode
        0, // options
        0, // boot_hart
      ]
      info.forEach((value, i) => this.ram.write32(infoOffset + i * 8, value))
      for (const cpu of this.cpus) cpu.setRegister(12, MemoryMap.RAM + infoOffset)
    }
  }

  /**
   * Execute up to `maxSteps` steps (of each hart; they take turns); see
   * RunResult for why it stopped. A step is an instruction or a trap entry
   * (which retires nothing), and every round uses up at least one, so neither
   * a guest stuck in a trap loop nor one idling in WFI (with the virtual clock
   * skipping ahead) keeps us here forever.
   */
  run(maxSteps = Infinity): RunResult {
    let remaining = maxSteps
    while (remaining > 0) {
      this.clint.update()
      const slice = Math.min(SLICE, remaining)
      // Steps used and instructions retired in this round: the most any hart did.
      let used = 0
      let retired = 0
      let waiting = 0
      for (const cpu of this.cpus) {
        this.running = cpu
        this.runningFrom = cpu.instret
        const result = cpu.run(slice)
        this.running = undefined
        const done = cpu.instret - this.runningFrom
        retired = Math.max(retired, done)
        used = Math.max(used, result === 'limit' ? slice : done)
        if (result === 'wfi') {
          waiting++
        } else if ((result === 'stopped' && this.exit) || result === 'breakpoint') {
          this.ticks += retired
          return this.exit ?? 'breakpoint'
        }
      }
      this.ticks += retired
      remaining -= Math.max(1, used)
      if (waiting === this.cpus.length && !this.wake()) return 'idle'
    }
    return 'limit'
  }

  /**
   * Run the harts in parallel, each on a thread of its own (with the
   * realtime clock), until the program powers off or reboots, or a hart hits
   * a breakpoint. The devices stay on this thread, which serves the harts'
   * accesses to them and keeps the timers up to date, in between its other
   * work (I/O): the returned promise settles when the harts have stopped.
   */
  async runThreaded(): Promise<RunResult> {
    if (this.virtual) throw new Error('runThreaded() needs the realtime clock')
    const control = new Int32Array(new SharedArrayBuffer(4 * BOX * (this.cpus.length + 1)))
    const clock = new Float64Array(new SharedArrayBuffer(16))
    clock[0] = this.epoch
    clock[1] = this.clint.mtime - this.now()
    this.threads = { control, clock }
    let failure: unknown
    // Without waitAsync: woken by the threads' messages (or the timer).
    let wakeUp = () => {}
    const ring = () => {
      Atomics.add(control, DOORBELL, 1)
      Atomics.notify(control, DOORBELL)
      wakeUp()
    }
    // The threads handle the CLINT themselves (its state is shared), and their
    // harts' timers: not this thread.
    const harts = this.cpus.map(cpu => cpu.thread())
    const clint = { base: MemoryMap.CLINT, state: this.clint.state.buffer as SharedArrayBuffer, harts: harts.map(hart => hart.hart) }
    const workers = harts.map((hart, index) =>
      startThread(
        { ...hart, index, control: control.buffer, clock: clock.buffer, ring: !waitAsync, clint },
        () => wakeUp(),
        error => {
          failure ??= error
          ring()
        },
      ),
    )
    try {
      for (;;) {
        // (Read first: a request coming in while serving rings it again.)
        const doorbell = Atomics.load(control, DOORBELL)
        if (failure) throw failure
        const result = this.serveHarts()
        if (result) return result
        const wait = MAX_WAIT
        if (waitAsync) {
          const { async, value } = Atomics.waitAsync(control, DOORBELL, doorbell, wait)
          if (async) await value
        } else if (Atomics.load(control, DOORBELL) === doorbell) {
          // Until a thread's message, or the timeout.
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, wait)
            wakeUp = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wakeUp = () => {}
        }
      }
    } finally {
      this.threads = undefined
      await Promise.all(workers.map(worker => worker.terminate()))
    }
  }

  /** Answer the threads' device accesses; returns why to stop, if it's time to. */
  private serveHarts(): RunResult | undefined {
    const { control, clock } = this.threads!
    for (let hart = 0; hart < this.cpus.length; hart++) {
      const box = BOX * (hart + 1)
      if (control[box + EVENT] === BREAKPOINT) return 'breakpoint'
      if (Atomics.load(control, box + STATE) !== 1) continue
      const addr = control[box + ADDR]! >>> 0
      const width = control[box + WIDTH]!
      try {
        if (control[box + OP] === 0) {
          control[box + RESULT] = width === 4 ? this.bus.read32(addr) : width === 2 ? this.bus.read16(addr) : this.bus.read8(addr)
        } else {
          const value = control[box + VALUE]!
          if (width === 4) this.bus.write32(addr, value >>> 0)
          else if (width === 2) this.bus.write16(addr, value & 0xffff)
          else this.bus.write8(addr, value & 0xff)
        }
        control[box + FAULT] = 0
      } catch (e) {
        if (!(e instanceof BusError)) throw e
        control[box + FAULT] = 1
      }
      Atomics.store(control, box + STATE, 2)
      Atomics.notify(control, box + STATE)
      if (this.exit) return this.exit
    }
    return undefined
  }

  /** Microseconds until the next timer interrupt fires (Infinity if none is armed). */
  microsUntilTimer(): number {
    const mtime = this.clint.mtime
    const delta = Math.min(...this.cpus.map(cpu => this.clint.timecmp(cpu.id) - mtime))
    return delta >= 2 ** 53 ? Infinity : Math.max(0, delta)
  }

  /** The device tree describing this machine to the OS. */
  deviceTree(): Uint8Array {
    // The memory node excludes the DTB itself; its size doesn't depend on the
    // value, so encode once to learn the size, then again with the real one.
    // (The same goes for where the initrd is, which depends on where it goes.)
    const build = (memSize: number) => encodeFdt(this.describe(memSize))
    const dtbOffset = this.dtbOffset(build(0).length)
    if (this.initrd) {
      const below = this.next ? dtbOffset - FW_DYNAMIC_INFO_SIZE : dtbOffset
      this.initrdAt = (below - this.initrd.length) & ~0xfff
      if (this.initrdAt < 0) throw new Error(`The initrd (${this.initrd.length} bytes) does not fit in RAM`)
    }
    return build(dtbOffset)
  }

  private now(): number {
    if (this.virtual) {
      const ticks = this.ticks + (this.running ? this.running.instret - this.runningFrom : 0)
      this.lastTicks = Math.max(this.lastTicks, ticks)
      return Math.floor(this.lastTicks / this.ipu) + this.skippedMicros
    }
    return Math.floor((performance.timeOrigin + performance.now() - this.epoch) * 1000)
  }

  private newRngSeed(): Uint8Array {
    return this.fixedRngSeed ?? crypto.getRandomValues(new Uint8Array(64))
  }

  /** What the RTC reports: ms since 1970. */
  private timeOfDay(): number {
    return this.virtual ? this.powerOnTime + this.now() / 1000 : Date.now()
  }

  /**
   * The CPUs sleep in WFI: see whether one can be woken without waiting in
   * the real world. The timer lines are only re-evaluated between rounds, so
   * a deadline may have passed since; with the virtual clock, idle time up to
   * the next deadline is skipped (unless the network is busy). Returns false
   * if they all stay asleep.
   */
  private wake(): boolean {
    const interrupted = () => this.cpus.some(cpu => (cpu.mip & cpu.mie) !== 0)
    this.clint.update()
    if (interrupted()) return true
    // While the guest waits on the real world (network, a disk that reads
    // asynchronously), virtual time must not race ahead: its timeouts would
    // expire before the host answers.
    if (!this.virtual || this.network?.busy || this.disk?.busy) return false
    const wait = this.microsUntilTimer()
    if (wait === Infinity) return false
    this.skippedMicros += wait
    this.clint.update()
    return interrupted()
  }

  /**
   * The DTB goes into the last page-aligned chunk of RAM (below the
   * framebuffer) that fits it, with FDT_ROOM to spare after it: firmware
   * (OpenSBI) grows it in place.
   */
  private dtbOffset(dtbSize: number): number {
    return (this.ram.size - (this.screen?.size ?? 0) - dtbSize - FDT_ROOM) & ~0xfff
  }

  private describe(memSize: number): FdtNode {
    const reg = (addr: number, size: number) => [0, addr, 0, size] // 2 address + 2 size cells
    // Hart 0's are 1 and 2, the others' from 5 on.
    const cpuPhandle = (hart: number) => (hart ? 3 + 2 * hart : 1)
    const intcPhandle = (hart: number) => cpuPhandle(hart) + 1
    const SYSCON_PHANDLE = 3
    const PLIC_PHANDLE = 4
    // An interrupt of each hart's local interrupt controller per hart.
    const ofEachHart = (...causes: number[]) => this.cpus.flatMap(({ id }) => causes.flatMap(cause => [intcPhandle(id), cause]))
    return {
      props: {
        '#address-cells': 2,
        '#size-cells': 2,
        compatible: 'risc-emulator',
        model: 'risc-emulator (RV64GC)',
      },
      children: {
        chosen: {
          // stdout-path tells firmware (OpenSBI) where its console is
          props: {
            bootargs: this.bootargs,
            'stdout-path': `/soc/uart@${hex(MemoryMap.TERMINAL)}`,
            'rng-seed': this.rngSeed,
            ...(this.initrd && {
              'linux,initrd-start': MemoryMap.RAM + this.initrdAt,
              'linux,initrd-end': MemoryMap.RAM + this.initrdAt + this.initrd.length,
            }),
          },
        },
        [`memory@${hex(MemoryMap.RAM)}`]: {
          props: { device_type: 'memory', reg: reg(MemoryMap.RAM, memSize) },
        },
        ...(this.screen && {
          // Above the memory the OS gets: the screen's, set up as by firmware.
          [`framebuffer@${hex(MemoryMap.RAM + this.ram.size - this.screen.size)}`]: {
            props: {
              compatible: 'simple-framebuffer',
              reg: reg(MemoryMap.RAM + this.ram.size - this.screen.size, this.screen.size),
              width: this.screen.width,
              height: this.screen.height,
              stride: this.screen.stride,
              format: Framebuffer.FORMAT,
              status: 'okay',
            },
          },
        }),
        cpus: {
          props: { '#address-cells': 1, '#size-cells': 0, 'timebase-frequency': TIMEBASE_HZ },
          children: {
            ...Object.fromEntries(this.cpus.map(({ id }) => [`cpu@${id}`, {
              props: {
                phandle: cpuPhandle(id),
                device_type: 'cpu',
                reg: id,
                status: 'okay',
                compatible: 'riscv',
                // Old-style ISA string, plus the newer binding that kernels
                // built without CONFIG_RISCV_ISA_FALLBACK (6.x) insist on.
                'riscv,isa': 'rv64imafdc',
                'riscv,isa-base': 'rv64i',
                'riscv,isa-extensions': ['i', 'm', 'a', 'f', 'd', 'c', 'zicsr', 'zifencei', 'zicntr'],
                'mmu-type': 'riscv,sv39',
              },
              children: {
                'interrupt-controller': {
                  props: {
                    '#interrupt-cells': 1,
                    'interrupt-controller': true,
                    compatible: 'riscv,cpu-intc',
                    phandle: intcPhandle(id),
                  },
                },
              },
            }])),
            'cpu-map': {
              children: {
                cluster0: {
                  children: Object.fromEntries(this.cpus.map(({ id }) => [`core${id}`, { props: { cpu: cpuPhandle(id) } }])),
                },
              },
            },
          },
        },
        soc: {
          props: { '#address-cells': 2, '#size-cells': 2, compatible: 'simple-bus', ranges: true },
          children: {
            [`uart@${hex(MemoryMap.TERMINAL)}`]: {
              props: {
                'clock-frequency': 0x1000000,
                reg: reg(MemoryMap.TERMINAL, Terminal.SIZE),
                'interrupt-parent': PLIC_PHANDLE,
                interrupts: TERMINAL_IRQ,
                compatible: 'ns16550a',
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
                // machine software (3) and machine timer (7) interrupts of each hart
                'interrupts-extended': ofEachHart(3, 7),
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
                // contexts 2·hart: machine external (11), 2·hart + 1: supervisor external (9)
                'interrupts-extended': ofEachHart(11, 9),
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
            ...(this.console && {
              [`virtio_mmio@${hex(MemoryMap.VIRTIO_CONSOLE)}`]: {
                props: {
                  compatible: 'virtio,mmio',
                  reg: reg(MemoryMap.VIRTIO_CONSOLE, VirtioConsole.SIZE),
                  'interrupt-parent': PLIC_PHANDLE,
                  interrupts: CONSOLE_IRQ,
                },
              },
            }),
            ...(this.keyboard && {
              [`virtio_mmio@${hex(MemoryMap.VIRTIO_KEYBOARD)}`]: {
                props: {
                  compatible: 'virtio,mmio',
                  reg: reg(MemoryMap.VIRTIO_KEYBOARD, VirtioInput.SIZE),
                  'interrupt-parent': PLIC_PHANDLE,
                  interrupts: KEYBOARD_IRQ,
                },
              },
            }),
            ...(this.tablet && {
              [`virtio_mmio@${hex(MemoryMap.VIRTIO_TABLET)}`]: {
                props: {
                  compatible: 'virtio,mmio',
                  reg: reg(MemoryMap.VIRTIO_TABLET, VirtioInput.SIZE),
                  'interrupt-parent': PLIC_PHANDLE,
                  interrupts: TABLET_IRQ,
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
const CONSOLE_IRQ = 5
const RTC_IRQ = 3
const TERMINAL_IRQ = 4
const KEYBOARD_IRQ = 6
const TABLET_IRQ = 7

/**
 * Start a thread running a hart (hart-worker.ts): `message` hears from it
 * (when it rings, see HartThreadData.ring), `error` of it failing.
 */
function startThread(
  data: HartThreadData,
  message: () => void,
  error: (error: unknown) => void,
): { terminate(): Promise<unknown> } {
  if (threads) {
    const worker = new threads.Worker(WORKER, { workerData: data })
    worker.on('message', message)
    worker.on('error', error)
    return worker
  }
  const worker = new Worker(WORKER, { type: 'module' })
  worker.onmessage = message
  worker.onerror = event => error(new Error(event.message))
  worker.postMessage(data)
  return { terminate: async () => worker.terminate() }
}
