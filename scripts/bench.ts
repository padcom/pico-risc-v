/**
 * Emulator speed benchmark (npm run bench [-- <name>...]):
 *
 *   bare-metal  examples/bench: integer, memory and branch-heavy C code in
 *               M-mode without paging; checks the checksum it prints
 *   compressed  the same, built with compressed instructions (RV32IMC)
 *   linux       the MMU Linux image (OpenSBI, Sv32 paging, ext4 on the virtio
 *               disk, read-only snapshot) booting to the login prompt
 *
 * Both run on the virtual clock (Linux with a fixed date and random seed), so every run
 * executes exactly the same instructions; the numbers are comparable between
 * emulator versions.
 */
import { existsSync, readFileSync } from 'node:fs'
import { SnapshotStorage } from '../dist/block-storage.js'
import { FileStorage } from '../dist/file-storage.js'
import { Machine } from '../dist/machine.js'

const root = new URL('../', import.meta.url)
const BENCH_CHECKSUM = 'checksum 991869f2'

interface Result {
  instructions: number
  seconds: number
}

function bareMetal(program = 'bench'): Result {
  let screen = ''
  const machine = new Machine({ clock: 'virtual', output: b => (screen += String.fromCharCode(b)) })
  machine.boot(readFileSync(new URL(`examples/build/${program}.bin`, root)))
  const start = performance.now()
  const result = machine.run(2_000_000_000)
  const seconds = (performance.now() - start) / 1000
  if (result !== 'poweroff' || !screen.includes(BENCH_CHECKSUM)) {
    throw new Error(`${program}: expected "${BENCH_CHECKSUM}" and power-off, got ${result}: ${JSON.stringify(screen)}`)
  }
  return { instructions: machine.cpu.instret, seconds }
}

function linux(): Result | undefined {
  const images = new URL('images/linux-mmu/', root)
  const files = ['fw_dynamic.bin', 'Image', 'rootfs.ext4'].map(f => new URL(f, images))
  if (!files.every(existsSync)) return undefined
  const [firmware, kernel, rootfs] = files as [URL, URL, URL]

  let screen = ''
  const disk = new FileStorage(rootfs.pathname, { readOnly: true })
  const machine = new Machine({
    clock: 'virtual',
    // A fixed date and random seed: every run executes the same instructions.
    startTime: Date.UTC(2026, 0, 1),
    rngSeed: new Uint8Array(64).fill(42),
    ramSize: 256 * 1024 * 1024,
    bootargs: 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
    disk: new SnapshotStorage(disk),
    output: b => (screen += String.fromCharCode(b)),
  })
  machine.boot(readFileSync(firmware), { load: [{ offset: 0x400000, data: readFileSync(kernel) }], next: { offset: 0x400000 } })
  const start = performance.now()
  while (!screen.includes('login: ')) {
    const result = machine.run(1_000_000)
    if (result !== 'limit') throw new Error(`linux: machine stopped (${result}); screen ends with:\n${screen.slice(-1000)}`)
    if (machine.cpu.instret > 2_000_000_000) throw new Error(`linux: no login prompt; screen ends with:\n${screen.slice(-1000)}`)
  }
  const seconds = (performance.now() - start) / 1000
  disk.close()
  return { instructions: machine.cpu.instret, seconds }
}

const benchmarks: Record<string, () => Result | undefined> = {
  'bare-metal': () => bareMetal(),
  compressed: () => bareMetal('bench-c'),
  linux,
}
const selected = process.argv.slice(2)
for (const name of selected.length ? selected : Object.keys(benchmarks)) {
  const bench = benchmarks[name]
  if (!bench) throw new Error(`unknown benchmark ${name}; available: ${Object.keys(benchmarks).join(', ')}`)
  const r = bench()
  if (!r) {
    console.log(`${name.padEnd(12)} skipped (no images; npm run linux:build)`)
    continue
  }
  const mips = r.instructions / r.seconds / 1e6
  console.log(
    `${name.padEnd(12)} ${(r.instructions / 1e6).toFixed(1).padStart(7)} M instructions  ` +
      `${r.seconds.toFixed(2).padStart(6)} s  ${mips.toFixed(1).padStart(6)} MIPS`,
  )
}
