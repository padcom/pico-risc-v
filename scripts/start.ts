/**
 * `npm start`: boot Debian in the emulator, interactively, building whatever
 * is out of date first.
 *
 *   node scripts/start.ts [emulator options, e.g. --snapshot]
 *
 * 1. The emulator: its CPU core (hart/, Rust → build/hart.wasm; cargo
 *    rebuilds only on changes), and dist/ when any src/ file is newer.
 * 2. Debian (linux/debian/build.sh → images/debian/), when it's missing or
 *    linux/debian/ changed (see linux/inputs-hash.sh). The build makes
 *    pristine.raw, the disk as built; the disk you use, disk.raw, starts as a
 *    copy of it. A rebuild replaces disk.raw too, keeping the old one as
 *    disk.raw.bak.
 * 3. Boot: OpenSBI at the start of RAM, U-Boot 2 MiB later; U-Boot starts
 *    GRUB from the disk, GRUB Debian's kernel. eth0 on the user-mode network,
 *    with localhost:2222 forwarded to Debian's port 22 (ssh).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { buildWasm } from './build-wasm.ts'

const DIR = 'images/debian'
const FILES = ['fw_dynamic.bin', 'u-boot.bin', 'pristine.raw']
// Port 2222 on this machine is Debian's port 22: ssh -p 2222 root@localhost
// once openssh-server is installed in Debian (and you can log in: see linux/README.md).
const ARGS = [
  '--memory', '1024',
  '--kernel', `${DIR}/u-boot.bin`,
  '--disk', `${DIR}/disk.raw`,
  '--net', '--forward', '2222:22',
  `${DIR}/fw_dynamic.bin`,
]

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' })

// 1. The emulator.
buildWasm()
if (emulatorStale()) {
  console.log('[start] compiling the emulator')
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'])
}

// 2. Debian.
const reason = imageStale()
if (reason) {
  console.log(`[start] ${reason}: building it (linux/debian/build.sh)`)
  run('bash', ['linux/debian/build.sh'])
  if (existsSync(`${DIR}/disk.raw`)) {
    // Moved, not copied: instant, and the (sparse) file stays sparse.
    renameSync(`${DIR}/disk.raw`, `${DIR}/disk.raw.bak`)
    console.log(`[start] a new ${DIR}/disk.raw replaces yours; the old one is kept as disk.raw.bak`)
  }
}
if (!existsSync(`${DIR}/disk.raw`)) {
  // A sparse copy: on macOS a clone (instant, shares the unchanged blocks).
  run('cp', process.platform === 'darwin' ? ['-c', `${DIR}/pristine.raw`, `${DIR}/disk.raw`] : ['--sparse=always', `${DIR}/pristine.raw`, `${DIR}/disk.raw`])
}

// 3. Boot.
const { status } = spawnSync(process.execPath, ['dist/cli.js', ...ARGS, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(status ?? 1)

/** dist/ is missing or older than some source file. */
function emulatorStale(): boolean {
  if (!existsSync('dist/cli.js')) return true
  const built = statSync('dist/cli.js').mtimeMs
  return readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .some(f => statSync(`src/${f}`).mtimeMs > built)
}

/** Why Debian needs (re)building, or undefined if it's up to date. */
function imageStale(): string | undefined {
  if (!FILES.every(f => existsSync(`${DIR}/${f}`))) return 'Debian is not set up yet'
  const hashFile = `${DIR}/.inputs-hash`
  const built = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
  const now = execFileSync('bash', ['linux/inputs-hash.sh'], { encoding: 'utf8' }).trim()
  return built === now ? undefined : 'linux/debian/ changed since it was built'
}
