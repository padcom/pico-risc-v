import { WordDevice } from './bus.js'
import { MIP_MSIP, MIP_MTIP } from './csr.js'

const TWO_32 = 0x1_0000_0000

/**
 * Core-Local Interruptor (SiFive CLINT layout) for `harts` harts:
 *
 *   0x0000 + 4·hart  msip      bit 0 raises the hart's machine software interrupt
 *   0x4000 + 8·hart  mtimecmp  64-bit; the hart's timer interrupt is pending
 *                              while mtime >= its mtimecmp
 *   0xbff8           mtime     64-bit free-running counter (1 tick = 1 µs)
 *
 * mtime comes from an external clock so the machine can run on wall-clock or
 * virtual (instruction-count) time.
 *
 * msip and mtimecmp are kept in `state`, on memory threads can share: harts
 * running on threads of their own handle accesses to the CLINT themselves
 * (hart-worker.ts), rather than asking the thread with the devices each time
 * (OpenSBI writes it for every timer and every inter-processor interrupt).
 */
export class Clint extends WordDevice {
  static readonly SIZE = 0x10000

  static readonly MSIP = 0x0000
  static readonly MTIMECMP = 0x4000
  static readonly MTIME = 0xbff8

  /** Each hart's msip, then each one's mtimecmp, low and high word (CLINT_STATE in hart-worker.ts). */
  readonly state: Uint32Array
  private timeOffset = 0

  constructor(
    private readonly clock: () => number,
    private readonly raise: (bit: number, pending: boolean, hart: number) => void,
    readonly harts = 1,
  ) {
    super()
    const bytes = 4 * 3 * harts
    this.state = new Uint32Array(typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes))
    this.reset()
  }

  private cmp(hart: number, high: boolean): number {
    return this.state[this.harts + 2 * hart + (high ? 1 : 0)]!
  }

  /** Hart 0's mtimecmp. */
  get mtimecmp(): number {
    return this.timecmp(0)
  }

  /** A hart's mtimecmp as a number (rounded above 2^53, which is fine: mtime never gets there). */
  timecmp(hart: number): number {
    return this.cmp(hart, true) * TWO_32 + this.cmp(hart, false)
  }

  get mtime(): number {
    return this.clock() + this.timeOffset
  }

  /** Re-evaluate the timer interrupt lines; call whenever time has moved on. */
  update(): void {
    const mtime = this.mtime
    for (let hart = 0; hart < this.harts; hart++) this.raise(MIP_MTIP, mtime >= this.timecmp(hart), hart)
  }

  reset(): void {
    this.state.fill(0, 0, this.harts) // msip
    this.state.fill(0xffff_ffff, this.harts) // mtimecmp
    this.timeOffset = -this.clock()
    for (let hart = 0; hart < this.harts; hart++) this.raise(MIP_MSIP, false, hart)
    this.update()
  }

  protected readWord(offset: number): number {
    if (offset < 4 * this.harts) return this.state[offset >>> 2]!
    const cmp = offset - Clint.MTIMECMP
    if (cmp >= 0 && cmp < 8 * this.harts) return this.state[this.harts + (cmp >>> 2)]!
    switch (offset) {
      case Clint.MTIME: return this.mtime % TWO_32
      case Clint.MTIME + 4: return Math.floor(this.mtime / TWO_32)
      default: return 0
    }
  }

  protected writeWord(offset: number, value: number): void {
    const lo = (v: number) => v % TWO_32
    const hi = (v: number) => Math.floor(v / TWO_32)
    value >>>= 0
    if (offset < 4 * this.harts) {
      const hart = offset >>> 2
      this.state[hart] = value & 1
      this.raise(MIP_MSIP, (value & 1) !== 0, hart)
      return
    }
    const cmp = offset - Clint.MTIMECMP
    if (cmp >= 0 && cmp < 8 * this.harts) {
      this.state[this.harts + (cmp >>> 2)] = value
    } else if (offset === Clint.MTIME) {
      this.timeOffset += hi(this.mtime) * TWO_32 + value - this.mtime
    } else if (offset === Clint.MTIME + 4) {
      this.timeOffset += value * TWO_32 + lo(this.mtime) - this.mtime
    } else {
      return
    }
    this.update()
  }
}
