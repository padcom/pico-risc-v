import { Framebuffer } from './framebuffer.js'
import { length, VirtioMmioDevice, type Chain, type GuestMemory, type Virtqueue } from './virtio.js'

// Queues
const CONTROL = 0
const CURSOR = 1

// Commands (struct virtio_gpu_ctrl_hdr's type) and responses
const GET_DISPLAY_INFO = 0x0100
const RESOURCE_CREATE_2D = 0x0101
const RESOURCE_UNREF = 0x0102
const SET_SCANOUT = 0x0103
const RESOURCE_FLUSH = 0x0104
const TRANSFER_TO_HOST_2D = 0x0105
const RESOURCE_ATTACH_BACKING = 0x0106
const RESOURCE_DETACH_BACKING = 0x0107
const OK_NODATA = 0x1100
const OK_DISPLAY_INFO = 0x1101
const ERR_UNSPEC = 0x1200
const ERR_OUT_OF_MEMORY = 0x1201
const ERR_INVALID_SCANOUT_ID = 0x1202
const ERR_INVALID_RESOURCE_ID = 0x1203
const ERR_INVALID_PARAMETER = 0x1205
const FLAG_FENCE = 1
/** The ctrl header's size; then a command's fields. */
const HEADER = 24
const MAX_SCANOUTS = 16
/** Config: events_read's bit for "the display (its size) changed". */
const EVENT_DISPLAY = 1
/** Formats with 32-bit pixels, blue in the lowest byte (as Framebuffer's): B8G8R8A8, B8G8R8X8. */
const BGRX_FORMATS = new Set([1, 2])
/** The biggest image the guest may create (bytes): a 4K screen's. */
const MAX_RESOURCE = 3840 * 2160 * 4

/** An image the guest drew in, on this side, and where it comes from in guest memory. */
interface Resource {
  width: number
  height: number
  image: Framebuffer
  bytes: Uint8Array
  /** Its backing: guest physical ranges, end to end. */
  backing: { addr: number; length: number }[]
}

/**
 * A virtio GPU, 2D only (Linux's virtio_gpu, a DRM driver: X's modesetting
 * driver on it): the guest creates images (resources) here, attaches guest
 * memory to them, copies rectangles of it in (TRANSFER_TO_HOST_2D), and shows
 * one (SET_SCANOUT, RESOURCE_FLUSH). `output` is what's shown.
 *
 * Unlike a framebuffer, its size can change while the guest runs: resize()
 * sets the display's preferred size, and tells the driver (a config change),
 * which tells userspace (a hotplug event); X then switches to it (xrandr:
 * the guests' scripts do that).
 *
 * There's no cursor here (its commands are taken, and ignored): X draws its
 * own (SWcursor).
 */
export class VirtioGpu extends VirtioMmioDevice {
  protected readonly deviceId = 16
  private readonly resources = new Map<number, Resource>()
  private width: number
  private height: number
  private events = 0
  /** The resource shown, and what it showed last (kept while there's none, as a screen would). */
  private scanout = 0
  private shown: Framebuffer | undefined

  /**
   * `memory`: DMA for the queues; `read`: guest memory to copy images from
   * (only read, so without the bookkeeping writes take).
   */
  constructor(
    memory: GuestMemory,
    private readonly read: GuestMemory,
    irq: (high: boolean) => void,
    width: number,
    height: number,
  ) {
    super(memory, irq, [64, 16])
    this.width = width
    this.height = height
  }

  /** What the display shows: the guest's image, once it shows one. */
  get output(): Framebuffer | undefined {
    return this.shown
  }

  /**
   * The display's preferred size changed (the window's): tell the driver.
   * (The width a multiple of 8: the mode Linux makes of it would be.)
   */
  resize(width: number, height: number): void {
    width = Math.max(320, Math.min(3840, Math.floor(width / 8) * 8))
    height = Math.max(200, Math.min(2160, Math.round(height)))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.events |= EVENT_DISPLAY
    if (this.ready) this.configChanged()
  }

  override reset(): void {
    super.reset()
    this.resources.clear()
    this.events = 0
    this.scanout = 0
    this.shown = undefined
  }

  protected deviceFeatures(): number {
    return 0 // (no 3D, no EDID: the driver takes the display info's size)
  }

  /** struct virtio_gpu_config: events_read, events_clear, num_scanouts, num_capsets. */
  protected readConfig(offset: number): number {
    if (offset === 0) return this.events
    if (offset === 8) return 1
    return 0
  }

  protected override writeConfig(offset: number, value: number): void {
    if (offset === 4) this.events &= ~value // events_clear
  }

  protected queueNotified(index: number): void {
    const q = this.queues[index]!
    let handled = false
    for (let chain = q.pop(); chain; chain = q.pop()) {
      const written = index === CONTROL ? this.command(q, chain) : 0 // (CURSOR: nothing to answer)
      q.push(chain.head, written)
      handled = true
    }
    if (handled) this.signalUsed()
  }

  /** Carry out a control command; returns the bytes of the response written. */
  private command(q: Virtqueue, chain: Chain): number {
    const request = q.read(chain.readable)
    if (request.length < HEADER) return 0
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength)
    const u32 = (at: number) => view.getUint32(at, true)
    let response: Uint8Array
    switch (u32(0)) {
      case GET_DISPLAY_INFO:
        response = this.displayInfo()
        break
      case RESOURCE_CREATE_2D:
        response = this.answer(this.create(u32(24), u32(28), u32(32), u32(36)))
        break
      case RESOURCE_UNREF:
        response = this.answer(this.unref(u32(24)))
        break
      case SET_SCANOUT:
        response = this.answer(this.setScanout(u32(40), u32(44), u32(32), u32(36)))
        break
      case RESOURCE_FLUSH:
        response = this.answer(this.resources.has(u32(40)) ? OK_NODATA : ERR_INVALID_RESOURCE_ID)
        break
      case TRANSFER_TO_HOST_2D:
        response = this.answer(this.transfer(u32(48), u32(24), u32(28), u32(32), u32(36), Number(view.getBigUint64(40, true))))
        break
      case RESOURCE_ATTACH_BACKING: {
        const entries = Array.from({ length: Math.min(u32(28), (request.length - 32) >> 4) }, (_, i) => ({
          addr: Number(view.getBigUint64(32 + 16 * i, true)),
          length: u32(40 + 16 * i),
        }))
        response = this.answer(this.attach(u32(24), entries))
        break
      }
      case RESOURCE_DETACH_BACKING: {
        const resource = this.resources.get(u32(24))
        if (resource) resource.backing = []
        response = this.answer(resource ? OK_NODATA : ERR_INVALID_RESOURCE_ID)
        break
      }
      default:
        response = this.answer(ERR_UNSPEC)
    }
    // A fenced command: its response says so, with the fence (it's done).
    if (u32(4) & FLAG_FENCE) {
      response.set(request.subarray(4, 24), 4)
    }
    return q.write(chain.writable, response.subarray(0, Math.min(response.length, length(chain.writable))))
  }

  /** A response that's just a header of `type`. */
  private answer(type: number): Uint8Array {
    const response = new Uint8Array(HEADER)
    new DataView(response.buffer).setUint32(0, type, true)
    return response
  }

  /** struct virtio_gpu_resp_display_info: one display (scanout 0), the preferred size. */
  private displayInfo(): Uint8Array {
    const response = new Uint8Array(HEADER + 24 * MAX_SCANOUTS)
    const view = new DataView(response.buffer)
    view.setUint32(0, OK_DISPLAY_INFO, true)
    view.setUint32(HEADER + 8, this.width, true)
    view.setUint32(HEADER + 12, this.height, true)
    view.setUint32(HEADER + 16, 1, true) // enabled
    return response
  }

  private create(id: number, format: number, width: number, height: number): number {
    if (id === 0 || this.resources.has(id)) return ERR_INVALID_RESOURCE_ID
    if (!BGRX_FORMATS.has(format) || width === 0 || height === 0) return ERR_INVALID_PARAMETER
    if (width * height * 4 > MAX_RESOURCE) return ERR_OUT_OF_MEMORY
    const bytes = new Uint8Array(Framebuffer.size(width, height))
    this.resources.set(id, { width, height, bytes, image: new Framebuffer(width, height, bytes), backing: [] })
    return OK_NODATA
  }

  private unref(id: number): number {
    if (!this.resources.delete(id)) return ERR_INVALID_RESOURCE_ID
    if (this.scanout === id) this.scanout = 0
    return OK_NODATA
  }

  private attach(id: number, entries: { addr: number; length: number }[]): number {
    const resource = this.resources.get(id)
    if (!resource) return ERR_INVALID_RESOURCE_ID
    resource.backing = entries
    return OK_NODATA
  }

  /** Show resource `id` (0: none) on scanout `scanout`, a `width` × `height` part of it. */
  private setScanout(scanout: number, id: number, width: number, height: number): number {
    if (scanout !== 0) return ERR_INVALID_SCANOUT_ID
    if (id === 0) {
      this.scanout = 0 // (what it showed stays: no flicker while X changes modes)
      return OK_NODATA
    }
    const resource = this.resources.get(id)
    if (!resource) return ERR_INVALID_RESOURCE_ID
    if (width > resource.width || height > resource.height) return ERR_INVALID_PARAMETER
    this.scanout = id
    // (Its top left part, if smaller: the image as wide as the resource, cut.)
    this.shown = width === resource.width ? new Framebuffer(width, height, resource.bytes) : resource.image
    return OK_NODATA
  }

  /**
   * Copy a rectangle of resource `id` in from its backing: rows of `width`
   * pixels from (x, y), the first at byte `offset` of the backing, one
   * stride (the resource's width) apart.
   */
  private transfer(id: number, x: number, y: number, width: number, height: number, offset: number): number {
    const resource = this.resources.get(id)
    if (!resource) return ERR_INVALID_RESOURCE_ID
    if (x + width > resource.width || y + height > resource.height) return ERR_INVALID_PARAMETER
    const stride = resource.width * 4
    for (let row = 0; row < height; row++) {
      this.copyIn(resource, offset + row * stride, (y + row) * stride + x * 4, width * 4)
    }
    return OK_NODATA
  }

  /** Copy `count` bytes from byte `from` of a resource's backing to byte `to` of its image. */
  private copyIn(resource: Resource, from: number, to: number, count: number): void {
    let skip = from
    for (const { addr, length } of resource.backing) {
      if (count === 0) return
      if (skip >= length) {
        skip -= length
        continue
      }
      const n = Math.min(length - skip, count)
      try {
        resource.bytes.set(this.read(addr + skip, n), to)
      } catch (e) {
        if (!(e instanceof RangeError)) throw e
        return // (backing outside RAM: nothing there to copy)
      }
      to += n
      count -= n
      skip = 0
    }
  }
}
