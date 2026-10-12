import { readFileSync } from 'node:fs'
import { setFlagsFromString } from 'node:v8'
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
  /** Source for the `time` CSR (normally the CLINT's mtime). Without one it is illegal. */
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
  /**
   * The JIT (hart/src/jit.rs; needs `ram`): pages of code that have run
   * `threshold` instructions are compiled to WebAssembly, `batch` of them
   * at a time. On by default; false turns it off.
   */
  jit?: false | { threshold?: number; batch?: number }
}

const JIT_DEFAULTS = { threshold: 2000, batch: 32 }

/** CPU state readable and writable as properties, in the core's field order (hart/src/lib.rs). */
const FIELDS = [
  'pc', 'priv', 'mstatus', 'mie', 'mip', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'medeleg', 'mideleg',
  'mcounteren', 'stvec', 'sscratch', 'sepc', 'scause', 'stval', 'satp', 'scounteren',
] as const
type Field = (typeof FIELDS)[number]
const WAITING = FIELDS.length
const BREAK_ON_EBREAK = FIELDS.length + 1

/** What the core (hart/, Rust compiled to WebAssembly) exports. */
interface Core {
  memory: WebAssembly.Memory
  // (64-bit values arrive as signed bigints: WebAssembly's i64.)
  init(resetVector: bigint, flags: number): void
  ram_alloc(base: number, size: number): number
  registers(): number
  fp_registers(): number
  reset(pc: bigint): void
  code_written(pa: bigint, length: number): void
  run(maxSteps: number): number
  step(): void
  stop(): void
  set_interrupt_pending(bit: number, pending: number): void
  instret(): number
  jit_slots(): number
  jit_init(tableBase: number, threshold: number, batch: number): void
  jit_op(index: number, pc: bigint): number
  __indirect_function_table: WebAssembly.Table
  get(field: number): bigint
  set(field: number, value: bigint): void
}

/** A number or bigint as the 64-bit pattern the core takes (negative numbers two's complement). */
const u64 = (value: number | bigint) => BigInt.asUintN(64, typeof value === 'bigint' ? value : BigInt(Math.trunc(value)))

let compiled: WebAssembly.Module | undefined
/** The core, compiled once (by npm run build:wasm, from hart/), instantiated per CPU. */
function coreModule(): WebAssembly.Module {
  return (compiled ??= new WebAssembly.Module(readFileSync(new URL('../build/hart.wasm', import.meta.url))))
}

/**
 * RV64GC hart (IMAFDC, Zicsr, Zifencei) with machine, supervisor and user
 * privilege modes and virtual memory (Sv39).
 *
 * The instruction set is implemented in Rust (hart/), compiled to WebAssembly;
 * each CPU is its own instance of that module. This class connects it to the
 * bus and exposes its state: registers as `x64` (a view of the core's register
 * file, so writes go straight in) and, for 32-bit values, `x`; CSRs as
 * properties, or exactly with `read()` / `write()`.
 */
export class CPU {
  /** x0..x31, all 64 bits; x0 is re-zeroed after every instruction. */
  readonly x64: BigInt64Array
  /**
   * x0..x31's low halves as signed 32-bit numbers, for 32-bit values: writes
   * sign-extend them, as RV64 keeps 32-bit values (use x64 or setRegister for
   * more).
   */
  readonly x: Int32Array
  /** f0..f31, raw bits (single-precision values NaN-boxed: upper 32 bits all ones). */
  readonly f: BigUint64Array
  /** RAM inside the core, if requested in the options. */
  readonly ram: RAM | undefined
  private readonly core: Core

  constructor(
    readonly bus: Bus,
    { resetVector = 0, readTime, breakOnEbreak = false, ram, jit = {} }: CPUOptions = {},
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
      // Compiled pages: a module of functions "0", "1", ... (`count` of
      // them), for the function table at `slots` (the core's jit.rs). They
      // call each other through the table.
      jit_install: (code: number, length: number, slots: number, count: number) => {
        const { memory, jit_op, __indirect_function_table: table } = this.core
        const module = new WebAssembly.Module(new Uint8Array(memory.buffer, code, length))
        const { exports } = new WebAssembly.Instance(module, { env: { memory, table, op: jit_op } })
        const at = new Uint32Array(memory.buffer, slots, count)
        for (let i = 0; i < count; i++) table.set(at[i]!, exports[i] as () => void)
        return 1
      },
    }
    const instance = new WebAssembly.Instance(coreModule(), { env })
    this.core = instance.exports as unknown as Core
    this.core.init(u64(resetVector), (breakOnEbreak ? 1 : 0) | (readTime ? 2 : 0))
    // Allocating RAM grows the core's memory, so views are made afterwards;
    // nothing allocates later, so they stay valid.
    if (ram) {
      const offset = this.core.ram_alloc(ram.base >>> 0, ram.size)
      this.ram = new RAM(new Uint8Array(this.core.memory.buffer, offset, ram.size))
      if (jit) {
        // V8 first compiles WebAssembly quickly, then optimizes a function
        // once it has run "13 MB" of code; the JIT makes thousands of small
        // functions, which run hot right away: optimize them much sooner.
        setFlagsFromString('--wasm-tiering-budget=20000')
        const { threshold, batch } = { ...JIT_DEFAULTS, ...jit }
        const base = this.core.__indirect_function_table.grow(this.core.jit_slots())
        this.core.jit_init(base, threshold, batch)
      }
    }
    this.x64 = new BigInt64Array(this.core.memory.buffer, this.core.registers(), 32)
    this.f = new BigUint64Array(this.core.memory.buffer, this.core.fp_registers(), 32)
    this.x = lowHalves(new Int32Array(this.core.memory.buffer, this.core.registers(), 64))
  }

  /**
   * Set a register to a number: negative ones are sign-extended, others
   * zero-extended (an address such as 0x8000_0000 stays one).
   */
  setRegister(index: number, value: number | bigint): void {
    this.x64[index] = BigInt.asIntN(64, u64(value))
  }

  /** A CSR (or the pc) exactly, as an unsigned bigint. */
  read(field: Field): bigint {
    return BigInt.asUintN(64, this.core.get(FIELDS.indexOf(field)))
  }

  write(field: Field, value: number | bigint): void {
    this.core.set(FIELDS.indexOf(field), u64(value))
  }

  /** Instructions retired (also serves as the cycle counter: 1 IPC). */
  get instret(): number {
    return this.core.instret()
  }

  /** True while stalled in WFI. */
  get waiting(): boolean {
    return this.core.get(WAITING) !== 0n
  }

  get breakOnEbreak(): boolean {
    return this.core.get(BREAK_ON_EBREAK) !== 0n
  }

  set breakOnEbreak(on: boolean) {
    this.core.set(BREAK_ON_EBREAK, on ? 1n : 0n)
  }

  /** Return to the power-on state and start executing at `pc`. */
  reset(pc: number): void {
    this.core.reset(u64(pc))
  }

  /**
   * RAM at physical `addr..addr + length` has been (or may be) written other
   * than by the CPU, e.g. by a device's DMA: decoded instructions from there
   * are discarded. (Not needed before reset(), which discards them all.)
   */
  codeWritten(addr: number, length: number): void {
    this.core.code_written(u64(addr), length)
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

/**
 * CSR state as properties: unsigned numbers (rounded above 2^53, such as
 * kernel addresses; read() and write() are exact).
 */
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
      return Number(BigInt.asUintN(64, this.core.get(field)))
    },
    set(this: { core: Core }, value: number) {
      this.core.set(field, u64(value))
    },
  }),
)

/**
 * The registers' low 32 bits, as an Int32Array-like view of a 64-bit register
 * file (`words` holds them as 32-bit pairs, low half first). Writes
 * sign-extend into the upper half.
 */
function lowHalves(words: Int32Array): Int32Array {
  const snapshot = () => Int32Array.from({ length: 32 }, (_, i) => words[2 * i]!)
  const index = (key: string | symbol) => (typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : -1)
  return new Proxy(new Int32Array(32), {
    get(_, key) {
      const i = index(key)
      if (i >= 0) return words[2 * i]
      // Anything else (length, slice, iteration, ...) on a copy.
      const copy = snapshot()
      const value = Reflect.get(copy, key)
      return typeof value === 'function' ? value.bind(copy) : value
    },
    set(_, key, value: number) {
      const i = index(key)
      if (i < 0 || i >= 32) return false
      const low = value | 0
      words[2 * i] = low
      words[2 * i + 1] = low >> 31
      return true
    },
  })
}
