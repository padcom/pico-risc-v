import { length, VirtioMmioDevice, type GuestMemory } from './virtio.js'

// Feature bits
const VIRTIO_CONSOLE_F_SIZE = 1 << 0

/** Queues of port 0 (the only one: no MULTIPORT). */
const RX = 0
const TX = 1
/** Input bytes waiting for the guest's receive buffers, at most. */
const MAX_PENDING = 64 * 1024

/**
 * virtio console with one port (Linux's hvc0): a terminal like the serial
 * port's, which also knows its size (VIRTIO_CONSOLE_F_SIZE). Linux makes
 * that the terminal's size, and when it changes (resize()) tells the
 * programs on it (SIGWINCH), so full-screen ones (htop, mc, vim) follow.
 * The serial port has no way to say: programs there assume 80×24.
 *
 * What the guest writes goes to `output`; type() queues keyboard input.
 */
export class VirtioConsole extends VirtioMmioDevice {
  protected readonly deviceId = 3
  private cols = 80
  private rows = 24
  private pending: number[] = []
  /** Whether the guest has written anything to it (since a reset): a terminal is open on it. */
  private written = false

  constructor(
    memory: GuestMemory,
    irq: (high: boolean) => void,
    private readonly output: (byte: number) => void,
  ) {
    super(memory, irq, [64, 64])
  }

  /** True once the guest has written to it: it's where a login is (keyboard input then goes here). */
  get inUse(): boolean {
    return this.written
  }

  /** The terminal's size changed. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    if (this.ready) this.configChanged()
  }

  /** Queue keyboard input for the guest. */
  type(data: string | ArrayLike<number>): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    for (let i = 0; i < bytes.length && this.pending.length < MAX_PENDING; i++) this.pending.push(bytes[i]! & 0xff)
    this.guarded(() => this.deliver())
  }

  override reset(): void {
    super.reset()
    this.pending = []
    this.written = false
  }

  protected deviceFeatures(word: number): number {
    return word === 0 ? VIRTIO_CONSOLE_F_SIZE : 0
  }

  /** struct virtio_console_config: cols u16, rows u16, max_nr_ports u32, emerg_wr u32. */
  protected readConfig(offset: number): number {
    return offset === 0 ? (this.cols | (this.rows << 16)) >>> 0 : 0
  }

  /**
   * Linux only reads the size when told it changed, then applies it to the
   * terminal whenever it's opened: tell it once it's ready.
   */
  protected override driverReady(): void {
    this.configChanged()
  }

  protected queueNotified(index: number): void {
    if (index === TX) this.transmit()
    else if (index === RX) this.deliver() // new receive buffers
  }

  private transmit(): void {
    const q = this.queues[TX]!
    let handled = false
    for (let chain = q.pop(); chain; chain = q.pop()) {
      for (const byte of q.read(chain.readable)) this.output(byte)
      this.written = true
      q.push(chain.head, 0)
      handled = true
    }
    if (handled) this.signalUsed()
  }

  /** Move pending input into receive buffers the guest made available. */
  private deliver(): void {
    const q = this.queues[RX]!
    let handled = false
    while (this.pending.length) {
      const chain = q.pop()
      if (!chain) break
      const n = Math.min(this.pending.length, length(chain.writable))
      q.write(chain.writable, Uint8Array.from(this.pending.splice(0, n)))
      q.push(chain.head, n)
      handled = true
    }
    if (handled) this.signalUsed()
  }
}
