/**
 * The emulator in a web page: the machine's terminal is an xterm.js
 * terminal, the harts run on Web Workers. The page is web/index.html, as npm
 * run web serves it, or as npm run site makes it, for a plain web server.
 *
 * It boots a Linux distribution from images/<distribution>/ (the page's
 * data-distribution, debian by default), on 4 harts:
 *   - debian: as npm start does (OpenSBI, U-Boot, the disk)
 *   - others (alpine): as their boot.json says (linux/alpine/build.sh writes
 *     it): firmware, kernel (unpacked here if gzipped), initrd, disk, bootargs,
 *     memory
 * The disk is read from the server as Linux needs it: an image file by Range
 * requests (HttpStorage), or, if it's a manifest (.json), in chunks
 * (ChunkedStorage). What Linux writes stays in this page (a SnapshotStorage),
 * lost when it's closed. With data-network on the page (npm run web), the
 * network card reaches the server's user-mode NAT over a WebSocket.
 *
 * Threads need a cross-origin isolated page. Where the server doesn't make
 * it one (GitHub Pages, say), data-service-worker on the page names a service
 * worker that adds the headers it takes (web/isolate.js), and the page
 * reloads once through it.
 *
 * Query parameters:
 *   distribution=<name>  boot that one instead
 *   image=<url>          boot this bare-metal program instead (no disk,
 *                        network), e.g. examples/build/hello.bin
 *   harts=<n>            default 4
 *   memory=<MiB>         default 1024 for Debian, boot.json's, 64 for an image
 *
 * How the machine stopped ends up in the page's `data-result` attribute,
 * and everything it printed in `window.emulatorOutput` (for tests).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { type BlockStorage, SnapshotStorage } from './block-storage.js'
import { ChunkedStorage, gunzip } from './chunked-storage.js'
import { setCoreModule } from './cpu.js'
import { HttpStorage } from './http-storage.js'
import { Machine, type RunResult } from './machine.js'
import { WebSocketNetwork } from './websocket-network.js'

/** How to boot a distribution (images/<distribution>/boot.json; files relative to it). */
interface BootConfig {
  firmware: string
  /** The next stage, after the firmware: a kernel, or a bootloader (U-Boot). */
  kernel: string
  initrd?: string
  disk: string
  bootargs?: string
  /** RAM, MiB. */
  memory?: number
}

/** Debian's (its images/debian/ has no boot.json). */
const DEBIAN: BootConfig = { firmware: 'fw_dynamic.bin', kernel: 'u-boot.bin', disk: 'pristine.raw', memory: 1024 }
/** Where U-Boot (or a kernel) goes in RAM, as npm start puts it. */
const KERNEL_OFFSET = 0x200000
/** With one hart: steps per turn of the event loop. */
const SLICE = 200_000

const params = new URLSearchParams(location.search)
const page = document.body.dataset
const image = params.get('image')
const distribution = params.get('distribution') ?? page.distribution ?? 'debian'
const harts = Number(params.get('harts') ?? 4)

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
const fetchBytes = async (url: string | URL) => {
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
  if (!crossOriginIsolated) await isolate()
  log('loading the CPU core…')
  setCoreModule(await WebAssembly.compileStreaming(fetch('build/hart.wasm')))

  let machine: Machine
  if (image) {
    machine = new Machine({ ramSize: Number(params.get('memory') ?? 64) << 20, harts, output })
    machine.boot(await fetchBytes(image))
  } else {
    log(`loading ${distribution}…`)
    const dir = new URL(`images/${distribution}/`, location.href)
    const config = distribution === 'debian' ? DEBIAN : ((await (await fetch(new URL('boot.json', dir))).json()) as BootConfig)
    const file = (name: string) => new URL(name, dir)
    const [firmware, kernel, initrd, disk] = await Promise.all([
      fetchBytes(file(config.firmware)),
      fetchBytes(file(config.kernel)).then(gunzip), // (OpenSBI can't start a compressed one)
      config.initrd ? fetchBytes(file(config.initrd)) : undefined, // (Linux unpacks it)
      config.disk.endsWith('.json') ? ChunkedStorage.open(file(config.disk)) : HttpStorage.open(file(config.disk).href),
    ])
    const storage: BlockStorage = new SnapshotStorage(disk)
    const network = page.network !== undefined ? new WebSocketNetwork(new URL('net', location.href.replace(/^http/, 'ws'))) : undefined
    machine = new Machine({
      ramSize: Number(params.get('memory') ?? config.memory ?? 1024) << 20,
      harts,
      disk: storage,
      network,
      bootargs: config.bootargs,
      output,
    })
    machine.boot(firmware, { load: [{ offset: KERNEL_OFFSET, data: kernel }], next: { offset: KERNEL_OFFSET }, initrd })
  }
  terminal.onData(data => machine.type(data))
  // The terminal's size, and changes to it (fit() follows the window).
  machine.resize(terminal.cols, terminal.rows)
  terminal.onResize(({ cols, rows }) => machine.resize(cols, rows))

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

/**
 * Make the page cross-origin isolated, with the service worker the page
 * names (if any), which adds the headers it takes to every response: once
 * it's running, reload through it. Doesn't return (or throws if it can't).
 */
async function isolate(): Promise<never> {
  const worker = page.serviceWorker
  // (Only once: if the reload didn't help, something else is wrong.)
  if (!worker || !navigator.serviceWorker || sessionStorage.getItem('isolating')) {
    sessionStorage.removeItem('isolating')
    throw new Error('This page needs to be cross-origin isolated (npm run web serves it so; a browser with service workers can do it itself)')
  }
  log('setting up…')
  sessionStorage.setItem('isolating', '1')
  await navigator.serviceWorker.register(worker)
  await navigator.serviceWorker.ready
  location.reload()
  return new Promise<never>(() => {})
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
