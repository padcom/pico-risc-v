import { connect, type Socket } from 'node:net'

/** A rectangle of a FramebufferUpdate, and its pixels (raw, in the client's format). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
  data: Buffer
}

/**
 * A VNC viewer for tests (RFB, raw pixels only): connects, logs in (3.8 or
 * 3.3; no password or VNC authentication), and asks for and reads updates.
 */
export class RfbClient {
  width = 0
  height = 0
  name = ''
  /** What the server offered: its version, its security types (3.8), what it said to the login. */
  version = ''
  securityTypes: number[] = []
  securityResult: number | undefined
  /** Bytes per pixel of the format in use. */
  private bytes = 4
  private input: Buffer = Buffer.alloc(0)
  private waiting: (() => void) | undefined

  private constructor(readonly socket: Socket) {
    socket.on('data', (data: Buffer) => {
      this.input = Buffer.concat([this.input, data])
      this.waiting?.()
    })
    socket.on('close', () => this.waiting?.())
  }

  static async connect(port: number, { version = '003.008', security = 1 } = {}): Promise<RfbClient> {
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
    const client = new RfbClient(socket)
    client.version = (await client.read(12)).toString('latin1')
    socket.write(`RFB ${version}\n`)
    if (version === '003.003') {
      client.securityTypes = [(await client.read(4)).readUInt32BE()]
      if (client.securityTypes[0] === 2) {
        await client.read(16) // the challenge
        socket.write(Buffer.alloc(16)) // the answer: whatever
        client.securityResult = (await client.read(4)).readUInt32BE()
      }
    } else {
      client.securityTypes = [...(await client.read((await client.read(1))[0]!))]
      socket.write(Buffer.from([security]))
      if (security === 2) {
        await client.read(16) // the challenge
        socket.write(Buffer.alloc(16)) // the answer: whatever
      }
      client.securityResult = (await client.read(4)).readUInt32BE()
    }
    socket.write(Buffer.from([1])) // ClientInit: shared
    const init = await client.read(24)
    client.width = init.readUInt16BE(0)
    client.height = init.readUInt16BE(2)
    client.serverFormat = init.subarray(4, 20)
    client.name = (await client.read(init.readUInt32BE(20))).toString()
    return client
  }

  /** ServerInit's PIXEL_FORMAT. */
  serverFormat: Buffer = Buffer.alloc(16)

  /** SetPixelFormat: true colour, `bits` per pixel, little-endian, these maxes and shifts. */
  setPixelFormat(bits: 8 | 16 | 32, max: [number, number, number], shift: [number, number, number]): void {
    const m = Buffer.alloc(20)
    m[0] = 0
    m[4] = bits
    m[5] = bits === 32 ? 24 : bits
    m[6] = 0 // little-endian
    m[7] = 1 // true colour
    max.forEach((value, i) => m.writeUInt16BE(value, 8 + 2 * i))
    shift.forEach((value, i) => (m[14 + i] = value))
    this.socket.write(m)
    this.bytes = bits / 8
  }

  /** SetEncodings: the encodings (and pseudo-encodings: -223 DesktopSize) it takes. */
  setEncodings(encodings: number[]): void {
    const m = Buffer.alloc(4 + 4 * encodings.length)
    m[0] = 2
    m.writeUInt16BE(encodings.length, 2)
    encodings.forEach((e, i) => m.writeInt32BE(e, 4 + 4 * i))
    this.socket.write(m)
  }

  /** Ask for an update (all of the screen, or what changed) and read it. */
  async update(incremental: boolean): Promise<Rect[]> {
    const m = Buffer.alloc(10)
    m[0] = 3
    m[1] = incremental ? 1 : 0
    m.writeUInt16BE(this.width, 6)
    m.writeUInt16BE(this.height, 8)
    this.socket.write(m)
    const head = await this.read(4)
    if (head[0] !== 0) throw new Error(`not a FramebufferUpdate: ${head[0]}`)
    const rects: Rect[] = []
    for (let n = head.readUInt16BE(2); n > 0; n--) {
      const r = await this.read(12)
      const [x, y, w, h] = [0, 2, 4, 6].map(at => r.readUInt16BE(at)) as [number, number, number, number]
      if (r.readInt32BE(8) === -223) {
        // DesktopSize: the screen is w × h now (no pixels).
        ;[this.width, this.height] = [w, h]
        rects.push({ x, y, w, h, data: Buffer.alloc(0) })
        continue
      }
      if (r.readInt32BE(8) !== 0) throw new Error('not raw')
      rects.push({ x, y, w, h, data: Buffer.from(await this.read(w * h * this.bytes)) })
    }
    return rects
  }

  key(keysym: number, down: boolean): void {
    const m = Buffer.alloc(8)
    m[0] = 4
    m[1] = down ? 1 : 0
    m.writeUInt32BE(keysym, 4)
    this.socket.write(m)
  }

  pointer(buttons: number, x: number, y: number): void {
    const m = Buffer.alloc(6)
    m[0] = 5
    m[1] = buttons
    m.writeUInt16BE(x, 2)
    m.writeUInt16BE(y, 4)
    this.socket.write(m)
  }

  close(): void {
    this.socket.destroy()
  }

  private async read(n: number): Promise<Buffer> {
    while (this.input.length < n) {
      if (this.socket.destroyed) throw new Error('connection closed')
      await new Promise<void>(resolve => (this.waiting = resolve))
      this.waiting = undefined
    }
    const bytes = this.input.subarray(0, n)
    this.input = this.input.subarray(n)
    return bytes
  }
}
