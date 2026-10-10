import { WordDevice } from './bus.js'
import { MIP_MSIP, MIP_MTIP } from './csr.js'

const TWO_32 = 0x1_0000_0000

/**
 * Core-Local Interruptor (SiFive CLINT layout) for a single hart:
 *
 *   0x0000  msip         bit 0 raises the machine software interrupt
 *   0x4000  mtimecmp     64-bit; timer interrupt pending while mtime >= mtimecmp
 *   0xbff8  mtime        64-bit free-running counter (1 tick = 1 µs)
 *
 * mtime comes from an external clock so the machine can run on wall-clock or
 * virtual (instruction-count) time.
 */
export class Clint extends WordDevice {
  static readonly SIZE = 0x10000

  static readonly MSIP = 0x0000
  static readonly MTIMECMP = 0x4000
  static readonly MTIME = 0xbff8

  private cmpLo = 0xffff_ffff
  private cmpHi = 0xffff_ffff
  private msip = 0
  private timeOffset = 0

  constructor(
    private readonly clock: () => number,
    private readonly raise: (bit: number, pending: boolean) => void,
  ) {
    super()
  }

  /** mtimecmp as a number (rounded above 2^53, which is fine: mtime never gets there). */
  get mtimecmp(): number {
    return this.cmpHi * TWO_32 + this.cmpLo
  }

  get mtime(): number {
    return this.clock() + this.timeOffset
  }

  /** Re-evaluate the timer interrupt line; call whenever time has moved on. */
  update(): void {
    this.raise(MIP_MTIP, this.mtime >= this.mtimecmp)
  }

  reset(): void {
    this.cmpLo = this.cmpHi = 0xffff_ffff
    this.msip = 0
    this.timeOffset = -this.clock()
    this.raise(MIP_MSIP, false)
    this.update()
  }

  protected readWord(offset: number): number {
    switch (offset) {
      case Clint.MSIP: return this.msip
      case Clint.MTIMECMP: return this.cmpLo
      case Clint.MTIMECMP + 4: return this.cmpHi
      case Clint.MTIME: return this.mtime % TWO_32
      case Clint.MTIME + 4: return Math.floor(this.mtime / TWO_32)
      default: return 0
    }
  }

  protected writeWord(offset: number, value: number): void {
    const lo = (v: number) => v % TWO_32
    const hi = (v: number) => Math.floor(v / TWO_32)
    value >>>= 0
    switch (offset) {
      case Clint.MSIP:
        this.msip = value & 1
        this.raise(MIP_MSIP, this.msip !== 0)
        return
      case Clint.MTIMECMP: this.cmpLo = value; break
      case Clint.MTIMECMP + 4: this.cmpHi = value; break
      case Clint.MTIME: this.timeOffset += hi(this.mtime) * TWO_32 + value - this.mtime; break
      case Clint.MTIME + 4: this.timeOffset += value * TWO_32 + lo(this.mtime) - this.mtime; break
      default: return
    }
    this.update()
  }
}
