/**
 * `npm start`: boot Linux in the emulator, interactively, rebuilding whatever
 * is out of date first.
 *
 *   node scripts/start.ts [mmu|rv64|nommu] [emulator options, e.g. --snapshot]
 *
 * mmu (default): OpenSBI + RV32 Linux with virtual memory, root file system
 *   on a virtio disk, networking. The image is (re)built with linux/build.sh
 *   when it's missing or anything it's built from changed (see
 *   linux/inputs-hash.sh); the old disk image is kept as rootfs.ext4.bak,
 *   since a rebuild replaces it.
 * rv64: the same with a 64-bit CPU and kernel.
 * nommu: mini-rv32ima's no-MMU Linux, downloaded if missing.
 *
 * The emulator itself is brought up to date first: its CPU core (hart/, Rust →
 * build/hart.wasm; cargo rebuilds only on changes), and dist/ when any src/
 * file is newer.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { buildWasm } from './build-wasm.ts'

/**
 * A Buildroot image (linux/build.sh): OpenSBI (fw_dynamic) at the start of
 * RAM, the kernel 4 MiB later, the root file system on a virtio disk, eth0 on
 * the user-mode network.
 */
const buildroot = (flavor: 'mmu' | 'rv64', xlen: 32 | 64) => {
  const dir = `images/linux-${flavor}`
  return {
    dir,
    files: [`${dir}/fw_dynamic.bin`, `${dir}/Image`, `${dir}/rootfs.ext4`],
    args: [
      '--xlen', `${xlen}`,
      '--memory', '256',
      '--kernel', `${dir}/Image`,
      '--disk', `${dir}/rootfs.ext4`,
      '--net',
      '--bootargs', 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
      `${dir}/fw_dynamic.bin`,
    ],
  }
}
const FLAVORS = {
  mmu: buildroot('mmu', 32),
  rv64: buildroot('rv64', 64),
  nommu: {
    dir: 'images/linux',
    files: ['images/linux/Image'],
    args: ['images/linux/Image'],
  },
}

const [first, ...rest] = process.argv.slice(2)
const flavor: keyof typeof FLAVORS = first === 'nommu' || first === 'mmu' || first === 'rv64' ? first : 'mmu'
const extraArgs = first === flavor ? rest : process.argv.slice(2)
const config = FLAVORS[flavor]

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })

// 1. The emulator.
buildWasm()
if (emulatorStale()) {
  console.log('[start] compiling the emulator')
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'])
}

// 2. The Linux image.
if (flavor !== 'nommu') {
  const reason = imageStale()
  if (reason) {
    const { dir } = config
    console.log(`[start] ${reason}: building the Linux image (FLAVOR=${flavor} linux/build.sh)`)
    if (existsSync(`${dir}/rootfs.ext4`)) {
      copyFileSync(`${dir}/rootfs.ext4`, `${dir}/rootfs.ext4.bak`, constants.COPYFILE_FICLONE)
      console.log(`[start] the rebuild replaces ${dir}/rootfs.ext4; the old one is kept as rootfs.ext4.bak`)
    }
    run('bash', ['linux/build.sh'], { FLAVOR: flavor })
  }
} else if (!config.files.every(existsSync)) {
  run(process.execPath, ['scripts/linux-image.ts'])
}

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

/** Why a Buildroot image needs (re)building, or undefined if it's up to date. */
function imageStale(): string | undefined {
  if (!config.files.every(existsSync)) return 'no Linux image yet'
  const hashFile = `${config.dir}/.inputs-hash`
  const built = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
  const now = execFileSync('bash', ['linux/inputs-hash.sh', flavor], { encoding: 'utf8' }).trim()
  return built === now ? undefined : 'linux/ changed since the image was built'
}
