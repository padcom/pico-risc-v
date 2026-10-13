/**
 * A thread running one hart (machine.ts: runThreaded). It instantiates the
 * core on the machine's shared memory, with a stack of its own, and runs
 * the hart: its RAM accesses happen right here; device accesses go to the
 * main thread, where the devices are, through a mailbox in `control` (the
 * layout is machine.ts's, see Control there). All but the CLINT's, which
 * OpenSBI uses all the time (timers, inter-processor interrupts): its state
 * is shared too (clint.ts), and the thread handles those itself, keeping
 * its hart's timer interrupt up to date.
 *
 * The main thread wakes it from WFI by bumping its wake counter, and stops
 * it by terminating it.
 *
 * In Node a worker_threads Worker (its workerData: HartThreadData), in a
 * browser a module Worker (its first message). Self-contained: it's run from
 * TypeScript sources too, where imports of other files of the project
 * wouldn't resolve.
 */

export interface HartThreadData {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  /** The hart (as hart_new returned it), its index, and the top of its stack. */
  hart: number
  index: number
  stackTop: number
  jit: false | { threshold: number; batch: number }
  /** The JIT's table for this thread's instance (with jit). */
  table: number
  /** Int32Array of Control. */
  control: SharedArrayBuffer
  /** Float64Array: the realtime clock's epoch (ms, absolute), mtime's offset from it (µs). */
  clock: SharedArrayBuffer
  /** Also post a message when ringing the doorbell (for a main thread without Atomics.waitAsync). */
  ring: boolean
  /** The CLINT: where it is, its state (Clint.state), and every hart (as hart_new returned them). */
  clint: { base: number; state: SharedArrayBuffer; harts: number[] }
}

// Control (machine.ts): the doorbell, then a box of BOX words per hart.
const DOORBELL = 0
const BOX = 16
const STATE = 0 // 0 idle, 1 request (from here), 2 answered (by the main thread)
const OP = 1 // 0 read, 1 write
const ADDR = 2
const WIDTH = 3
const VALUE = 4
const RESULT = 5
const FAULT = 6
const WAKE = 7
const EVENT = 8 // why the hart stopped: run()'s code

/** Steps per run(): how often the loop looks at anything else. */
const BUDGET = 100_000
/** run()'s codes (the core's hart.rs). */
const LIMIT = 0
const WFI = 1
/** At most this long in WFI without looking again (ms). */
const WFI_WAIT = 50
// The CLINT (clint.ts): its registers, the interrupts it raises.
const CLINT_SIZE = 0x10000
const MTIMECMP = 0x4000
const MTIME = 0xbff8
const MIP_MSIP = 1 << 3
const MIP_MTIP = 1 << 7
const TWO_32 = 0x1_0000_0000

interface Core {
  run(hart: number, maxSteps: number): number
  set_interrupt_pending(hart: number, bit: number, pending: number): void
  jit_slots(): number
  jit_init(hart: number, table: number, tableBase: number, threshold: number, batch: number): void
  jit_op(hart: number, a: bigint, b: bigint, pc: bigint): number
  __indirect_function_table: WebAssembly.Table
  __stack_pointer: WebAssembly.Global
}

const node = typeof process !== 'undefined' && process.versions?.node !== undefined
if (node) {
  const { workerData, parentPort } = await import('node:worker_threads')
  start(workerData as HartThreadData, message => parentPort!.postMessage(message))
} else {
  const scope = globalThis as unknown as { onmessage: (e: MessageEvent) => void; postMessage(message: unknown): void }
  scope.onmessage = ({ data }) => start(data as HartThreadData, message => scope.postMessage(message))
}

function start(data: HartThreadData, post: (message: unknown) => void): never {
  const control = new Int32Array(data.control)
  const clock = new Float64Array(data.clock)
  const box = BOX * (data.index + 1)

  /** Tell the main thread there's something for it. */
  function ring() {
    Atomics.add(control, DOORBELL, 1)
    Atomics.notify(control, DOORBELL)
    if (data.ring) post(0)
  }

  // The CLINT: msip of each hart, then mtimecmp of each (low, high).
  const clint = new Uint32Array(data.clint.state)
  const harts = data.clint.harts
  const mtime = () => Math.floor((performance.timeOrigin + performance.now() - clock[0]!) * 1000) + clock[1]!
  const timecmp = (hart: number) => clint[harts.length + 2 * hart + 1]! * TWO_32 + clint[harts.length + 2 * hart]!
  /** Wake a hart's thread, in case it waits in WFI. */
  const wake = (hart: number) => {
    Atomics.add(control, BOX * (hart + 1) + WAKE, 1)
    Atomics.notify(control, BOX * (hart + 1) + WAKE)
  }
  /** This hart's timer interrupt, as it is now (unknown at first). */
  let timerPending: boolean | undefined
  const updateTimer = () => {
    const due = mtime() >= timecmp(data.index)
    if (due !== timerPending) core.set_interrupt_pending(data.hart, MIP_MTIP, due ? 1 : 0)
    timerPending = due
  }

  /** A 32-bit read of the CLINT, at `offset`. */
  function clintRead(offset: number): number {
    if (offset < 4 * harts.length) return clint[offset >>> 2]!
    const cmp = offset - MTIMECMP
    if (cmp >= 0 && cmp < 8 * harts.length) return clint[harts.length + (cmp >>> 2)]!
    if (offset === MTIME) return mtime() % TWO_32
    if (offset === MTIME + 4) return Math.floor(mtime() / TWO_32)
    return 0
  }

  /** A 32-bit write to the CLINT, at `offset`. */
  function clintWrite(offset: number, value: number): void {
    value >>>= 0
    if (offset < 4 * harts.length) {
      const hart = offset >>> 2
      clint[hart] = value & 1
      core.set_interrupt_pending(harts[hart]!, MIP_MSIP, value & 1)
      if (value & 1) wake(hart)
      return
    }
    const cmp = offset - MTIMECMP
    if (cmp >= 0 && cmp < 8 * harts.length) {
      clint[harts.length + (cmp >>> 2)] = value
      const hart = cmp >>> 3
      if (hart === data.index) updateTimer()
      else wake(hart) // (its thread looks at its timer)
    } else if (offset === MTIME) {
      clock[1] = clock[1]! + Math.floor(mtime() / TWO_32) * TWO_32 + value - mtime()
    } else if (offset === MTIME + 4) {
      clock[1] = clock[1]! + value * TWO_32 + (mtime() % TWO_32) - mtime()
    }
  }
  const inClint = (addr: number, width: number) => width === 4 && addr - data.clint.base >= 0 && addr - data.clint.base < CLINT_SIZE

  /** A device access, by the main thread; the value read, or -1 on a bus error. */
  function device(op: number, addr: number, width: number, value: number): number {
    control[box + OP] = op
    control[box + ADDR] = addr
    control[box + WIDTH] = width
    control[box + VALUE] = value
    Atomics.store(control, box + STATE, 1)
    ring()
    while (Atomics.load(control, box + STATE) === 1) Atomics.wait(control, box + STATE, 1)
    const result = control[box + FAULT] ? -1 : control[box + RESULT]! >>> 0
    Atomics.store(control, box + STATE, 0)
    return result
  }

  const { memory } = data
  let jitModule = new Uint8Array()
  const env = {
    memory,
    bus_read: (_hart: number, addr: number, width: number) =>
      inClint(addr >>> 0, width) ? clintRead((addr >>> 0) - data.clint.base) : device(0, addr >>> 0, width, 0),
    bus_write: (_hart: number, addr: number, width: number, value: number) => {
      if (!inClint(addr >>> 0, width)) return device(1, addr >>> 0, width, value) < 0 ? 1 : 0
      clintWrite((addr >>> 0) - data.clint.base, value)
      return 0
    },
    // mtime, as the main thread's CLINT has it (machine.ts: now()).
    read_time: mtime,
    // As in cpu.ts: compiled pages (this thread's, or other threads' from
    // the core's log), into this instance's function table.
    jit_load: (code: number, length: number) => {
      jitModule = new Uint8Array(memory.buffer, code, length).slice()
    },
    jit_install: (slots: number, count: number) => {
      const { exports } = new WebAssembly.Instance(new WebAssembly.Module(jitModule), { env: { memory, table, op: core.jit_op } })
      const at = new Uint32Array(memory.buffer, slots, count)
      for (let i = 0; i < count; i++) table.set(at[i]!, exports[i] as () => void)
      return 1
    },
  }
  const core = new WebAssembly.Instance(data.module, { env }).exports as unknown as Core
  const table = core.__indirect_function_table
  core.__stack_pointer.value = data.stackTop
  if (data.jit) core.jit_init(data.hart, data.table, table.grow(core.jit_slots()), data.jit.threshold, data.jit.batch)

  for (;;) {
    // (Read before running: a wake-up while it runs isn't missed.)
    const woken = Atomics.load(control, box + WAKE)
    updateTimer()
    const reason = core.run(data.hart, BUDGET)
    if (reason === LIMIT) continue
    if (reason === WFI) {
      // Until woken, or the timer is due.
      Atomics.wait(control, box + WAKE, woken, Math.max(0, Math.min(WFI_WAIT, (timecmp(data.index) - mtime()) / 1000)))
      continue
    }
    // A breakpoint, or stopped: tell the main thread, and wait to be terminated.
    Atomics.store(control, box + EVENT, reason)
    ring()
    for (;;) Atomics.wait(control, box + WAKE, Atomics.load(control, box + WAKE))
  }
}
