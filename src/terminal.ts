import type { Bus } from './bus.js'

/**
 * Character I/O device — a text terminal attached through a serial port.
 *
 * Programmed like a (minimal) 16550 UART, the same chip QEMU's `virt` machine
 * exposes, so ordinary bare-metal UART code works unchanged:
 *
 *   offset 0  RBR (read)   next received character (0 if none)
 *             THR (write)  transmit a character to the screen
 *   offset 5  LSR (read)   line status:
 *                            bit 0 DR   — a received character is waiting
 *                            bit 5 THRE — transmitter ready for a character
 *                            bit 6 TEMT — transmitter idle
 *
 * Every other register reads as 0 and ignores writes, so the usual init
 * sequence (baud-rate divisor, FIFO control, ...) is harmless.
 * Registers are byte-wide; 16/32-bit accesses act on the addressed byte.
 */
export class Terminal implements Bus {
  static readonly SIZE = 0x100

  static readonly RBR = 0
  static readonly THR = 0
  static readonly LSR = 5

  static readonly LSR_DR = 1 << 0
  static readonly LSR_THRE = 1 << 5
  static readonly LSR_TEMT = 1 << 6

  private readonly input: number[] = []

  /** @param output receives every byte the program transmits */
  constructor(private readonly output: (byte: number) => void = () => {}) {}

  /** Queue keyboard input for the program to read. */
  type(data: string | ArrayLike<number>): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    for (let i = 0; i < bytes.length; i++) this.input.push(bytes[i]! & 0xff)
  }

  read8(addr: number): number {
    switch (addr) {
      case Terminal.RBR:
        return this.input.shift() ?? 0
      case Terminal.LSR:
        return Terminal.LSR_THRE | Terminal.LSR_TEMT | (this.input.length > 0 ? Terminal.LSR_DR : 0)
      default:
        return 0
    }
  }

  write8(addr: number, value: number): void {
    if (addr === Terminal.THR) this.output(value & 0xff)
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
