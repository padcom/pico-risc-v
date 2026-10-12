import type { Bus } from './bus.js'

/**
 * Character I/O device — a text terminal attached through a serial port.
 *
 * Programmed like a (minimal) 16550 UART, the same chip QEMU's `virt` machine
 * exposes, so ordinary bare-metal UART code works unchanged:
 *
 *   offset 0  RBR (read)   next received character (0 if none)
 *             THR (write)  transmit a character to the screen
 *   offset 1  IER          interrupt enable: bit 0 — a received character is
 *                          waiting, bit 1 — the transmitter is ready
 *   offset 2  IIR (read)   the interrupt to service: 0x04 received data,
 *                          0x02 transmitter ready (reading this clears it),
 *                          0x01 none; bits 6-7 set while the FIFOs are on
 *             FCR (write)  FIFO control: bit 0 turns the FIFOs on
 *   offset 3  LCR          line control; bit 7 (DLAB) switches offsets 0 and 1
 *                          to the baud-rate divisor latch, which is kept but
 *                          has no effect (setting a speed must not print the
 *                          divisor as a character)
 *   offset 5  LSR (read)   line status:
 *                            bit 0 DR   — a received character is waiting
 *                            bit 5 THRE — transmitter ready for a character
 *                            bit 6 TEMT — transmitter idle
 *
 * Every other register reads as 0 and ignores writes, so the rest of the
 * usual init sequence is harmless.
 * Registers are byte-wide; 16/32-bit accesses act on the addressed byte.
 *
 * Characters are transmitted at once, so the transmitter is always ready.
 * Its interrupt follows the 16550 (and QEMU's model of it): raised when it's
 * enabled and after each character written, cleared by reading IIR while
 * it's the one reported. Without interrupts Linux has to poll the port on
 * timer ticks, sending at most a FIFO's worth (16 characters) each time.
 */
export class Terminal implements Bus {
  static readonly SIZE = 0x100

  static readonly RBR = 0
  static readonly THR = 0
  static readonly DLL = 0
  static readonly DLM = 1
  static readonly IER = 1
  static readonly IIR = 2
  static readonly FCR = 2
  static readonly LCR = 3
  static readonly LSR = 5

  static readonly IER_RDI = 1 << 0
  static readonly IER_THRI = 1 << 1

  static readonly IIR_NO_INT = 0x01
  static readonly IIR_THRI = 0x02
  static readonly IIR_RDI = 0x04
  static readonly IIR_FIFOS = 0xc0

  static readonly FCR_ENABLE_FIFO = 1 << 0

  static readonly LCR_DLAB = 1 << 7

  static readonly LSR_DR = 1 << 0
  static readonly LSR_THRE = 1 << 5
  static readonly LSR_TEMT = 1 << 6

  private readonly input: number[] = []
  private ier = 0
  private fcr = 0
  private lcr = 0
  /** The divisor latch: DLL, DLM. */
  private readonly divisor = [0, 0]
  /** The transmitter-ready interrupt is raised (if enabled). */
  private thrPending = false

  /**
   * @param output receives every byte the program transmits
   * @param interrupt drives the interrupt line (high while one is pending)
   */
  constructor(
    private readonly output: (byte: number) => void = () => {},
    private readonly interrupt: (high: boolean) => void = () => {},
  ) {}

  /** Back to the power-on state (interrupts off); typed input stays queued. */
  reset(): void {
    this.ier = 0
    this.fcr = 0
    this.lcr = 0
    this.thrPending = false
    this.update()
  }

  /** Queue keyboard input for the program to read. */
  type(data: string | ArrayLike<number>): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    for (let i = 0; i < bytes.length; i++) this.input.push(bytes[i]! & 0xff)
    this.update()
  }

  read8(addr: number): number {
    if (this.lcr & Terminal.LCR_DLAB && (addr === Terminal.DLL || addr === Terminal.DLM)) return this.divisor[addr]!
    switch (addr) {
      case Terminal.RBR: {
        const byte = this.input.shift() ?? 0
        this.update()
        return byte
      }
      case Terminal.IER:
        return this.ier
      case Terminal.IIR:
        return this.identify() | (this.fcr & Terminal.FCR_ENABLE_FIFO ? Terminal.IIR_FIFOS : 0)
      case Terminal.LCR:
        return this.lcr
      case Terminal.LSR:
        return Terminal.LSR_THRE | Terminal.LSR_TEMT | (this.input.length > 0 ? Terminal.LSR_DR : 0)
      default:
        return 0
    }
  }

  write8(addr: number, value: number): void {
    value &= 0xff
    if (this.lcr & Terminal.LCR_DLAB && (addr === Terminal.DLL || addr === Terminal.DLM)) {
      this.divisor[addr] = value
      return
    }
    switch (addr) {
      case Terminal.THR:
        this.output(value)
        this.thrPending = true // sent: ready for the next
        this.update()
        break
      case Terminal.IER:
        if (value & ~this.ier & Terminal.IER_THRI) this.thrPending = true
        this.ier = value & (Terminal.IER_RDI | Terminal.IER_THRI)
        this.update()
        break
      case Terminal.FCR:
        this.fcr = value
        break
      case Terminal.LCR:
        this.lcr = value
        break
    }
  }

  /** IIR's interrupt identification; reporting the transmitter's clears it. */
  private identify(): number {
    if (this.ier & Terminal.IER_RDI && this.input.length > 0) return Terminal.IIR_RDI
    if (this.ier & Terminal.IER_THRI && this.thrPending) {
      this.thrPending = false
      this.update()
      return Terminal.IIR_THRI
    }
    return Terminal.IIR_NO_INT
  }

  private update(): void {
    this.interrupt(
      (this.ier & Terminal.IER_RDI && this.input.length > 0) || (this.ier & Terminal.IER_THRI && this.thrPending) ? true : false,
    )
  }

  read16(addr: number): number {
    return this.read8(addr)
  }

  read32(addr: number): number {
    return this.read8(addr)
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value)
  }

  write32(addr: number, value: number): void {
    this.write8(addr, value)
  }
}
