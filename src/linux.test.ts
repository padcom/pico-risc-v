import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Machine } from './machine.js'

const IMAGE = new URL('../images/linux/Image', import.meta.url)

/**
 * Boots the Linux image (`npm run linux:image` downloads it, `npm run linux:build` builds it),
 * logs in, runs a command and powers off. Uses the virtual clock, so the run
 * is deterministic and idle time costs nothing.
 */
describe.skipIf(!existsSync(IMAGE))('Linux (mini-rv32ima nommu kernel)', () => {
  it('boots to a shell, runs commands and powers off', { timeout: 120_000 }, () => {
    let screen = ''
    const machine = new Machine({ clock: 'virtual', output: b => (screen += String.fromCharCode(b)) })
    machine.boot(readFileSync(IMAGE))

    /** Run until `text` shows up on the screen (after the current end of output). */
    const waitFor = (text: string, budget = 200_000_000) => {
      const from = screen.length
      const end = machine.cpu.instret + budget
      while (!screen.includes(text, from)) {
        const result = machine.run(100_000)
        if (result !== 'limit') throw new Error(`machine stopped (${result}) waiting for ${JSON.stringify(text)}`)
        if (machine.cpu.instret > end) throw new Error(`timed out waiting for ${JSON.stringify(text)}:\n${screen}`)
      }
    }

    waitFor('login: ')
    expect(screen).toMatch(/Linux version \d+\.\d+/) // prebuilt: 6.1.14; built from source: 6.8-rc1
    expect(screen).toContain('riscv: base ISA extensions aim')
    expect(screen).toContain('ttyS0 at MMIO 0x10000000')

    machine.terminal.type('root\n')
    waitFor('# ')
    machine.terminal.type('echo "$(uname -m) says $((6*7))"\n')
    waitFor('riscv32 says 42')

    // Images built from source (npm run linux:build) contain linux/programs/hello.
    machine.terminal.type('if [ -x /usr/local/bin/hello ]; then hello from-test; else echo "(no hello)"; fi; echo "done-$((40+2))"\n')
    waitFor('done-42')
    expect(screen).toMatch(/Hello from Linux \S+ on riscv32!\r\n  argv\[1\] = from-test|\(no hello\)\r\n/)

    machine.terminal.type('poweroff\n')
    let result
    do result = machine.run(1_000_000)
    while (result === 'limit' && machine.cpu.instret < 1e9)
    expect(result).toBe('poweroff')
    expect(screen).toContain('reboot: Power down')
  })
})
