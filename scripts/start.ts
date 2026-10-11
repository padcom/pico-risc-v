/**
 * `npm start`: boot Debian in the emulator, interactively, rebuilding whatever
 * is out of date first.
 *
 *   node scripts/start.ts [emulator options, e.g. --snapshot]
 *
 * 1. The emulator: its CPU core (hart/, Rust → build/hart.wasm; cargo
 *    rebuilds only on changes), and dist/ when any src/ file is newer.
 * 2. The images, each (re)built when it's missing or what it's built from
 *    changed (see linux/inputs-hash.sh):
 *    - the kernel and OpenSBI firmware (linux/kernel/build.sh → images/kernel/)
 *    - the Debian disk (linux/debian/build.sh → images/debian/rootfs.ext4);
 *      a rebuild replaces it, so the old one is kept as rootfs.ext4.bak
 * 3. Boot: OpenSBI at the start of RAM, the kernel 4 MiB later, Debian on the
 *    virtio disk, eth0 on the user-mode network.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { buildWasm } from './build-wasm.ts'

/** An image built by linux/<name>/build.sh into `dir`, made of `files`. */
interface Image {
  name: 'kernel' | 'debian'
  dir: string
  files: string[]
}
const KERNEL: Image = { name: 'kernel', dir: 'images/kernel', files: ['fw_dynamic.bin', 'Image'] }
const DEBIAN: Image = { name: 'debian', dir: 'images/debian', files: ['rootfs.ext4'] }

const ARGS = [
  '--memory', '512',
  '--kernel', `${KERNEL.dir}/Image`,
  '--disk', `${DEBIAN.dir}/rootfs.ext4`,
  '--net',
  '--bootargs', 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
  `${KERNEL.dir}/fw_dynamic.bin`,
]

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' })

// 1. The emulator.
buildWasm()
if (emulatorStale()) {
  console.log('[start] compiling the emulator')
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'])
}

// 2. The images.
for (const image of [KERNEL, DEBIAN]) {
  const reason = imageStale(image)
  if (!reason) continue
  const { name, dir } = image
  console.log(`[start] ${reason}: building ${dir} (linux/${name}/build.sh)`)
  if (existsSync(`${dir}/rootfs.ext4`)) {
    // Moved, not copied: instant, and the (sparse) file stays sparse.
    renameSync(`${dir}/rootfs.ext4`, `${dir}/rootfs.ext4.bak`)
    console.log(`[start] the rebuild replaces ${dir}/rootfs.ext4; the old one is kept as rootfs.ext4.bak`)
  }
  run('bash', [`linux/${name}/build.sh`])
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

/** Why an image needs (re)building, or undefined if it's up to date. */
function imageStale({ name, dir, files }: Image): string | undefined {
  if (!files.every(f => existsSync(`${dir}/${f}`))) return 'not built yet'
  const hashFile = `${dir}/.inputs-hash`
  const built = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
  const now = execFileSync('bash', ['linux/inputs-hash.sh', name], { encoding: 'utf8' }).trim()
  return built === now ? undefined : `linux/${name}/ changed since it was built`
}
