import { WordDevice } from './bus.js'

/**
 * Gives a device access to guest physical memory ("DMA"): a view of `length`
 * bytes at physical address `addr`. Throws a RangeError if that isn't RAM.
 */
export type GuestMemory = (addr: number, length: number) => Uint8Array

/** A guest buffer referenced by a descriptor. */
export interface Segment {
  addr: number
  length: number
}

/** A descriptor chain: one request, split into device-readable and device-writable buffers. */
export interface Chain {
  head: number
  readable: Segment[]
  writable: Segment[]
}

// virtio-mmio registers (version 2, "modern")
const enum Reg {
  MagicValue = 0x000,
  Version = 0x004,
  DeviceId = 0x008,
  VendorId = 0x00c,
  DeviceFeatures = 0x010,
  DeviceFeaturesSel = 0x014,
  DriverFeatures = 0x020,
  DriverFeaturesSel = 0x024,
  QueueSel = 0x030,
  QueueNumMax = 0x034,
  QueueNum = 0x038,
  QueueReady = 0x044,
  QueueNotify = 0x050,
  InterruptStatus = 0x060,
  InterruptAck = 0x064,
  Status = 0x070,
  QueueDescLow = 0x080,
  QueueDescHigh = 0x084,
  QueueDriverLow = 0x090,
  QueueDriverHigh = 0x094,
  QueueDeviceLow = 0x0a0,
  QueueDeviceHigh = 0x0a4,
  // Shared memory regions: none (lengths and bases all ones).
  SHMLenLow = 0x0b0,
  SHMLenHigh = 0x0b4,
  SHMBaseLow = 0x0b8,
  SHMBaseHigh = 0x0bc,
  ConfigGeneration = 0x0fc,
  Config = 0x100,
}

const VIRTIO_F_VERSION_1 = 1 << 0 // feature bit 32: bit 0 of the high word
const VIRTQ_DESC_F_NEXT = 1
const VIRTQ_DESC_F_WRITE = 2
const STATUS_DRIVER_OK = 0x04
const STATUS_DEVICE_NEEDS_RESET = 0x40

/**
 * A split virtqueue in guest memory: descriptor table, available ring (driver
 * → device) and used ring (device → driver). No indirect descriptors, no
 * event index (neither feature is offered).
 */
export class Virtqueue {
  num = 0
  ready = 0
  descAddr = 0
  availAddr = 0
  usedAddr = 0
  private lastAvail = 0
  private usedIdx = 0

  constructor(
    readonly maxSize: number,
    private readonly memory: GuestMemory,
  ) {}

  reset(): void {
    this.num = this.ready = this.descAddr = this.availAddr = this.usedAddr = 0
    this.restart()
  }

  /** Start from the beginning of the rings (when the driver makes the queue ready). */
  restart(): void {
    this.lastAvail = this.usedIdx = 0
  }

  /** The next chain the driver has made available, or undefined. Throws RangeError on garbage. */
  pop(): Chain | undefined {
    if (!this.ready || !this.num) return undefined
    const avail = this.view(this.availAddr, 4 + 2 * this.num)
    if (avail.getUint16(2, true) === this.lastAvail) return undefined
    const head = avail.getUint16(4 + 2 * (this.lastAvail % this.num), true)
    this.lastAvail = (this.lastAvail + 1) & 0xffff

    const chain: Chain = { head, readable: [], writable: [] }
    const table = this.view(this.descAddr, 16 * this.num)
    for (let i = head, hops = 0; ; hops++) {
      if (i >= this.num || hops >= this.num) throw new RangeError('bad descriptor chain')
      const d = 16 * i
      if (table.getUint32(d + 4, true) !== 0) throw new RangeError('buffer above 4 GiB')
      const segment = { addr: table.getUint32(d, true), length: table.getUint32(d + 8, true) }
      const flags = table.getUint16(d + 12, true)
      ;(flags & VIRTQ_DESC_F_WRITE ? chain.writable : chain.readable).push(segment)
      if (!(flags & VIRTQ_DESC_F_NEXT)) return chain
      i = table.getUint16(d + 14, true)
    }
  }

  /** Hand a chain back to the driver, saying how many bytes were written into it. */
  push(head: number, written: number): void {
    const used = this.view(this.usedAddr, 4 + 8 * this.num)
    const slot = 4 + 8 * (this.usedIdx % this.num)
    used.setUint32(slot, head, true)
    used.setUint32(slot + 4, written, true)
    this.usedIdx = (this.usedIdx + 1) & 0xffff
    used.setUint16(2, this.usedIdx, true)
  }

  /** Concatenate guest buffers. */
  read(segments: Segment[]): Uint8Array {
    const out = new Uint8Array(length(segments))
    let at = 0
    for (const s of segments) {
      out.set(this.memory(s.addr, s.length), at)
      at += s.length
    }
    return out
  }

  /** Copy `bytes` into guest buffers, starting `skip` bytes into them. Returns bytes copied. */
  write(segments: Segment[], bytes: Uint8Array, skip = 0): number {
    let src = 0
    for (const s of segments) {
      if (src >= bytes.length) break
      if (skip >= s.length) {
        skip -= s.length
        continue
      }
      const n = Math.min(s.length - skip, bytes.length - src)
      this.memory(s.addr + skip, n).set(bytes.subarray(src, src + n))
      src += n
      skip = 0
    }
    return src
  }

  private view(addr: number, size: number): DataView {
    const bytes = this.memory(addr, size)
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}

/** Total length of some segments. */
export const length = (segments: Segment[]) => segments.reduce((n, s) => n + s.length, 0)

/**
 * The virtio-mmio transport (version 2): feature negotiation, queue setup and
 * the interrupt line, shared by all virtio devices. Subclasses supply the
 * device type, its features and config space, and react to queue notifications.
 */
export abstract class VirtioMmioDevice extends WordDevice {
  static readonly SIZE = 0x1000

  protected abstract readonly deviceId: number
  /** Device-specific feature bits: word 0 = bits 0-31, word 1 = bits 32-63 (VERSION_1 is added). */
  protected abstract deviceFeatures(word: number): number
  /** A 32-bit word of the device's config space. */
  protected abstract readConfig(offset: number): number
  /** The driver writes a word of the config space (narrower writes come as the whole word, changed). */
  protected writeConfig(_offset: number, _value: number): void {}
  /** The driver made buffers available in queue `index`. */
  protected abstract queueNotified(index: number): void

  protected readonly queues: Virtqueue[]
  private status = 0
  private deviceFeaturesSel = 0
  private driverFeaturesSel = 0
  private driverFeatures = [0, 0]
  private interruptStatus = 0
  private queueSel = 0
  /** Bumped whenever the config space changes (the driver checks it around reading it). */
  private configGeneration = 0

  constructor(
    protected readonly memory: GuestMemory,
    private readonly irq: (high: boolean) => void,
    queueSizes: number[],
  ) {
    super()
    this.queues = queueSizes.map(size => new Virtqueue(size, memory))
  }

  reset(): void {
    this.status = this.deviceFeaturesSel = this.driverFeaturesSel = this.queueSel = 0
    this.driverFeatures = [0, 0]
    for (const q of this.queues) q.reset()
    this.setInterrupt(0)
  }

  /** Features the driver accepted (word 0 or 1). */
  protected negotiated(word: number): number {
    return this.driverFeatures[word] ?? 0
  }

  /** Tell the driver it has used buffers to look at ("used buffer notification"). */
  protected signalUsed(): void {
    this.setInterrupt(this.interruptStatus | 1)
  }

  /** Tell the driver the config space changed ("configuration change notification"). */
  protected configChanged(): void {
    this.configGeneration = (this.configGeneration + 1) >>> 0
    this.setInterrupt(this.interruptStatus | 2)
  }

  /** The driver is set up (DRIVER_OK). */
  protected driverReady(): void {}

  /** Whether the driver is set up (DRIVER_OK). */
  protected get ready(): boolean {
    return (this.status & STATUS_DRIVER_OK) !== 0
  }

  /** Run `fn` for queue work; a malformed queue puts the device into DEVICE_NEEDS_RESET. */
  protected guarded(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      if (!(e instanceof RangeError)) throw e
      this.status |= STATUS_DEVICE_NEEDS_RESET
      for (const q of this.queues) q.ready = 0
    }
  }

  private get queue(): Virtqueue | undefined {
    return this.queues[this.queueSel]
  }

  private setInterrupt(status: number): void {
    this.interruptStatus = status
    this.irq(status !== 0)
  }

  protected readWord(offset: number): number {
    if (offset >= Reg.Config) return this.readConfig(offset - Reg.Config)
    switch (offset) {
      case Reg.MagicValue: return 0x74726976 // "virt"
      case Reg.Version: return 2
      case Reg.DeviceId: return this.deviceId
      case Reg.VendorId: return 0x52495343 // "RISC"
      case Reg.DeviceFeatures:
        return this.deviceFeaturesSel === 1
          ? this.deviceFeatures(1) | VIRTIO_F_VERSION_1
          : this.deviceFeaturesSel === 0
            ? this.deviceFeatures(0)
            : 0
      case Reg.QueueNumMax: return this.queue?.maxSize ?? 0 // 0: no such queue
      case Reg.QueueReady: return this.queue?.ready ?? 0
      case Reg.InterruptStatus: return this.interruptStatus
      case Reg.Status: return this.status
      case Reg.ConfigGeneration: return this.configGeneration
      case Reg.SHMLenLow:
      case Reg.SHMLenHigh:
      case Reg.SHMBaseLow:
      case Reg.SHMBaseHigh:
        return 0xffffffff
      default: return 0
    }
  }

  protected writeWord(offset: number, value: number): void {
    if (offset >= Reg.Config) return this.writeConfig(offset - Reg.Config, value)
    const q = this.queue
    switch (offset) {
      case Reg.DeviceFeaturesSel: this.deviceFeaturesSel = value; break
      case Reg.DriverFeaturesSel: this.driverFeaturesSel = value; break
      case Reg.DriverFeatures:
        if (this.driverFeaturesSel < 2) this.driverFeatures[this.driverFeaturesSel] = value
        break
      case Reg.QueueSel: this.queueSel = value; break
      case Reg.QueueNotify:
        if (this.queues[value]?.ready) this.guarded(() => this.queueNotified(value))
        break
      case Reg.InterruptAck: this.setInterrupt(this.interruptStatus & ~value); break
      case Reg.Status:
        if (value === 0) this.reset()
        else {
          const wasReady = this.ready
          this.status = value
          if (!wasReady && this.ready) this.driverReady()
        }
        break
      // The rest configures the selected queue.
      case Reg.QueueNum: if (q) q.num = Math.min(value, q.maxSize); break
      case Reg.QueueReady:
        if (q) {
          q.ready = value & 1
          if (q.ready) q.restart()
        }
        break
      case Reg.QueueDescLow: if (q) q.descAddr = value; break
      case Reg.QueueDriverLow: if (q) q.availAddr = value; break
      case Reg.QueueDeviceLow: if (q) q.usedAddr = value; break
      case Reg.QueueDescHigh:
      case Reg.QueueDriverHigh:
      case Reg.QueueDeviceHigh:
        if (value !== 0) this.guarded(() => { throw new RangeError('queue above 4 GiB') })
        break
    }
  }
}
