/**
 * @padcom/pico-risc-v-hart: a RISC-V (RV64GC) computer for bare-metal
 * programs. run() a program and get its exit code and output; its UART goes
 * where you say (the console by default, captured, both, your own).
 */
export { Computer, MemoryMap, run, type ComputerOptions, type RunResult } from './computer.js'
export { both, captureUart, consoleUart, type CapturedUart, type CaptureUartOptions, type ConsoleUartOptions, type Uart } from './uart.js'
export { parseElf, type Elf } from './elf.js'

// The building blocks, for machines of your own (Pico RISC-V's Linux one is).
export { CPU, setCoreModule, type CPUOptions, type StopReason } from './cpu.js'
export { type Bus, BusError, WordDevice } from './bus.js'
export { RAM } from './ram.js'
export { SystemBus } from './system-bus.js'
export * from './csr.js'
export * from './trap.js'
export { Terminal } from './terminal.js'
export { Clint } from './clint.js'
export { Syscon } from './syscon.js'
/** A small RISC-V assembler (for tests, and programs written in TypeScript). */
export { asm, toBytes, toCode } from './asm.js'
