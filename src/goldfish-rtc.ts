import { WordDevice } from './bus.js'

/**
 * Real-time clock (Google Goldfish RTC, as on QEMU's virt board): the time of
 * day as nanoseconds since 1970, from the host's clock. Linux reads it at boot
 * (rtc-goldfish, hctosys), so the guest knows the date, which TLS certificate
 * checks need.
 *
 *   0x00  TIME_LOW     low 32 bits; reading it latches the high half
 *   0x04  TIME_HIGH    high 32 bits (as latched)
 *                      writing HIGH then LOW sets the clock (kept as an offset)
 *   0x08… alarm registers: accepted, but the alarm never fires
 */
export class GoldfishRtc extends WordDevice {
  static readonly SIZE = 0x1000

  private latchedHigh = 0
  private pendingHigh = 0
  private offsetNs = 0n

  /** @param nowMs host wall-clock time in milliseconds since 1970 */
  constructor(private readonly nowMs: () => number = Date.now) {
    super()
  }

  private now(): bigint {
    return BigInt(Math.floor(this.nowMs())) * 1_000_000n + this.offsetNs
  }

  protected readWord(offset: number): number {
    switch (offset) {
      case 0x00: {
        const t = this.now()
        this.latchedHigh = Number(t >> 32n)
        return Number(t & 0xffff_ffffn)
      }
      case 0x04: return this.latchedHigh
      default: return 0 // alarm registers: no alarm pending
    }
  }

  protected writeWord(offset: number, value: number): void {
    if (offset === 0x04) this.pendingHigh = value
    else if (offset === 0x00) {
      const wanted = (BigInt(this.pendingHigh >>> 0) << 32n) | BigInt(value >>> 0)
      this.offsetNs = wanted - (this.now() - this.offsetNs)
    }
  }
}
