/**
 * The emulator in a web page (web/index.html; npm run web serves it): the
 * machine's terminal is an xterm.js terminal, the harts run on Web Workers.
 *
 * By default it boots Debian as npm start does (images/debian/: OpenSBI,
 * U-Boot, the disk), on 4 harts with 1 GiB of RAM. The disk is read from
 * the server as Debian needs it (HttpStorage); what Debian writes stays in
 * this page (a SnapshotStorage), lost when it's closed. The network card
 * reaches the server's user-mode NAT over a WebSocket.
 *
 * Query parameters:
 *   image=<url>    boot this bare-metal program instead (no disk, network),
 *                  e.g. examples/build/hello.bin
 *   harts=<n>      default 4
 *   memory=<MiB>   default 1024 for Debian, 64 for an image
 *
 * How the machine stopped ends up in the page's `data-result` attribute,
 * and everything it printed in `window.emulatorOutput` (for tests).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { type BlockStorage, SnapshotStorage } from './block-storage.js'
import { setCoreModule } from './cpu.js'
import { HttpStorage } from './http-storage.js'
import { Machine, type RunResult } from './machine.js'
import { WebSocketNetwork } from './websocket-network.js'

// (URLs relative to the page, so it works from anywhere it's served.)
const DEBIAN = 'images/debian/'
/** Where U-Boot (or a kernel) goes in RAM, as npm start puts it. */
const KERNEL_OFFSET = 0x200000
/** With one hart: steps per turn of the event loop. */
const SLICE = 200_000

const params = new URLSearchParams(location.search)
const image = params.get('image')
const harts = Number(params.get('harts') ?? 4)
const memory = Number(params.get('memory') ?? (image ? 64 : 1024))

const status = document.getElementById('status')!
// Black as a console's: GRUB sets white on black (ANSI color 0, which
// xterm.js makes dark grey) and nothing resets it.
const terminal = new Terminal({ scrollback: 10_000, theme: { background: '#000000', black: '#000000' } })
const fit = new FitAddon()
terminal.loadAddon(fit)
terminal.open(document.getElementById('terminal')!)
fit.fit()
addEventListener('resize', () => fit.fit())
terminal.focus()

const log = (message: string) => (status.textContent = message)
const fetchBytes = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  return new Uint8Array(await response.arrayBuffer())
}

// What the machine prints: to the terminal, a batch at a time.
const printed: number[] = []
let pending: number[] = []
const output = (byte: number) => {
  printed.push(byte)
  if (pending.push(byte) === 1) {
    setTimeout(() => {
      terminal.write(Uint8Array.from(pending))
      pending = []
    }, 0)
  }
}
Object.defineProperty(window, 'emulatorOutput', { get: () => String.fromCharCode(...printed) })

try {
  if (!crossOriginIsolated) throw new Error('This page needs to be cross-origin isolated (npm run web serves it so)')
  log('loading the CPU core…')
  setCoreModule(await WebAssembly.compileStreaming(fetch('build/hart.wasm')))

  let machine: Machine
  if (image) {
    machine = new Machine({ ramSize: memory * 1024 * 1024, harts, output })
    machine.boot(await fetchBytes(image))
  } else {
    log('loading Debian…')
    const [firmware, uboot, disk] = await Promise.all([
      fetchBytes(DEBIAN + 'fw_dynamic.bin'),
      fetchBytes(DEBIAN + 'u-boot.bin'),
      HttpStorage.open(DEBIAN + 'pristine.raw'),
    ])
    const storage: BlockStorage = new SnapshotStorage(disk)
    const network = new WebSocketNetwork(new URL('net', location.href.replace(/^http/, 'ws')))
    machine = new Machine({ ramSize: memory * 1024 * 1024, harts, disk: storage, network, output })
    machine.boot(firmware, { load: [{ offset: KERNEL_OFFSET, data: uboot }], next: { offset: KERNEL_OFFSET } })
  }
  terminal.onData(data => machine.terminal.type(data))

  log(`running on ${harts} hart${harts > 1 ? 's' : ''}`)
  for (;;) {
    const result = await run(machine)
    if (result !== 'reboot') {
      document.body.dataset.result = result
      log(result === 'poweroff' ? 'powered off' : `stopped: ${result}`)
      break
    }
    machine.reboot()
  }
} catch (error) {
  document.body.dataset.result = 'error'
  log(String(error))
  throw error
}

/** Run until the machine powers off, reboots, or hits a breakpoint. */
async function run(machine: Machine): Promise<RunResult> {
  if (harts > 1) return machine.runThreaded()
  for (;;) {
    const result = machine.run(SLICE)
    if (result === 'idle') await new Promise(resolve => setTimeout(resolve, Math.min(machine.microsUntilTimer() / 1000, 10)))
    else if (result === 'limit') await new Promise(resolve => setTimeout(resolve, 0))
    else return result
  }
}
