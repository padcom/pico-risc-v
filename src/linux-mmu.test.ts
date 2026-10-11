import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LinuxSession } from '../test/linux-session.js'

const FIRMWARE = new URL('../images/linux-mmu/fw_dynamic.bin', import.meta.url)
const KERNEL = new URL('../images/linux-mmu/Image', import.meta.url)

/**
 * Boots the regular (MMU) Linux image built by `npm run linux:build`: OpenSBI
 * in M-mode, the kernel in S-mode with Sv32 paging, glibc user space in U-mode.
 */
describe.skipIf(!existsSync(FIRMWARE) || !existsSync(KERNEL))('Linux with MMU (OpenSBI + Sv32)', () => {
  it('boots, runs programs including Midnight Commander, and powers off', { timeout: 600_000 }, () => {
    const s = new LinuxSession(
      [readFileSync(FIRMWARE), { load: [{ offset: 0x400000, data: readFileSync(KERNEL) }], next: { offset: 0x400000 } }],
      { ramSize: 256 * 1024 * 1024 },
    )

    s.waitFor('login: ', 3_000_000_000)
    expect(s.screen).toContain('OpenSBI')
    expect(s.screen).toMatch(/Linux version \d+\.\d+/)

    s.type('root\n')
    s.waitFor('# ')
    s.type('grep -E "^(isa|mmu)" /proc/cpuinfo; echo "done-$((40+2))"\n')
    s.waitFor('done-42')
    expect(s.screen).toMatch(/mmu\s*:\s*sv32/)

    s.type('hello from-mmu\n')
    s.waitFor('argv[1] = from-mmu')
    expect(s.screen).toMatch(/Hello from Linux \S+ on riscv32!/)

    // Midnight Commander: wait for its menu bar, then quit with F10.
    s.type('mc\n')
    s.waitFor('Command', 2_000_000_000)
    s.type('\x1b[21~')
    s.waitFor('# ', 2_000_000_000)

    s.type('exit\n')
    expect(s.runToPowerOff()).toBe('poweroff')
  })
})
