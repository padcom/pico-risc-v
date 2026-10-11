/**
 * Boots a Linux image in the emulator, interactively (via dist/cli.js).
 *
 *   node scripts/run-linux.ts mmu     OpenSBI + regular Linux (npm run linux:build)
 *   node scripts/run-linux.ts nommu   mini-rv32ima's nommu Linux (npm run linux:nommu:image)
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const FLAVORS = {
  // OpenSBI (fw_dynamic) at the start of RAM, the kernel 4 MiB later.
  mmu: {
    files: ['images/linux-mmu/fw_dynamic.bin', 'images/linux-mmu/Image'],
    args: ['--memory', '256', '--kernel', 'images/linux-mmu/Image', 'images/linux-mmu/fw_dynamic.bin'],
    missing: 'npm run linux:build',
  },
  nommu: {
    files: ['images/linux/Image'],
    args: ['images/linux/Image'],
    missing: 'npm run linux:nommu:image (download) or npm run linux:nommu:build',
  },
}

const flavor = process.argv[2] as keyof typeof FLAVORS
const config = FLAVORS[flavor]
if (!config) {
  console.error(`usage: node scripts/run-linux.ts ${Object.keys(FLAVORS).join('|')}`)
  process.exit(2)
}
const absent = config.files.filter(f => !existsSync(f))
if (absent.length) {
  console.error(`Missing ${absent.join(', ')}; create it with: ${config.missing}`)
  process.exit(1)
}
const { status } = spawnSync(process.execPath, ['dist/cli.js', ...config.args, ...process.argv.slice(3)], {
  stdio: 'inherit',
})
process.exit(status ?? 1)
