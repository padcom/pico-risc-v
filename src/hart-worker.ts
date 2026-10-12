/**
 * A thread running one hart (machine.ts: runThreaded). It instantiates the
 * core on the machine's shared memory, with a stack of its own, and runs
 * the hart: its RAM accesses happen right here; device accesses go to the
 * main thread, where the devices are, through a mailbox in `control` (the
 * layout is machine.ts's, see Control there).
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
  /** Int32Array of Control. */
  control: SharedArrayBuffer
  /** Float64Array: the realtime clock's epoch (ms, absolute), mtime's offset from it (µs). */
  clock: SharedArrayBuffer
  /** Also post a message when ringing the doorbell (for a main thread without Atomics.waitAsync). */
  ring: boolean
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

interface Core {
  run(hart: number, maxSteps: number): number
  jit_slots(): number
  jit_init(hart: number, tableBase: number, threshold: number, batch: number): void
  jit_op(hart: number, index: number, pc: bigint): number
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
  const env = {
    memory,
    bus_read: (_hart: number, addr: number, width: number) => device(0, addr >>> 0, width, 0),
    bus_write: (_hart: number, addr: number, width: number, value: number) => (device(1, addr >>> 0, width, value) < 0 ? 1 : 0),
    // mtime, as the main thread's CLINT has it (machine.ts: now()).
    read_time: () => Math.floor((performance.timeOrigin + performance.now() - clock[0]!) * 1000) + clock[1]!,
    // As in cpu.ts: compiled pages, into this instance's function table.
    jit_install: (code: number, length: number, slots: number, count: number) => {
      const module = new WebAssembly.Module(new Uint8Array(memory.buffer, code, length))
      const { exports } = new WebAssembly.Instance(module, { env: { memory, table, op: core.jit_op } })
      const at = new Uint32Array(memory.buffer, slots, count)
      for (let i = 0; i < count; i++) table.set(at[i]!, exports[i] as () => void)
      return 1
    },
  }
  const core = new WebAssembly.Instance(data.module, { env }).exports as unknown as Core
  const table = core.__indirect_function_table
  core.__stack_pointer.value = data.stackTop
  if (data.jit) core.jit_init(data.hart, table.grow(core.jit_slots()), data.jit.threshold, data.jit.batch)

  for (;;) {
    // (Read before running: a wake-up while it runs isn't missed.)
    const wake = Atomics.load(control, box + WAKE)
    const reason = core.run(data.hart, BUDGET)
    if (reason === LIMIT) continue
    if (reason === WFI) {
      Atomics.wait(control, box + WAKE, wake, WFI_WAIT)
      continue
    }
    // A breakpoint, or stopped: tell the main thread, and wait to be terminated.
    Atomics.store(control, box + EVENT, reason)
    ring()
    for (;;) Atomics.wait(control, box + WAKE, Atomics.load(control, box + WAKE))
  }
}
