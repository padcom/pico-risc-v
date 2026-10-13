/**
 * Installs linux/debian/packages into Debian's disk: boots it in the emulator
 * (dist/, as built by npm run build), with the user-mode network, and runs
 * apt there, as root on the console; then tidies up after itself (apt's
 * lists, the logs, the machine id, which each machine makes its own on its
 * first boot) and powers off. linux/debian/build.sh's last step:
 *
 *   node linux/debian/install.ts <disk>
 *
 * The disk is changed in place.
 */
import { readFileSync } from 'node:fs'
import { FileStorage } from '../../dist/file-storage.js'
import { Machine } from '../../dist/machine.js'
import { UserNetwork } from '../../dist/net/user-network.js'

const DIR = new URL('../../images/debian/', import.meta.url)
/** How long each step may take, at most (ms). */
const TIMEOUT = 30 * 60_000

const [path] = process.argv.slice(2)
if (!path) {
  console.error('usage: node linux/debian/install.ts <disk>')
  process.exit(2)
}
const packages = readFileSync(new URL('packages', import.meta.url), 'utf8')
  .split('\n')
  .map(line => line.replace(/#.*/, '').trim())
  .filter(Boolean)

const disk = new FileStorage(path)
const network = new UserNetwork()
let screen = ''
/** Whether to show what the guest prints (from the login on). */
let showing = false
const machine = new Machine({
  ramSize: 1024 * 1024 * 1024,
  harts: 4,
  disk,
  network,
  output: byte => {
    screen += String.fromCharCode(byte)
    if (showing) process.stdout.write(String.fromCharCode(byte))
  },
})
machine.boot(readFileSync(new URL('fw_dynamic.bin', DIR)), {
  load: [{ offset: 0x200000, data: readFileSync(new URL('u-boot.bin', DIR)) }],
  next: { offset: 0x200000 },
})

/** Wait for `pattern` on the terminal, after `from`. */
const until = async (pattern: RegExp, from: number) => {
  const deadline = Date.now() + TIMEOUT
  for (;;) {
    const found = pattern.exec(screen.slice(from))
    if (found) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; the terminal ends with:\n${screen.slice(-2000)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
let steps = 0
/** Run `command` in the guest; throws if it fails. */
const run = async (command: string) => {
  const step = ++steps
  const from = screen.length
  // (The marker is computed, so the echoed command line doesn't match it.)
  machine.type(`${command}; echo "step-$((${step}+0)) status $?"\n`)
  const [, status] = await until(new RegExp(`step-${step} status (\\d+)\r\n`), from)
  if (status !== '0') throw new Error(`failed (${status}): ${command}`)
}

const running = machine.runThreaded()
try {
  // The login on the console (hvc0), the one typing goes to.
  await until(/debian hvc0\r\n\r\ndebian login: /, 0)
  const from = screen.length
  machine.type('root\n')
  await until(/# /, from)
  showing = true
  await run('unset HISTFILE')
  await run('apt-get update -q')
  await run(`DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${packages.join(' ')}`)
  await run('apt-get clean && rm -rf /var/lib/apt/lists/* && journalctl --rotate -q && journalctl --vacuum-time=1s -q && truncate -s 0 /etc/machine-id')
  machine.type('poweroff\n')
  const result = await running
  if (result !== 'poweroff') throw new Error(`the machine stopped: ${result}`)
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`)
  process.exit(1)
} finally {
  showing = false
  network.close()
  disk.flush()
  disk.close()
}
console.log(`\n${packages.length} packages installed`)
process.exit(0)
