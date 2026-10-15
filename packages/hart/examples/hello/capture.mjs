// Runs hello.elf with its UART captured: watches what it writes as it writes
// it, answers its question, and gets the whole conversation at the end.
//
//   node capture.mjs [name]
import { readFileSync } from 'node:fs'
import { captureUart, run } from '@padcom/pico-risc-v-hart'

const name = process.argv[2] ?? 'Ada'
let asked = false
const uart = captureUart({
  onText: text => {
    process.stdout.write(text) // (as it comes, a character at a time)
    if (!asked && uart.text.endsWith('? ')) {
      asked = true
      uart.send(`${name}\r`) // (typed, then Enter)
    }
  },
})
const { exitCode, output } = await run(readFileSync(new URL('hello.elf', import.meta.url)), { uart })
console.log(`[exit code ${exitCode}; it wrote ${output.length} characters, all in result.output too]`)
