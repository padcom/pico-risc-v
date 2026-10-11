import { readFileSync } from 'node:fs'
import { type Bus, BusError } from './bus.js'
import type { Priv } from './csr.js'
import { RAM } from './ram.js'

/**
 * Why `run()` returned:
 *  - limit:      the requested number of steps was executed
 *  - wfi:        the hart is stalled in WFI with no enabled interrupt pending
 *  - breakpoint: EBREAK executed while `breakOnEbreak` is set (pc left on it)
 *  - stopped:    something (e.g. a power-off device) called `stop()`
 */
export type StopReason = 'limit' | 'wfi' | 'breakpoint' | 'stopped'

/** By the codes the core's run() returns. */
const STOP_REASONS: readonly StopReason[] = ['limit', 'wfi', 'breakpoint', 'stopped']

export interface CPUOptions {
  /** Address of the first instruction. */
  resetVector?: number
  /** Source for the `time`/`timeh` CSRs (normally the CLINT's mtime). Without one they are illegal. */
  readTime?: () => number
  /**
   * Treat EBREAK as a debugger breakpoint: stop `run()` instead of trapping.
   * Handy for hand-assembled test programs that have no trap handler.
   */
  breakOnEbreak?: boolean
  /**
   * RAM inside the CPU core, at physical address `base`: the CPU reads and
   * writes it directly instead of going through the bus, which is much
   * faster. Available as `cpu.ram`; map it on the bus as well, for devices.
   */
  ram?: { base: number; size: number }
}

/** CPU state readable and writable as properties, in the core's field order (hart/src/lib.rs). */
const FIELDS = [
  'pc', 'priv', 'mstatus', 'mie', 'mip', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'medeleg', 'mideleg',
  'mcounteren', 'stvec', 'sscratch', 'sepc', 'scause', 'stval', 'satp', 'scounteren',
] as const
const WAITING = FIELDS.length
const BREAK_ON_EBREAK = FIELDS.length + 1

/** What the core (hart/, Rust compiled to WebAssembly) exports. */
interface Core {
  memory: WebAssembly.Memory
  init(resetVector: number, flags: number): void
  ram_alloc(base: number, size: number): number
  registers(): number
  reset(pc: number): void
  run(maxSteps: number): number
  step(): void
  stop(): void
  set_interrupt_pending(bit: number, pending: number): void
  instret(): number
  get(field: number): number
  set(field: number, value: number): void
}

let compiled: WebAssembly.Module | undefined
/** The core, compiled once (by npm run build:wasm, from hart/), instantiated per CPU. */
function coreModule(): WebAssembly.Module {
  return (compiled ??= new WebAssembly.Module(readFileSync(new URL('../build/hart.wasm', import.meta.url))))
}

/**
 * RV32IMAC hart with machine, supervisor and user privilege modes (Zicsr,
 * Zifencei) and Sv32 virtual memory.
 *
 * The instruction set is implemented in Rust (hart/), compiled to WebAssembly;
 * each CPU is its own instance of that module. This class connects it to the
 * bus and exposes its state: registers as `x` (an Int32Array view of the
 * core's register file, so writes go straight in) and CSRs as properties.
 */
export class CPU {
  /** x0..x31 (signed; x0 is re-zeroed after every instruction). */
  readonly x: Int32Array
  /** RAM inside the core, if requested in the options. */
  readonly ram: RAM | undefined
  private readonly core: Core

  constructor(
    readonly bus: Bus,
    { resetVector = 0, readTime, breakOnEbreak = false, ram }: CPUOptions = {},
  ) {
    const access = <T>(op: () => T, fault: T): T => {
      try {
        return op()
      } catch (e) {
        if (e instanceof BusError) return fault
        throw e
      }
    }
    const env = {
      // Device accesses (and all memory accesses outside the core's RAM).
      bus_read: (_hart: number, addr: number, width: number) =>
        access(() => {
          addr >>>= 0
          return width === 4 ? bus.read32(addr) >>> 0 : width === 2 ? bus.read16(addr) : bus.read8(addr)
        }, -1),
      bus_write: (_hart: number, addr: number, width: number, value: number) =>
        access(() => {
          addr >>>= 0
          if (width === 4) bus.write32(addr, value >>> 0)
          else if (width === 2) bus.write16(addr, value & 0xffff)
          else bus.write8(addr, value & 0xff)
          return 0
        }, 1),
      read_time: () => readTime?.() ?? 0,
    }
    const instance = new WebAssembly.Instance(coreModule(), { env })
    this.core = instance.exports as unknown as Core
    this.core.init(resetVector >>> 0, (breakOnEbreak ? 1 : 0) | (readTime ? 2 : 0))
    // Allocating RAM grows the core's memory, so views are made afterwards;
    // nothing allocates later, so they stay valid.
    if (ram) {
      const offset = this.core.ram_alloc(ram.base >>> 0, ram.size)
      this.ram = new RAM(new Uint8Array(this.core.memory.buffer, offset, ram.size))
    }
    this.x = new Int32Array(this.core.memory.buffer, this.core.registers(), 32)
  }

  /** Instructions retired (also serves as the cycle counter: 1 IPC). */
  get instret(): number {
    return this.core.instret()
  }

  /** True while stalled in WFI. */
  get waiting(): boolean {
    return this.core.get(WAITING) !== 0
  }

  get breakOnEbreak(): boolean {
    return this.core.get(BREAK_ON_EBREAK) !== 0
  }

  set breakOnEbreak(on: boolean) {
    this.core.set(BREAK_ON_EBREAK, on ? 1 : 0)
  }

  /** Return to the power-on state and start executing at `pc`. */
  reset(pc: number): void {
    this.core.reset(pc >>> 0)
  }

  /** Ask `run()` to return after the current instruction (call it from a device). */
  stop(): void {
    this.core.stop()
  }

  setInterruptPending(bit: number, pending: boolean): void {
    this.core.set_interrupt_pending(bit, pending ? 1 : 0)
  }

  /** Execute up to `maxSteps` steps (instructions or trap entries). */
  run(maxSteps = Infinity): StopReason {
    for (let remaining = maxSteps; ; ) {
      const chunk = Math.min(remaining, 0x4000_0000)
      const reason = STOP_REASONS[this.core.run(chunk)]!
      remaining -= chunk
      if (reason !== 'limit' || remaining <= 0) return reason
    }
  }

  /** Take a pending interrupt, or fetch, decode and execute one instruction. */
  step(): void {
    this.core.step()
  }
}

/** CSR state as properties; values are unsigned (32-bit). */
export interface CPU {
  pc: number
  priv: Priv
  mstatus: number
  mie: number
  /** Pending interrupts. Machine bits are driven by devices via `setInterruptPending()`. */
  mip: number
  mtvec: number
  mscratch: number
  mepc: number
  mcause: number
  mtval: number
  medeleg: number
  mideleg: number
  mcounteren: number
  stvec: number
  sscratch: number
  sepc: number
  scause: number
  stval: number
  satp: number
  scounteren: number
}

FIELDS.forEach((name, field) =>
  Object.defineProperty(CPU.prototype, name, {
    get(this: { core: Core }) {
      return this.core.get(field) >>> 0
    },
    set(this: { core: Core }, value: number) {
      this.core.set(field, value >>> 0)
    },
  }),
)
