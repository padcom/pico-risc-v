/**
 * `npm run site`: the emulator as a static web site, for any plain web server
 * (GitHub Pages, say): site/ boots Alpine Linux (images/alpine/, from npm run
 * alpine:build) in the page, on 4 harts, without a network.
 *
 *   node scripts/site.ts [--out <dir>]
 *
 * What it takes from what npm run web serves:
 * - the page (web/), set up for Alpine, without network, and with the
 *   service worker (web/isolate.js) that makes it cross-origin isolated (the
 *   harts' threads need that; a plain web server doesn't send the headers)
 * - the compiled emulator (dist/), the core (build/hart.wasm), xterm.js, the
 *   bare-metal examples (?image=examples/build/hello.bin)
 * - Alpine: the firmware, the initramfs, the kernel gzipped (the page unpacks
 *   it), and the disk split into gzipped chunks of CHUNK bytes, all-zero ones
 *   left out (ChunkedStorage reads them): no file is bigger than the kernel,
 *   and the free space takes none
 */
import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { buildWasm } from './build-wasm.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { out: { type: 'string', default: 'site' } } })
const out = join(root, values.out)
const ALPINE = join(root, 'images/alpine')
const CHUNK = 1024 * 1024

if (!existsSync(join(ALPINE, 'boot.json'))) {
  console.error('[site] no Alpine image: npm run alpine:build makes it')
  process.exit(1)
}
buildWasm()
console.log('[site] compiling the emulator')
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const copy = (from: string, to = from) => {
  mkdirSync(join(out, to, '..'), { recursive: true })
  cpSync(join(root, from), join(out, to), { recursive: true })
}

// The page: Alpine, no network, isolated by the service worker.
const page = readFileSync(join(root, 'web/index.html'), 'utf8').replace(
  '<body data-distribution="debian" data-network>',
  '<body data-distribution="alpine" data-service-worker="isolate.js">',
)
if (!page.includes('data-service-worker')) throw new Error('web/index.html: no <body data-distribution="debian" data-network>')
writeFileSync(join(out, 'index.html'), page)
copy('web/isolate.js', 'isolate.js')
// The emulator's modules (not their types or maps), the core, xterm.js.
for (const file of readdirSync(join(root, 'dist'), { recursive: true, encoding: 'utf8' })) {
  if (file.endsWith('.js')) copy(join('dist', file))
}
copy('build/hart.wasm')
copy('node_modules/@xterm/xterm/lib/xterm.mjs', 'xterm/lib/xterm.mjs')
copy('node_modules/@xterm/xterm/css/xterm.css', 'xterm/css/xterm.css')
copy('node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'xterm-fit/lib/addon-fit.mjs')
for (const program of ['hello', 'smp']) {
  if (existsSync(join(root, `examples/build/${program}.bin`))) copy(`examples/build/${program}.bin`)
}
// No Jekyll on GitHub Pages: serve the files as they are.
writeFileSync(join(out, '.nojekyll'), '')

// Alpine.
const boot = JSON.parse(readFileSync(join(ALPINE, 'boot.json'), 'utf8')) as Record<string, unknown> & {
  firmware: string
  kernel: string
  initrd: string
  disk: string
}
const images = join(out, 'images/alpine')
mkdirSync(join(images, 'disk'), { recursive: true })
copyFileSync(join(ALPINE, boot.firmware), join(images, boot.firmware))
copyFileSync(join(ALPINE, boot.initrd), join(images, boot.initrd))
writeFileSync(join(images, `${boot.kernel}.gz`), gzipSync(readFileSync(join(ALPINE, boot.kernel)), { level: 9 }))
const disk = join(ALPINE, boot.disk)
const size = statSync(disk).size
const chunks: number[] = []
// (What it holds, for pages that saved changes over another one.)
const hash = createHash('sha256')
const buffer = Buffer.alloc(CHUNK)
const fd = openSync(disk, 'r')
for (let index = 0; index * CHUNK < size; index++) {
  const length = readSync(fd, buffer, 0, Math.min(CHUNK, size - index * CHUNK), index * CHUNK)
  const chunk = buffer.subarray(0, length)
  if (chunk.every(byte => byte === 0)) continue
  hash.update(`${index}:`).update(chunk)
  writeFileSync(join(images, 'disk', `${index}.gz`), gzipSync(chunk, { level: 9 }))
  chunks.push(index)
}
closeSync(fd)
writeFileSync(join(images, 'disk/manifest.json'), JSON.stringify({ size, chunk: CHUNK, chunks, id: hash.digest('hex') }))
writeFileSync(join(images, 'boot.json'), JSON.stringify({ ...boot, kernel: `${boot.kernel}.gz`, disk: 'disk/manifest.json' }, null, 2))

const used = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? used(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
console.log(`[site] ${values.out}/: ${(used(out) / 1024 / 1024).toFixed(0)} MB (the disk: ${chunks.length} of ${Math.ceil(size / CHUNK)} chunks, ${(used(join(images, 'disk')) / 1024 / 1024).toFixed(0)} MB)`)
