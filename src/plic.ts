import { WordDevice } from './bus.js'
import { MIP_MEIP, MIP_SEIP } from './csr.js'

/**
 * Platform-Level Interrupt Controller (SiFive / RISC-V PLIC layout) for one
 * hart with two contexts: 0 = M-mode (drives mip.MEIP), 1 = S-mode (mip.SEIP).
 *
 *   0x000000 + 4·id        priority of source id (0 = never interrupts)
 *   0x001000 + 4·word      pending bits (read-only)
 *   0x002000 + 0x80·ctx    enable bits of a context
 *   0x200000 + 0x1000·ctx  priority threshold of a context
 *              … + 4       claim (read: take the best pending source) /
 *                          complete (write: done with that source)
 *
 * Sources are level-triggered: a source is pending while its line is high and
 * it isn't being serviced (claimed and not yet completed).
 */
export class Plic extends WordDevice {
  static readonly SIZE = 0x400_0000
  /** Source ids 1..SOURCES-1 exist (0 means "no interrupt"). */
  static readonly SOURCES = 32

  private readonly priority = new Uint32Array(Plic.SOURCES)
  private readonly enable = [0, 0]
  private readonly threshold = [0, 0]
  /** Line levels and in-service sources, as bit masks indexed by source id. */
  private level = 0
  private inService = 0

  private static readonly CONTEXT_BITS = [MIP_MEIP, MIP_SEIP]

  constructor(private readonly raise: (bit: number, pending: boolean) => void) {
    super()
  }

  /** Called by devices: drive interrupt line `source` high or low. */
  setLevel(source: number, high: boolean): void {
    const bit = 1 << source
    this.level = high ? this.level | bit : this.level & ~bit
    this.update()
  }

  reset(): void {
    this.priority.fill(0)
    this.enable.fill(0)
    this.threshold.fill(0)
    this.inService = 0
    this.update()
  }

  private get pending(): number {
    return this.level & ~this.inService & ~1
  }

  /** Highest-priority pending, enabled source above the context's threshold (0 if none). */
  private best(ctx: number): number {
    const candidates = this.pending & this.enable[ctx]!
    let best = 0
    let bestPriority = this.threshold[ctx]!
    for (let id = 1; id < Plic.SOURCES; id++) {
      if (candidates & (1 << id) && this.priority[id]! > bestPriority) {
        best = id
        bestPriority = this.priority[id]!
      }
    }
    return best
  }

  private update(): void {
    for (let ctx = 0; ctx < 2; ctx++) this.raise(Plic.CONTEXT_BITS[ctx]!, this.best(ctx) !== 0)
  }

  protected readWord(offset: number): number {
    if (offset < 0x1000) return this.priority[offset >>> 2] ?? 0
    if (offset === 0x1000) return this.pending >>> 0
    const ctx = this.context(offset)
    if (ctx === undefined) return 0
    if (offset < 0x200000) return (offset & 0x7f) === 0 ? this.enable[ctx]! >>> 0 : 0
    if ((offset & 0xfff) === 0) return this.threshold[ctx]!
    if ((offset & 0xfff) === 4) {
      const id = this.best(ctx) // claim
      if (id) {
        this.inService |= 1 << id
        this.update()
      }
      return id
    }
    return 0
  }

  protected writeWord(offset: number, value: number): void {
    if (offset < 0x1000) {
      const id = offset >>> 2
      if (id > 0 && id < Plic.SOURCES) this.priority[id] = value & 7
    } else {
      const ctx = this.context(offset)
      if (ctx === undefined) return
      if (offset < 0x200000) {
        if ((offset & 0x7f) === 0) this.enable[ctx] = value & ~1
      } else if ((offset & 0xfff) === 0) {
        this.threshold[ctx] = value & 7
      } else if ((offset & 0xfff) === 4 && value > 0 && value < Plic.SOURCES) {
        this.inService &= ~(1 << value) // complete
      } else {
        return
      }
    }
    this.update()
  }

  /** Context addressed by an enable / threshold / claim offset, if it exists. */
  private context(offset: number): number | undefined {
    let ctx: number
    if (offset >= 0x2000 && offset < 0x200000) ctx = (offset - 0x2000) >>> 7
    else if (offset >= 0x200000) ctx = (offset - 0x200000) >>> 12
    else return undefined
    return ctx < 2 ? ctx : undefined
  }
}
