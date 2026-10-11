/**
 * `npm start`: boot Linux in the emulator, interactively, rebuilding whatever
 * is out of date first.
 *
 *   node scripts/start.ts [mmu|rv64|debian|nommu] [emulator options, e.g. --snapshot]
 *
 * mmu (default): OpenSBI + RV32 Linux with virtual memory, root file system
 *   on a virtio disk, networking. The image is (re)built with linux/build.sh
 *   when it's missing or anything it's built from changed (see
 *   linux/inputs-hash.sh); the old disk image is kept as rootfs.ext4.bak,
 *   since a rebuild replaces it.
 * rv64: the same with a 64-bit CPU and kernel.
 * debian: Debian 13 (riscv64) on rv64's kernel and firmware, its disk built
 *   with linux/debian/build.sh (when missing or linux/debian/ changed; the
 *   old disk is kept as rootfs.ext4.bak too).
 * nommu: mini-rv32ima's no-MMU Linux, downloaded if missing.
 *
 * The emulator itself is brought up to date first: its CPU core (hart/, Rust →
 * build/hart.wasm; cargo rebuilds only on changes), and dist/ when any src/
 * file is newer.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { buildWasm } from './build-wasm.ts'

/** An image built from linux/ (`inputs-hash.sh <name>` fingerprints its inputs) into `dir`. */
type Build = { name: 'mmu' | 'rv64' | 'debian'; dir: string; command: string[]; env?: NodeJS.ProcessEnv }

const buildroot = (flavor: 'mmu' | 'rv64'): Build => ({
  name: flavor,
  dir: `images/linux-${flavor}`,
  command: ['linux/build.sh'],
  env: { FLAVOR: flavor },
})
const debian: Build = { name: 'debian', dir: 'images/debian', command: ['linux/debian/build.sh'] }

/**
 * OpenSBI (fw_dynamic) at the start of RAM, a Buildroot kernel 4 MiB later,
 * the root file system on a virtio disk, eth0 on the user-mode network.
 */
const opensbi = (kernel: 'mmu' | 'rv64', disk: string, memory: number) => {
  const dir = `images/linux-${kernel}`
  return [
    '--xlen', kernel === 'rv64' ? '64' : '32',
    '--memory', `${memory}`,
    '--kernel', `${dir}/Image`,
    '--disk', `${disk}/rootfs.ext4`,
    '--net',
    '--bootargs', 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
    `${dir}/fw_dynamic.bin`,
  ]
}

/** What each flavor boots, and the images it needs, in build order. */
const FLAVORS: Record<string, { builds: Build[]; args: string[] }> = {
  mmu: { builds: [buildroot('mmu')], args: opensbi('mmu', 'images/linux-mmu', 256) },
  rv64: { builds: [buildroot('rv64')], args: opensbi('rv64', 'images/linux-rv64', 256) },
  // Debian on rv64's kernel and firmware; more memory for apt.
  debian: { builds: [buildroot('rv64'), debian], args: opensbi('rv64', 'images/debian', 512) },
  nommu: { builds: [], args: ['images/linux/Image'] },
}

const [first, ...rest] = process.argv.slice(2)
const flavor = first !== undefined && first in FLAVORS ? first : 'mmu'
const extraArgs = first === flavor ? rest : process.argv.slice(2)
const config = FLAVORS[flavor]!

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })

// 1. The emulator.
buildWasm()
if (emulatorStale()) {
  console.log('[start] compiling the emulator')
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'])
}

// 2. The images.
for (const build of config.builds) {
  const reason = imageStale(build)
  if (!reason) continue
  const { dir, command, env = {} } = build
  const shown = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...command].join(' ')
  console.log(`[start] ${reason}: building ${dir} (${shown})`)
  if (existsSync(`${dir}/rootfs.ext4`)) {
    copyFileSync(`${dir}/rootfs.ext4`, `${dir}/rootfs.ext4.bak`, constants.COPYFILE_FICLONE)
    console.log(`[start] the rebuild replaces ${dir}/rootfs.ext4; the old one is kept as rootfs.ext4.bak`)
  }
  run('bash', command, env)
}
if (flavor === 'nommu' && !existsSync('images/linux/Image')) run(process.execPath, ['scripts/linux-image.ts'])

// 3. Boot.
const { status } = spawnSync(process.execPath, ['dist/cli.js', ...config.args, ...extraArgs], { stdio: 'inherit' })
process.exit(status ?? 1)

/** dist/ is missing or older than some source file. */
function emulatorStale(): boolean {
  if (!existsSync('dist/cli.js')) return true
  const built = statSync('dist/cli.js').mtimeMs
  return readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .some(f => statSync(`src/${f}`).mtimeMs > built)
}

/** Why an image needs (re)building, or undefined if it's up to date. */
function imageStale({ name, dir }: Build): string | undefined {
  const files = name === 'debian' ? ['rootfs.ext4'] : ['fw_dynamic.bin', 'Image', 'rootfs.ext4']
  if (!files.every(f => existsSync(`${dir}/${f}`))) return 'not built yet'
  const hashFile = `${dir}/.inputs-hash`
  const built = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
  const now = execFileSync('bash', ['linux/inputs-hash.sh', name], { encoding: 'utf8' }).trim()
  return built === now ? undefined : 'linux/ changed since it was built'
}
