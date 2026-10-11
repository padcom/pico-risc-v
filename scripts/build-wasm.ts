/**
 * Compiles the CPU core (hart/, Rust) to build/hart.wasm, which src/cpu.ts
 * loads. Cargo only rebuilds what changed, so this is cheap to run often;
 * build/hart.wasm is only replaced when its contents change.
 *
 * Needs Rust with the wasm32-unknown-unknown target:
 *   brew install rustup && rustup default stable && rustup target add wasm32-unknown-unknown
 * (or the installer from https://rustup.rs). cargo is found on PATH, in
 * ~/.cargo/bin, or in Homebrew's rustup (which isn't linked onto PATH).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'build', 'hart.wasm')

export function buildWasm(): void {
  const extraPath = [join(homedir(), '.cargo', 'bin'), '/opt/homebrew/opt/rustup/bin', '/usr/local/opt/rustup/bin']
  const PATH = [process.env.PATH ?? '', ...extraPath].join(delimiter)
  const cargo = PATH.split(delimiter).map(dir => join(dir, 'cargo')).find(existsSync)
  if (!cargo) {
    throw new Error(
      'cargo not found. Install Rust with the WebAssembly target:\n' +
        '  brew install rustup && rustup default stable && rustup target add wasm32-unknown-unknown',
    )
  }
  execFileSync(
    cargo,
    ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(root, 'hart', 'Cargo.toml')],
    { stdio: 'inherit', env: { ...process.env, PATH } },
  )
  const wasm = readFileSync(join(root, 'hart', 'target', 'wasm32-unknown-unknown', 'release', 'hart.wasm'))
  if (existsSync(output) && readFileSync(output).equals(wasm)) return
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(output, wasm)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildWasm()
