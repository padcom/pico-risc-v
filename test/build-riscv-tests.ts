import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Build the riscv-tests suites src/riscv-tests.test.ts runs (vendor/riscv-tests,
 * a git submodule) into build/riscv-tests/64/, with the same GNU toolchain
 * as the examples. make only rebuilds what changed. Without the submodule or
 * the toolchain, the tests are skipped.
 */
const SUITES = ['ui', 'um', 'ua', 'uf', 'ud', 'uc', 'si', 'mi']

export default function setup() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const isa = `${root}vendor/riscv-tests/isa`
  if (!existsSync(`${isa}/Makefile`) || !existsSync(`${root}vendor/riscv-tests/env/encoding.h`)) {
    console.warn('riscv-tests not checked out (git submodule update --init --recursive vendor/riscv-tests); skipping them')
    return
  }
  const out = `${root}build/riscv-tests/64`
  mkdirSync(out, { recursive: true })
  try {
    execFileSync('make', [
      '-s', '-j8', '-C', out, '-f', `${isa}/Makefile`,
      `src_dir=${isa}`,
      'XLEN=64',
      'RISCV_PREFIX=riscv64-elf-',
      // The bare-metal toolchain has no C library: env/v gets stand-ins for
      // the few headers it includes.
      `RISCV_GCC_OPTS=-static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles -ffreestanding -I${root}test/riscv-tests/include -Wl,--no-warn-rwx-segments`,
      ...SUITES.map(suite => `rv64${suite}`),
    ], { stdio: 'inherit' })
  } catch (e) {
    console.warn("Could not build riscv-tests (is riscv64-elf-gcc installed?); using what's there", e)
  }
}
