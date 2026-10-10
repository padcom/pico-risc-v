import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Compile the C example programs before the test run so tests always exercise
 * fresh toolchain output. Without a RISC-V toolchain, fall back to previously
 * built binaries if they exist.
 */
export default function setup() {
  try {
    execFileSync('make', ['-C', 'examples', '--no-print-directory'], { stdio: 'inherit' })
  } catch (e) {
    if (!existsSync('examples/build/hello.bin')) {
      throw new Error('Building examples failed — is the RISC-V toolchain installed? (brew install riscv64-elf-gcc)', {
        cause: e,
      })
    }
    console.warn('Could not rebuild examples; using existing binaries in examples/build')
  }
}
