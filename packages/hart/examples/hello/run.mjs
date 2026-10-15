// Runs hello.elf with its UART on this terminal: what it writes shows up
// here, what you type goes to it. Then its exit code.
//
//   node run.mjs
import { readFileSync } from 'node:fs'
import { consoleUart, run } from '@padcom/pico-risc-v-hart'

const program = readFileSync(new URL('hello.elf', import.meta.url))
const { exitCode, instructions } = await run(program, { uart: consoleUart({ input: true }) })
console.log(`[hello.elf exited with code ${exitCode}, after ${instructions} instructions]`)
