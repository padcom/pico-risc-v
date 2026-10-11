import { type GuestMemory, length, VirtioMmioDevice } from './virtio.js'

/**
 * What the network card is plugged into: takes the guest's Ethernet frames and
 * delivers frames to it (at any time, e.g. from host socket callbacks).
 */
export interface NetworkBackend {
  /** A frame the guest transmitted. */
  send(frame: Uint8Array): void
  /** Connect the card's receive side. */
  attach(receive: (frame: Uint8Array) => void): void
  /**
   * True while the guest is waiting on something happening in the real world
   * (a connection being set up, a reply on its way). The virtual clock then
   * doesn't skip ahead, so the guest's timeouts don't expire meanwhile.
   */
  readonly busy?: boolean
  close?(): void
}

// Feature bits
const VIRTIO_NET_F_MAC = 1 << 5
const VIRTIO_NET_F_STATUS = 1 << 16
const VIRTIO_NET_S_LINK_UP = 1

/** struct virtio_net_hdr_v1 (no offloads negotiated, so only num_buffers matters). */
const HEADER_SIZE = 12
const RX = 0
const TX = 1
/** Frames waiting for receive buffers beyond this are dropped (a full NIC ring). */
const MAX_PENDING = 1024

/**
 * virtio network card: queue 0 receives, queue 1 transmits. No checksum or
 * segmentation offloads: the guest computes checksums and sends ordinary
 * Ethernet-sized frames.
 */
export class VirtioNet extends VirtioMmioDevice {
  protected readonly deviceId = 1
  private pending: Uint8Array[] = []

  constructor(
    private readonly backend: NetworkBackend,
    readonly mac: Uint8Array,
    memory: GuestMemory,
    irq: (high: boolean) => void,
  ) {
    super(memory, irq, [256, 256])
    backend.attach(frame => this.receive(frame))
  }

  override reset(): void {
    super.reset()
    this.pending = []
  }

  protected deviceFeatures(word: number): number {
    return word === 0 ? VIRTIO_NET_F_MAC | VIRTIO_NET_F_STATUS : 0
  }

  /** struct virtio_net_config: mac[6], status u16. */
  protected readConfig(offset: number): number {
    const config = [...this.mac, VIRTIO_NET_S_LINK_UP, 0]
    let word = 0
    for (let i = 3; i >= 0; i--) word = (word << 8) | (config[offset + i] ?? 0)
    return word >>> 0
  }

  protected queueNotified(index: number): void {
    if (index === TX) this.transmit()
    else if (index === RX) this.deliver() // new receive buffers
  }

  /** A frame from the network for the guest. */
  receive(frame: Uint8Array): void {
    if (this.pending.length >= MAX_PENDING) return
    this.pending.push(frame)
    this.guarded(() => this.deliver())
  }

  private transmit(): void {
    const q = this.queues[TX]!
    let handled = false
    for (let chain = q.pop(); chain; chain = q.pop()) {
      const packet = q.read(chain.readable)
      if (packet.length > HEADER_SIZE) this.backend.send(packet.slice(HEADER_SIZE))
      q.push(chain.head, 0)
      handled = true
    }
    if (handled) this.signalUsed()
  }

  /** Move pending frames into receive buffers the guest made available. */
  private deliver(): void {
    const q = this.queues[RX]!
    let handled = false
    while (this.pending.length) {
      const chain = q.pop()
      if (!chain) break
      const frame = this.pending.shift()!
      const packet = new Uint8Array(HEADER_SIZE + frame.length)
      packet[10] = 1 // num_buffers: the frame fits in this one chain
      packet.set(frame, HEADER_SIZE)
      // A frame larger than the buffer can't happen with Ethernet-sized buffers; truncate if it does.
      const written = q.write(chain.writable, packet.subarray(0, Math.min(packet.length, length(chain.writable))))
      q.push(chain.head, written)
      handled = true
    }
    if (handled) this.signalUsed()
  }
}
