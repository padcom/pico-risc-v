import { Clint } from './clint.js'
import { CPU, type CPUOptions } from './cpu.js'
import { MIP_MEIP } from './csr.js'
import { parseElf } from './elf.js'
import { Syscon } from './syscon.js'
import { SystemBus } from './system-bus.js'
import { Terminal } from './terminal.js'
import { consoleUart, type Uart } from './uart.js'

/**
 * Where things are (the same as on Pico RISC-V's machine, and close to
 * QEMU's `virt` board):
 *
 *   0x1000_0000   UART (16550-style): c/pico.h
 *   0x1100_0000   CLINT: the timer (mtime, mtimecmp: 1 MHz) and msip
 *   0x1110_0000   syscon: exit (0x5555: code 0; code << 16 | 0x3333: code)
 *   0x8000_0000   RAM; a program starts at its entry point (ELF), or at the
 *                 first byte (a flat binary)
 */
export const MemoryMap = {
  UART: 0x1000_0000,
  CLINT: 0x1100_0000,
  SYSCON: 0x1110_0000,
  RAM: 0x8000_0000,
} as const

export interface ComputerOptions {
  /** Where the UART goes (default: consoleUart(), the host's console). */
  uart?: Uart
  /** RAM, in bytes (default 16 MiB). */
  memory?: number
  /** Stop after this many instructions (default: never). */
  maxInstructions?: number
  /** Stops the program (the result's reason: 'aborted'). */
  signal?: AbortSignal
  /** Compile code that runs often to WebAssembly (default true). */
  jit?: boolean
}

export interface RunResult {
  /**
   * Why it stopped: the program exited (through the syscon: main()
   * returned, with c/crt0.S), ran `maxInstructions`, or was stopped
   * (`signal`, stop()).
   */
  reason: 'exit' | 'limit' | 'aborted'
  /** The program's exit code (with reason 'exit'). */
  exitCode: number | undefined
  /** Everything it wrote to the UART, as text (UTF-8). */
  output: string
  /** Instructions it ran. */
  instructions: number
}

/** Instructions in a slice, between which the host gets its turn (I/O). */
const SLICE = 1_000_000
/** Waiting in WFI for the timer or input, look again at least this often (ms). */
const MAX_SLEEP = 50

/** The host's turn: whatever's waiting in its event loop (I/O, timers) runs. */
const yieldToHost = () => new Promise<void>(resolve => ('setImmediate' in globalThis ? setImmediate(resolve) : setTimeout(resolve, 0)))

/**
 * A RISC-V computer for bare-metal programs: one RV64GC hart (machine,
 * supervisor and user modes, Sv39), RAM, a UART, a timer and a way to exit.
 * Load a program, run it; meanwhile the UART is where the Uart says (the
 * console by default), and send() is input for the program.
 *
 * The UART's interrupt, if the program enables it (its IER), is the hart's
 * machine external interrupt (mip.MEIP): there's no PLIC.
 */
export class Computer {
  readonly cpu: CPU
  readonly uart: Terminal
  readonly clint: Clint
  readonly bus = new SystemBus()
  private readonly host: Uart
  private readonly options: ComputerOptions
  private readonly started = performance.now()
  private output = ''
  private readonly decoder = new TextDecoder()
  private exitCode: number | undefined
  private stopped = false
  /** Wakes the computer early from WFI (input came). */
  private wakeUp: (() => void) | undefined

  constructor(options: ComputerOptions = {}) {
    this.options = options
    const { memory = 16 << 20, jit = true } = options
    this.host = options.uart ?? consoleUart()
    const cpuOptions: CPUOptions = {
      resetVector: MemoryMap.RAM,
      readTime: () => this.clint.mtime,
      ram: { base: MemoryMap.RAM, size: memory },
      ...(jit ? {} : { jit: false }),
    }
    this.cpu = CPU.harts(this.bus, 1, cpuOptions)[0]!
    this.uart = new Terminal(
      byte => {
        this.output += this.decoder.decode(Uint8Array.of(byte), { stream: true })
        this.host.write(byte)
      },
      high => this.cpu.setInterruptPending(MIP_MEIP, high),
    )
    this.clint = new Clint(
      () => Math.floor((performance.now() - this.started) * 1000),
      (bit, pending) => this.cpu.setInterruptPending(bit, pending),
    )
    const syscon = new Syscon((_command, exitCode) => {
      this.exitCode = exitCode
      this.cpu.stop()
    })
    this.bus
      .map(MemoryMap.RAM, memory, this.cpu.ram!)
      .map(MemoryMap.UART, Terminal.SIZE, this.uart)
      .map(MemoryMap.CLINT, Clint.SIZE, this.clint)
      .map(MemoryMap.SYSCON, Syscon.SIZE, syscon)
  }

  /**
   * Put a program into RAM: an ELF executable (its segments where it says,
   * which must be in RAM; it starts at its entry point), or a flat binary
   * (at the start of RAM, where it starts).
   */
  load(program: Uint8Array): void {
    const ram = this.cpu.ram!
    ram.bytes.fill(0)
    let entry: number = MemoryMap.RAM
    if (program[0] === 0x7f && program[1] === 0x45 && program[2] === 0x4c && program[3] === 0x46) {
      const elf = parseElf(program)
      if (elf.bits !== 64) throw new Error('a 32-bit ELF file: this is a 64-bit RISC-V (RV64GC)')
      for (const { addr, data, memSize } of elf.segments) {
        if (addr < MemoryMap.RAM || addr + memSize > MemoryMap.RAM + ram.size) {
          throw new RangeError(`a segment at 0x${addr.toString(16)} (${memSize} bytes) outside RAM (0x80000000, ${ram.size} bytes)`)
        }
        ram.load(addr - MemoryMap.RAM, data)
      }
      entry = elf.entry
    } else {
      if (program.length > ram.size) throw new RangeError(`the program (${program.length} bytes) doesn't fit in RAM (${ram.size} bytes)`)
      ram.load(0, program)
    }
    this.cpu.reset(entry)
    this.cpu.setRegister(10, 0) // a0: hart id
    this.cpu.setRegister(11, 0) // a1: no device tree
    this.clint.reset()
    this.uart.reset()
    this.exitCode = undefined
    this.stopped = false
    this.output = ''
  }

  /** Input for the program, which it reads from the UART. */
  send(data: string | ArrayLike<number>): void {
    this.uart.type(data)
    this.wakeUp?.()
  }

  /** Stop the program (run()'s reason: 'aborted'). */
  stop(): void {
    this.stopped = true
    this.cpu.stop()
    this.wakeUp?.()
  }

  /** Run the loaded program until it exits, or is stopped. */
  async run(): Promise<RunResult> {
    const { maxInstructions = Infinity, signal } = this.options
    const abort = () => this.stop()
    signal?.addEventListener('abort', abort)
    if (signal?.aborted) this.stop()
    this.host.attach?.(data => this.send(data))
    try {
      const start = this.cpu.instret
      const result = (reason: RunResult['reason']): RunResult => ({
        reason,
        exitCode: reason === 'exit' ? this.exitCode : undefined,
        output: this.output + this.decoder.decode(),
        instructions: this.cpu.instret - start,
      })
      for (;;) {
        if (this.stopped) return result('aborted')
        const left = maxInstructions - (this.cpu.instret - start)
        if (left <= 0) return result('limit')
        this.clint.update()
        const stop = this.cpu.run(Math.min(SLICE, left))
        if (this.exitCode !== undefined) return result('exit')
        if (stop === 'breakpoint') throw new Error(`a breakpoint (EBREAK) at 0x${this.cpu.pc.toString(16)}`)
        if (stop === 'wfi') await this.sleep()
        else await yieldToHost()
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.host.close?.()
    }
  }

  /** Waiting for an interrupt: until the timer's next one, input, or MAX_SLEEP. */
  private async sleep(): Promise<void> {
    this.clint.update()
    if (this.cpu.mip & this.cpu.mie) return yieldToHost()
    const timer = (this.clint.timecmp(0) - this.clint.mtime) / 1000
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, Math.max(0, Math.min(MAX_SLEEP, timer)))
      this.wakeUp = () => {
        clearTimeout(timeout)
        resolve()
      }
    })
    this.wakeUp = undefined
  }
}

/**
 * Run a program (an ELF executable, or a flat binary) until it exits: what
 * it wrote to the UART goes to the console (or `options.uart`), and the
 * result says how it ended. See Computer for the machine it runs on.
 *
 *   const { exitCode, output } = await run(readFileSync('hello.elf'))
 */
export async function run(program: Uint8Array, options: ComputerOptions = {}): Promise<RunResult> {
  const computer = new Computer(options)
  computer.load(program)
  return computer.run()
}
