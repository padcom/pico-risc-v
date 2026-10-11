import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseElf } from '../test/elf.js'
import { Machine, MemoryMap } from './machine.js'

/**
 * The official RISC-V ISA tests (github.com/riscv-software-src/riscv-tests,
 * vendor/riscv-tests), built by test/build-riscv-tests.ts into
 * build/riscv-tests/<xlen>/:
 *
 *   rv<xlen>ui/um/ua/uc  user-level instructions: base, multiply, atomics, compressed
 *   rv<xlen>si/mi        supervisor- and machine-mode behaviour
 *
 * Each comes as -p- (physical memory, M-mode) and -v- (the same test in
 * U-mode, under virtual memory: Sv32 or Sv39 page tables set up by the test
 * environment). A program reports by writing to its `tohost` word: 1 means
 * passed, any other odd value (n << 1) | 1 that test case n failed.
 */
const BUILD = new URL('../build/riscv-tests/', import.meta.url)

/** Tests of things this emulator deliberately doesn't do, with why. */
const NO_PMP = 'needs PMP entries; there are none (the spec allows zero: the PMP CSRs read as 0)'
const UNSUPPORTED: Record<string, string> = {
  'rv32mi-p-pmpaddr': NO_PMP,
  'rv64mi-p-pmpaddr': NO_PMP,
}

function runTest(file: URL, xlen: 32 | 64): number {
  const elf = parseElf(readFileSync(file))
  const m = new Machine({ ramSize: 16 * 1024 * 1024, clock: 'virtual', xlen })
  const end = Math.max(...elf.segments.map(s => s.addr + s.memSize))
  const image = new Uint8Array(end - MemoryMap.RAM)
  for (const s of elf.segments) image.set(s.data, s.addr - MemoryMap.RAM)
  m.boot(image)
  const tohost = elf.symbols.get('tohost')! - MemoryMap.RAM
  for (let steps = 0; steps < 20_000_000; steps += 10_000) {
    const result = m.run(10_000)
    const value = m.ram.read32(tohost)
    if (value !== 0) return value
    if (result !== 'limit' && result !== 'idle') throw new Error(`stopped: ${result} at pc 0x${m.cpu.pc.toString(16)}`)
  }
  throw new Error('no result')
}

for (const xlen of [32, 64] as const) {
  const dir = new URL(`${xlen}/`, BUILD)
  const tests = existsSync(dir) ? readdirSync(dir).filter(f => !f.endsWith('.dump')).sort() : []
  describe.skipIf(!tests.length)(`riscv-tests RV${xlen}`, () => {
    it.each(tests.filter(name => !UNSUPPORTED[name]))('%s', name => {
      const result = runTest(new URL(name, dir), xlen)
      expect(result === 1 ? 'pass' : `failed test case ${result >>> 1} (tohost=0x${result.toString(16)})`).toBe('pass')
    })
  })
}
