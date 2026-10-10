/**
 * Provides a Linux kernel image (with built-in initramfs) for the emulator at
 * images/linux/Image:
 *
 *   1. already there            → nothing to do
 *   2. otherwise download the prebuilt mini-rv32ima image
 *   3. if that fails (or with --build): build it from source with
 *      linux/build.sh (runs Buildroot in a Podman container; see linux/README.md)
 *
 * Usage: node scripts/linux-image.ts [--build]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const IMAGE = 'images/linux/Image'
const PREBUILT_URL =
  'https://github.com/cnlohr/mini-rv32ima-images/raw/master/images/linux-6.1.14-rv32nommu-cnl-1.zip'

async function main() {
  const forceBuild = process.argv.includes('--build')
  if (existsSync(IMAGE) && !forceBuild) {
    console.log(`Linux image ready: ${IMAGE}`)
    return
  }
  mkdirSync(dirname(IMAGE), { recursive: true })

  if (!forceBuild) {
    try {
      console.log(`Downloading ${PREBUILT_URL}`)
      writeFileSync(IMAGE, extractFromZip(await download(PREBUILT_URL), 'Image'))
      console.log(`Linux image ready: ${IMAGE}`)
      return
    } catch (e) {
      console.warn(`Download failed (${(e as Error).message}); building from source instead.`)
    }
  }

  // Builds and installs images/linux/Image itself (or explains why it can't).
  execFileSync('bash', ['linux/build.sh'], { stdio: 'inherit' })
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Minimal ZIP reader: locate `name` via the central directory and inflate it. */
function extractFromZip(zip: Uint8Array, name: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip file')

  const entries = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localHeader = view.getUint32(p + 42, true)
    const entryName = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))

    if (entryName === name || entryName.endsWith(`/${name}`)) {
      const dataStart =
        localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true)
      const data = zip.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`unsupported zip compression method ${method}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`${name} not found in zip`)
}

main().catch(e => {
  console.error(`error: ${(e as Error).message}`)
  process.exit(1)
})
