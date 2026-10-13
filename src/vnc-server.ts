import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { Framebuffer } from './framebuffer.js'
import { linuxKey } from './keysyms.js'
import { Input, TABLET_MAX, type VirtioInput } from './virtio-input.js'

/** What a VNC server shows and passes input to (a Machine with a screen). */
export interface Display {
  screen: Framebuffer
  keyboard: VirtioInput
  tablet: VirtioInput
}

/** How often to look for changes on the screen to send (ms). */
const FRAME = 30
/** Changes are found, and sent, in tiles this many pixels square. */
const TILE = 64

/** A client's pixel format (RFB's PIXEL_FORMAT): true colour only. */
interface PixelFormat {
  bytes: 1 | 2 | 4
  bigEndian: boolean
  max: [number, number, number]
  shift: [number, number, number]
}
/** The screen's own: x8r8g8b8, little-endian (Framebuffer). */
const NATIVE: PixelFormat = { bytes: 4, bigEndian: false, max: [255, 255, 255], shift: [16, 8, 0] }

/**
 * A VNC server (the RFB protocol, 3.3 to 3.8, Apple's 3.889 as 3.8): shows
 * the machine's screen to VNC viewers (macOS's Screen Sharing, TigerVNC,
 * ...), and passes their keys and mouse on to its keyboard and tablet. Raw
 * pixels, in the viewer's format, only what changed: it's meant for this
 * machine (it listens on localhost).
 *
 * No password: viewers that insist on one (Screen Sharing) are offered VNC
 * authentication too, and any password does.
 */
export class VncServer {
  private readonly server: Server
  private readonly clients = new Set<Client>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly display: Display,
    private readonly name = 'risc-emulator',
  ) {
    this.server = createServer(socket => {
      const client = new Client(socket, this.display, this.name)
      this.clients.add(client)
      socket.on('close', () => this.clients.delete(client))
    })
    this.timer = setInterval(() => {
      for (const client of this.clients) client.update()
    }, FRAME)
    this.timer.unref()
  }

  /** Listen on `port` (0: any free one) of `host`; resolves with the port. */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        resolve((this.server.address() as { port: number }).port)
      })
    })
  }

  close(): void {
    clearInterval(this.timer)
    for (const client of this.clients) client.close()
    this.server.close()
  }
}

/** One viewer's connection. */
class Client {
  private input: Buffer = Buffer.alloc(0)
  private state: 'version' | 'security' | 'password' | 'init' | 'ready' = 'version'
  private minor = 8
  private format = NATIVE
  /** A FramebufferUpdateRequest to answer: incremental (only what changed), or all of it. */
  private request: 'incremental' | 'full' | undefined
  /** The screen as the viewer has it (what was last sent). */
  private readonly sent: Uint32Array
  /** Mouse buttons held (RFB's button mask). */
  private buttons = 0
  /** Keys held: the KEY_* each keysym pressed. */
  private readonly keys = new Map<number, number>()

  constructor(
    private readonly socket: Socket,
    private readonly display: Display,
    private readonly name: string,
  ) {
    this.sent = new Uint32Array(display.screen.width * display.screen.height)
    socket.setNoDelay(true)
    socket.on('data', (data: Buffer) => {
      this.input = Buffer.concat([this.input, data])
      try {
        while (this.step());
      } catch {
        this.close()
      }
    })
    socket.on('error', () => this.close())
    socket.on('close', () => this.letGo())
    socket.write('RFB 003.008\n')
  }

  close(): void {
    this.socket.destroy()
  }

  /** Send what changed, if the viewer asked for it. */
  update(): void {
    if (this.request !== 'incremental' || this.socket.writableLength) return
    const rects = this.changes()
    if (rects.length) this.send(rects)
  }

  /** Take one thing from the input; false if it isn't all there yet. */
  private step(): boolean {
    const take = (n: number) => {
      if (this.input.length < n) return undefined
      const bytes = this.input.subarray(0, n)
      this.input = this.input.subarray(n)
      return bytes
    }
    switch (this.state) {
      case 'version': {
        const version = take(12)
        if (!version) return false
        const minor = Number(/^RFB 003\.(\d{3})\n$/.exec(version.toString('latin1'))?.[1])
        if (!minor) throw new Error('not RFB')
        this.minor = minor >= 8 ? 8 : minor >= 7 ? 7 : 3
        if (this.minor === 3) {
          // 3.3: the server says which: none.
          this.socket.write(u32(1))
          this.state = 'init'
        } else {
          this.socket.write(Buffer.from([2, 1, 2])) // None, VNC authentication
          this.state = 'security'
        }
        return true
      }
      case 'security': {
        const type = take(1)?.[0]
        if (type === undefined) return false
        if (type === 2) {
          this.socket.write(randomBytes(16)) // the challenge
          this.state = 'password'
        } else if (type === 1) {
          if (this.minor === 8) this.socket.write(u32(0)) // OK
          this.state = 'init'
        } else throw new Error('unknown security type')
        return true
      }
      case 'password':
        if (!take(16)) return false
        this.socket.write(u32(0)) // OK: any password
        this.state = 'init'
        return true
      case 'init': {
        if (!take(1)) return false // shared flag
        const { width, height } = this.display.screen
        const name = Buffer.from(this.name)
        const init = Buffer.alloc(24)
        init.writeUInt16BE(width, 0)
        init.writeUInt16BE(height, 2)
        writeFormat(init, 4, NATIVE)
        init.writeUInt32BE(name.length, 20)
        this.socket.write(Buffer.concat([init, name]))
        this.state = 'ready'
        return true
      }
      case 'ready':
        return this.message(take)
    }
  }

  /** A client message (RFB 7.5). */
  private message(take: (n: number) => Buffer | undefined): boolean {
    const peek = (n: number) => (this.input.length >= n ? this.input : undefined)
    switch (this.input[0]) {
      case undefined:
        return false
      case 0: {
        // SetPixelFormat
        const m = take(20)
        if (!m) return false
        this.format = readFormat(m, 4)
        this.request = undefined
        return true
      }
      case 2: {
        // SetEncodings (raw it is, whatever they are)
        const head = peek(4)
        if (!head) return false
        return take(4 + 4 * head.readUInt16BE(2)) !== undefined
      }
      case 3: {
        // FramebufferUpdateRequest
        const m = take(10)
        if (!m) return false
        if (m[1]) this.request ??= 'incremental'
        else this.request = 'full'
        if (this.request === 'full') this.send([[0, 0, this.display.screen.width, this.display.screen.height]])
        return true
      }
      case 4: {
        // KeyEvent
        const m = take(8)
        if (!m) return false
        this.key(m.readUInt32BE(4), m[1] !== 0)
        return true
      }
      case 5: {
        // PointerEvent
        const m = take(6)
        if (!m) return false
        this.pointer(m[1]!, m.readUInt16BE(2), m.readUInt16BE(4))
        return true
      }
      case 6: {
        // ClientCutText: ignored
        const head = peek(8)
        if (!head) return false
        return take(8 + head.readUInt32BE(4)) !== undefined
      }
      default:
        throw new Error(`unknown message ${this.input[0]}`)
    }
  }

  private key(keysym: number, down: boolean): void {
    if (down) {
      const key = this.keys.get(keysym) ?? linuxKey(keysym)
      if (key === undefined) return
      this.keys.set(keysym, key)
      // (Held down, viewers send it again and again: Linux takes a press of a
      // key that's down as nothing, and repeats it itself.)
      this.display.keyboard.send([Input.EV_KEY, key, 1])
    } else {
      // The key it pressed; or the one it would be on, pressed under another
      // keysym ("!" with Shift, released as "1" after Shift).
      const key = this.keys.get(keysym) ?? linuxKey(keysym)
      if (key === undefined) return
      let held = false
      for (const [sym, k] of this.keys) {
        if (k !== key) continue
        this.keys.delete(sym)
        held = true
      }
      if (held) this.display.keyboard.send([Input.EV_KEY, key, 0])
    }
  }

  /** RFB's buttons (mask bits): left, middle, right, then wheel up, down, left, right. */
  private pointer(mask: number, x: number, y: number): void {
    const { width, height } = this.display.screen
    const scale = (value: number, size: number) => Math.round((Math.min(value, size - 1) / Math.max(size - 1, 1)) * TABLET_MAX)
    const events: [number, number, number][] = [
      [Input.EV_ABS, Input.ABS_X, scale(x, width)],
      [Input.EV_ABS, Input.ABS_Y, scale(y, height)],
    ]
    const BUTTONS = [Input.BTN_LEFT, Input.BTN_MIDDLE, Input.BTN_RIGHT]
    BUTTONS.forEach((button, bit) => {
      if ((mask ^ this.buttons) & (1 << bit)) events.push([Input.EV_KEY, button, (mask >> bit) & 1])
    })
    // The wheel: a notch each time its bit goes on.
    const pressed = mask & ~this.buttons
    if (pressed & 0x08) events.push([Input.EV_REL, Input.REL_WHEEL, 1])
    if (pressed & 0x10) events.push([Input.EV_REL, Input.REL_WHEEL, -1])
    if (pressed & 0x20) events.push([Input.EV_REL, Input.REL_HWHEEL, -1])
    if (pressed & 0x40) events.push([Input.EV_REL, Input.REL_HWHEEL, 1])
    this.buttons = mask
    this.display.tablet.send(...events)
  }

  /** The viewer is gone: let go of what it held. */
  private letGo(): void {
    for (const key of this.keys.values()) this.display.keyboard.send([Input.EV_KEY, key, 0])
    this.keys.clear()
    if (this.buttons & 7) this.pointer(0, 0, 0)
  }

  /** The tiles that changed since they were sent, as rectangles (runs of them in a row). */
  private changes(): [x: number, y: number, w: number, h: number][] {
    const { width, height, pixels } = this.display.screen
    const rects: [number, number, number, number][] = []
    const tiles = Math.ceil(width / TILE)
    for (let top = 0; top < height; top += TILE) {
      const h = Math.min(TILE, height - top)
      let run: number | undefined
      // (One past the last tile: ends a run that goes to the right edge.)
      for (let tile = 0; tile <= tiles; tile++) {
        const left = tile * TILE
        const changed = tile < tiles && differs(pixels, this.sent, width, left, top, Math.min(TILE, width - left), h)
        if (changed) run ??= left
        else if (run !== undefined) {
          rects.push([run, top, left - run, h])
          run = undefined
        }
      }
    }
    return rects.map(([x, y, w, h]) => [x, y, Math.min(w, width - x), h])
  }

  /** A FramebufferUpdate with these rectangles (raw), which the viewer then has. */
  private send(rects: [x: number, y: number, w: number, h: number][]): void {
    const { width, pixels } = this.display.screen
    const parts: Buffer[] = [Buffer.from([0, 0, rects.length >> 8, rects.length & 0xff])]
    for (const [x, y, w, h] of rects) {
      const header = Buffer.alloc(12)
      header.writeUInt16BE(x, 0)
      header.writeUInt16BE(y, 2)
      header.writeUInt16BE(w, 4)
      header.writeUInt16BE(h, 6)
      header.writeInt32BE(0, 8) // raw
      const data = Buffer.alloc(w * h * this.format.bytes)
      for (let row = 0; row < h; row++) {
        const from = (y + row) * width + x
        const line = pixels.subarray(from, from + w)
        this.sent.set(line, from)
        encode(line, data, row * w * this.format.bytes, this.format)
      }
      parts.push(header, data)
    }
    this.request = undefined
    this.socket.write(Buffer.concat(parts))
  }
}

/** Whether a w × h tile at (x, y) differs between `a` and `b` (screens `width` wide). */
function differs(a: Uint32Array, b: Uint32Array, width: number, x: number, y: number, w: number, h: number): boolean {
  for (let row = y; row < y + h; row++) {
    for (let i = row * width + x, end = i + w; i < end; i++) if (a[i] !== b[i]) return true
  }
  return false
}

/** x8r8g8b8 pixels into `out` at `at`, in `format`. */
function encode(pixels: Uint32Array, out: Buffer, at: number, format: PixelFormat): void {
  if (format === NATIVE || sameFormat(format, NATIVE)) {
    out.set(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), at)
    return
  }
  const [rMax, gMax, bMax] = format.max
  const [rShift, gShift, bShift] = format.shift
  for (const p of pixels) {
    const value =
      ((Math.round((((p >>> 16) & 0xff) * rMax) / 255) << rShift) |
        (Math.round((((p >>> 8) & 0xff) * gMax) / 255) << gShift) |
        (Math.round(((p & 0xff) * bMax) / 255) << bShift)) >>>
      0
    if (format.bytes === 4) format.bigEndian ? out.writeUInt32BE(value, at) : out.writeUInt32LE(value, at)
    else if (format.bytes === 2) format.bigEndian ? out.writeUInt16BE(value & 0xffff, at) : out.writeUInt16LE(value & 0xffff, at)
    else out[at] = value & 0xff
    at += format.bytes
  }
}

function sameFormat(a: PixelFormat, b: PixelFormat): boolean {
  return a.bytes === b.bytes && a.bigEndian === b.bigEndian && a.max.every((m, i) => m === b.max[i]) && a.shift.every((s, i) => s === b.shift[i])
}

/** PIXEL_FORMAT (16 bytes) at `at`. */
function readFormat(m: Buffer, at: number): PixelFormat {
  const bits = m[at]!
  if (![8, 16, 32].includes(bits) || !m[at + 3]) throw new Error('unsupported pixel format') // (true colour only)
  return {
    bytes: (bits / 8) as 1 | 2 | 4,
    bigEndian: m[at + 2] !== 0,
    max: [m.readUInt16BE(at + 4), m.readUInt16BE(at + 6), m.readUInt16BE(at + 8)],
    shift: [m[at + 10]!, m[at + 11]!, m[at + 12]!],
  }
}

function writeFormat(out: Buffer, at: number, format: PixelFormat): void {
  out[at] = format.bytes * 8 // bits per pixel
  out[at + 1] = 24 // depth
  out[at + 2] = format.bigEndian ? 1 : 0
  out[at + 3] = 1 // true colour
  format.max.forEach((max, i) => out.writeUInt16BE(max, at + 4 + 2 * i))
  format.shift.forEach((shift, i) => (out[at + 10 + i] = shift))
}

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
