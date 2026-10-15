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
 * (ChunkedStorage). What Linux writes goes to a SnapshotStorage, which this
 * browser keeps (IndexedDbStore: per distribution, for that image), so the
 * disk is as it was left the next time; one page at a time, and a link in
 * the status bar starts over. With data-network on the page (npm run web), the
 * network card reaches the server's user-mode NAT over a WebSocket; with
 * ?relay=, that of a relay (npm run relay, on this machine, say).
 *
 * Threads need a cross-origin isolated page. Where the server doesn't make
 * it one (GitHub Pages, say), data-service-worker on the page names a service
 * worker that adds the headers it takes (web/isolate.js), and the page
 * reloads once through it.
 *
 * Query parameters:
 *   distribution=<name>  boot that one instead
 *   relay=<ws url>       the network through this relay (npm run relay:
 *                        ws://localhost:8081)
 *   image=<url>          boot this bare-metal program instead (no disk,
 *                        network), e.g. examples/build/hello.bin
 *   harts=<n>            default 4
 *   persist=0            don't keep the disk's changes (a throwaway session)
 *   memory=<MiB>         default 1024 for Debian, boot.json's, 64 for an image
 *   display=<w>x<h>      the screen's size, fixed (by default it's the
 *                        page's room for it, and follows it: the guest
 *                        is asked for the new size, see show()); display=0:
 *                        no screen, the terminal only (as for an image,
 *                        unless it says display). The distributions' desktops
 *                        run on it. With it come a keyboard, which has the
 *                        keys while the screen has the focus (click it), and
 *                        a mouse. The page shows the screen or the terminal
 *                        (the buttons in the status bar), the screen fitted
 *                        to the page, or full screen. And with it, a
 *                        sound card, heard (Web Audio) once the page has
 *                        been clicked or typed in
 *
 * How the machine stopped ends up in the page's `data-result` attribute,
 * and everything it printed in `window.emulatorOutput` (for tests).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { type BlockStorage, SnapshotStorage } from './block-storage.js'
import { ChunkedStorage, gunzip } from './chunked-storage.js'
import { setCoreModule } from './cpu.js'
import { fit as fitArea } from './fit.js'
import { LINUX_KEYS } from './keymap.js'
import { HttpStorage } from './http-storage.js'
import { IndexedDbStore } from './indexeddb-store.js'
import { Machine, type RunResult } from './machine.js'
import { Input, TABLET_MAX } from './virtio-input.js'
import { playOnPage } from './web-audio.js'
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
const relay = params.get('relay')
const persist = params.get('persist') !== '0'
// A screen by default, as big as the page's room for it (and following it,
// unless the page says how big); for a bare-metal program, only when asked for.
const display = params.get('display') === '0' || (image && !params.has('display')) ? undefined : parseDisplay(params.get('display') ?? '')
const resizable = display !== undefined && !params.get('display')
/** How long the page's room for the screen stays the same before the guest is asked for that size (ms). */
const SETTLE = 300
/** How often the disk's changes are saved, besides when the guest flushes it (ms). */
const SAVE_INTERVAL = 2000
/** Where npm run relay is, by default. */
const LOCAL_RELAY = 'ws://localhost:8081'
/** How long to wait for the network's WebSocket to connect (ms). */
const RELAY_TIMEOUT = 5000

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
const networkStatus = document.getElementById('network')!
const diskStatus = document.getElementById('disk')!
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
    machine = new Machine({ ramSize: Number(params.get('memory') ?? 64) << 20, harts, output, display, sound: !!display })
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
    const storage: BlockStorage = await keep(disk)
    const network = await connect()
    machine = new Machine({
      ramSize: Number(params.get('memory') ?? config.memory ?? 1024) << 20,
      harts,
      disk: storage,
      network,
      bootargs: config.bootargs,
      output,
      display,
      sound: !!display,
    })
    machine.boot(firmware, { load: [{ offset: KERNEL_OFFSET, data: kernel }], next: { offset: KERNEL_OFFSET }, initrd })
  }
  if (machine.screen) show(machine)
  if (machine.sound) playOnPage(machine.sound)
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

/** `display`'s value: <width>x<height>; if none (or just `display`), the page's room for the screen. */
function parseDisplay(value: string): { width: number; height: number } {
  if (!value) return roomForScreen(document.getElementById('views')!)
  const [, width, height] = /^(\d+)x(\d+)$/.exec(value) ?? []
  if (!width || !height) throw new Error(`display=${value}: should be <width>x<height>, e.g. 1024x768`)
  return { width: Number(width), height: Number(height) }
}

/** A screen size for `element`'s room: its size in CSS pixels (not too small). */
function roomForScreen(element: HTMLElement): { width: number; height: number } {
  return { width: Math.max(640, Math.floor(element.clientWidth)), height: Math.max(400, Math.floor(element.clientHeight)) }
}

/**
 * Show the screen on the page's canvas (in its view, which it fills keeping
 * its shape; the terminal's view is the other one: the status bar's buttons
 * switch, or the screen goes full screen), a frame at a time (when it
 * changed), and pass the keys pressed while it has the focus to the
 * keyboard, what the mouse does over it to the tablet. When the view's size
 * changes (the window's, full screen), the guest is asked for that size
 * (resizable: unless the page said how big): the GPU's display follows.
 */
function show(machine: Machine): void {
  const canvas = document.getElementById('screen') as HTMLCanvasElement
  const screenView = document.getElementById('screen-view')!
  const terminalView = document.getElementById('terminal')!
  const context = canvas.getContext('2d')!
  // What's shown: as big as what the screen shows (now).
  let image = context.createImageData(1, 1)
  let stale = true
  const frame = () => {
    const screen = machine.output
    if (screen && (screen.width !== canvas.width || screen.height !== canvas.height)) {
      canvas.width = screen.width
      canvas.height = screen.height
      image = context.createImageData(screen.width, screen.height)
      stale = true
    }
    // (Not drawn while it isn't shown; then all of it, once it is again.)
    if (screen && !screenView.hidden && (screen.draw(image.data) || stale)) {
      context.putImageData(image, 0, 0)
      stale = false
    }
    requestAnimationFrame(frame)
  }
  frame()
  if (resizable) {
    let settling: ReturnType<typeof setTimeout> | undefined
    new ResizeObserver(() => {
      if (screenView.hidden) return
      clearTimeout(settling)
      settling = setTimeout(() => {
        const { width, height } = roomForScreen(screenView)
        machine.setDisplaySize(width, height)
      }, SETTLE)
    }).observe(screenView)
  }

  // The views: the screen, or the terminal.
  const buttons = { screen: document.getElementById('show-screen')!, terminal: document.getElementById('show-terminal')! }
  const view = (which: 'screen' | 'terminal') => {
    screenView.hidden = which !== 'screen'
    terminalView.hidden = which !== 'terminal'
    buttons.screen.setAttribute('aria-pressed', String(which === 'screen'))
    buttons.terminal.setAttribute('aria-pressed', String(which === 'terminal'))
    if (which === 'screen') {
      stale = true
      canvas.focus()
    } else {
      fit.fit() // (the terminal's size: it couldn't tell while hidden)
      terminal.focus()
    }
  }
  buttons.screen.addEventListener('click', () => view('screen'))
  buttons.terminal.addEventListener('click', () => view('terminal'))
  document.getElementById('fullscreen')!.addEventListener('click', () => {
    view('screen')
    void screenView.requestFullscreen?.().then(() => canvas.focus())
  })
  document.getElementById('view-switch')!.hidden = false
  view('screen')

  const keyboard = machine.keyboard!
  const tablet = machine.tablet!
  // Keys held down: let go of when the screen loses the focus (their keyup goes elsewhere).
  const held = new Set<number>()
  canvas.addEventListener('keydown', event => {
    const key = LINUX_KEYS[event.code]
    if (key === undefined) return
    event.preventDefault()
    // (The guest repeats keys itself.)
    if (event.repeat || held.has(key)) return
    held.add(key)
    keyboard.send([Input.EV_KEY, key, 1])
  })
  canvas.addEventListener('keyup', event => {
    const key = LINUX_KEYS[event.code]
    if (key === undefined || !held.delete(key)) return
    event.preventDefault()
    keyboard.send([Input.EV_KEY, key, 0])
  })
  canvas.addEventListener('blur', () => {
    for (const key of held) keyboard.send([Input.EV_KEY, key, 0])
    held.clear()
  })

  const BUTTONS = [Input.BTN_LEFT, Input.BTN_MIDDLE, Input.BTN_RIGHT] // by MouseEvent.button
  const at = (event: MouseEvent): [number, number, number][] => {
    // (Where the screen is in the canvas element: it keeps its shape, with bars.)
    const box = canvas.getBoundingClientRect()
    const area = fitArea(canvas.width, canvas.height, box.width, box.height)
    const scale = (value: number, size: number) => Math.round(Math.min(Math.max(value / size, 0), 1) * TABLET_MAX)
    return [
      [Input.EV_ABS, Input.ABS_X, scale(event.clientX - box.left - area.x, area.width)],
      [Input.EV_ABS, Input.ABS_Y, scale(event.clientY - box.top - area.y, area.height)],
    ]
  }
  canvas.addEventListener('pointermove', event => tablet.send(...at(event)))
  canvas.addEventListener('pointerdown', event => {
    const button = BUTTONS[event.button]
    if (button === undefined) return
    event.preventDefault()
    canvas.focus()
    canvas.setPointerCapture(event.pointerId) // (a drag goes on outside it)
    tablet.send(...at(event), [Input.EV_KEY, button, 1])
  })
  canvas.addEventListener('pointerup', event => {
    const button = BUTTONS[event.button]
    if (button !== undefined) tablet.send(...at(event), [Input.EV_KEY, button, 0])
  })
  canvas.addEventListener('contextmenu', event => event.preventDefault())
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    const notches: [number, number, number][] = []
    if (event.deltaY) notches.push([Input.EV_REL, Input.REL_WHEEL, -Math.sign(event.deltaY)])
    if (event.deltaX) notches.push([Input.EV_REL, Input.REL_HWHEEL, Math.sign(event.deltaX)])
    if (notches.length) tablet.send(...notches)
  }, { passive: false })
}

/**
 * The disk's changes, over `base`: kept in this browser (unless the page says
 * not to, or another page of the same distribution keeps them already), or
 * only in this page. Says which in the status bar.
 */
async function keep(base: BlockStorage): Promise<SnapshotStorage> {
  const show = (...parts: (string | Node)[]) => diskStatus.replaceChildren(...parts)
  const throwaway = (why: string) => (show(`disk: changes not kept (${why})`), new SnapshotStorage(base))
  if (!persist) return throwaway('persist=0')
  if (!base.id || typeof indexedDB === 'undefined') return throwaway("can't tell this image from others")
  if (!(await lock(`risc-emulator-disk-${distribution}`))) return throwaway("it's open in another page")

  const store = await IndexedDbStore.open(distribution, base.id)
  const storage = new SnapshotStorage(base, store)
  storage.onsaveerror = error => show(`disk: changes not kept (${error})`)
  const reset = Object.assign(document.createElement('a'), { href: '#', textContent: 'start over' })
  reset.onclick = async event => {
    event.preventDefault()
    if (!confirm('Start over with the disk as it was at first? What changed on it is lost.')) return
    await store.clear()
    location.reload()
  }
  show(store.discarded ? 'disk: a new image (changes to the old one dropped); kept · ' : 'disk: changes kept in this browser · ', reset)
  // Besides when the guest flushes it: every so often, and when the page goes.
  setInterval(() => void storage.flush(), SAVE_INTERVAL)
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void storage.flush())
  addEventListener('pagehide', () => void storage.flush())
  // (Ask the browser not to clear it when short of space; it may say no.)
  void navigator.storage?.persist?.()
  return storage
}

/** Hold a lock named `name` for as long as the page is open; false if another page has it. */
function lock(name: string): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true)
  return new Promise(resolve => {
    void navigator.locks.request(name, { ifAvailable: true }, held => {
      resolve(held !== null)
      return held ? new Promise<never>(() => {}) : undefined
    })
  })
}

/**
 * The network card's way out: the relay asked for, or the server's (npm run
 * web), if any; says how it goes in the page's status bar. Undefined if
 * there's none, or it isn't there: then the machine has no network card
 * (rather than one whose DHCP waits in vain, holding up the boot).
 */
async function connect(): Promise<WebSocketNetwork | undefined> {
  const url = relay ?? (page.network !== undefined ? new URL('net', location.href.replace(/^http/, 'ws')).href : undefined)
  if (!url) {
    // Where to get one.
    const link = new URL(location.href)
    link.searchParams.set('relay', LOCAL_RELAY)
    const a = Object.assign(document.createElement('a'), { href: link.href, textContent: 'through npm run relay on this machine' })
    networkStatus.replaceChildren('no network: ', a)
    return undefined
  }
  const network = new WebSocketNetwork(url)
  let open = false
  networkStatus.textContent = `network: connecting to ${url}…`
  network.onopen = () => {
    open = true
    networkStatus.textContent = relay ? `network: through ${url}` : 'network'
  }
  network.onclose = () => {
    networkStatus.textContent = open ? `network: lost (${url})` : `no network: nothing at ${url}${relay ? ' (is npm run relay running?)' : ''}`
  }
  const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), RELAY_TIMEOUT))
  if (await Promise.race([network.opened, timeout])) return network
  network.close()
  return undefined
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
