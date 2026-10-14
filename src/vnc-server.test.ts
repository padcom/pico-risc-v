import { afterEach, describe, expect, it } from 'vitest'
import { RfbClient } from '../test/rfb-client.js'
import { Framebuffer } from './framebuffer.js'
import { linuxKey } from './keysyms.js'
import { Input, TABLET_MAX, type VirtioInput } from './virtio-input.js'
import { VncServer } from './vnc-server.js'

const WIDTH = 100
const HEIGHT = 70

describe('VNC server', () => {
  let server: VncServer | undefined
  let client: RfbClient | undefined
  afterEach(() => {
    client?.close()
    server?.close()
  })

  /** A server for a small screen, whose keyboard and tablet keep what they're sent. */
  async function start() {
    const memory = new Uint8Array(Framebuffer.size(WIDTH, HEIGHT))
    const screen = new Framebuffer(WIDTH, HEIGHT, memory)
    const keys: number[][] = []
    const pointer: number[][] = []
    const device = (events: number[][]) => ({ send: (...sent: number[][]) => events.push(...sent) }) as unknown as VirtioInput
    server = new VncServer({ output: screen, keyboard: device(keys), tablet: device(pointer), setDisplaySize: () => {} }, 'test')
    const port = await server.listen(0)
    return { screen, keys, pointer, port }
  }
  /** Wait until `done()`. */
  const until = async (done: () => boolean) => {
    for (let i = 0; !done(); i++) {
      if (i > 200) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('lets viewers in: 3.8 with no password, or with any (VNC authentication); 3.3 with any; tells them the screen', async () => {
    const { port } = await start()
    client = await RfbClient.connect(port)
    expect([client.version, client.securityTypes, client.securityResult]).toEqual(['RFB 003.008\n', [1, 2], 0])
    expect([client.width, client.height, client.name]).toEqual([WIDTH, HEIGHT, 'test'])
    // 32 bits per pixel, depth 24, little-endian, true colour, 255 each, red at 16, green 8, blue 0
    expect([...client.serverFormat.subarray(0, 13)]).toEqual([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0])
    client.close()
    client = await RfbClient.connect(port, { security: 2 })
    expect(client.securityResult).toBe(0)
    client.close()
    client = await RfbClient.connect(port, { version: '003.003' }) // (macOS's Screen Sharing)
    expect([client.securityTypes, client.securityResult, client.width]).toEqual([[2], 0, WIDTH])
    client.close()
    client = await RfbClient.connect(port, { version: '003.889' }) // (Apple's)
    expect(client.securityResult).toBe(0)
  })

  it('sends the whole screen, then only what changed, when it changes', async () => {
    const { screen, port } = await start()
    screen.pixels[0] = 0x00ff8040
    client = await RfbClient.connect(port)
    const [all, ...more] = await client.update(false)
    expect(more).toEqual([])
    expect([all!.x, all!.y, all!.w, all!.h]).toEqual([0, 0, WIDTH, HEIGHT])
    expect([...all!.data.subarray(0, 4)]).toEqual([0x40, 0x80, 0xff, 0x00])

    // In tiles of 64 × 64: (70, 10) is in the one from x 64 (to the edge, 100).
    screen.pixels[10 * WIDTH + 70] = 0x123456
    const changed = await client.update(true)
    expect(changed.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([[64, 0, 36, 64]])
    expect(changed[0]!.data.readUInt32LE((10 * 36 + 6) * 4)).toBe(0x123456)

    // Nothing changed: the answer waits until something does.
    const later = client.update(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    screen.pixels[65 * WIDTH + 5] = 1
    expect((await later).map(({ x, y, w, h }) => [x, y, w, h])).toEqual([[0, 64, 64, 6]])
  })

  it("sends pixels in the viewer's format", async () => {
    const { screen, port } = await start()
    screen.pixels[1] = 0x00ff8040
    client = await RfbClient.connect(port)
    client.setPixelFormat(16, [31, 63, 31], [11, 5, 0]) // RGB 5:6:5
    const [all] = await client.update(false)
    // 255 → 31, 0x80 → 32 (of 63), 0x40 → 8 (of 31)
    expect(all!.data.readUInt16LE(2)).toBe((31 << 11) | (32 << 5) | 8)
  })

  it('passes keys on, by the key that types them (US layout), released as pressed', async () => {
    const { keys, port } = await start()
    client = await RfbClient.connect(port)
    client.key(0x61, true) // a
    client.key(0x61, false)
    client.key(0xffe1, true) // Shift_L
    client.key(0x21, true) // !: on 1
    client.key(0xffe1, false)
    client.key(0x31, false) // released as 1
    client.key(0xff0d, true) // Return
    client.key(0x20ac, true) // € (not a key here)
    client.key(0x20ac, false)
    await until(() => keys.length >= 7)
    expect(keys).toEqual([
      [Input.EV_KEY, 30, 1],
      [Input.EV_KEY, 30, 0],
      [Input.EV_KEY, 42, 1],
      [Input.EV_KEY, 2, 1],
      [Input.EV_KEY, 42, 0],
      [Input.EV_KEY, 2, 0],
      [Input.EV_KEY, 28, 1],
    ])
    // A viewer leaving lets go of what it held.
    client.close()
    await until(() => keys.length >= 8)
    expect(keys[7]).toEqual([Input.EV_KEY, 28, 0])
  })

  it('passes the mouse on: where it is (on the tablet), buttons, the wheel', async () => {
    const { pointer, port } = await start()
    client = await RfbClient.connect(port)
    const at = (x: number, y: number) => [
      [Input.EV_ABS, Input.ABS_X, x],
      [Input.EV_ABS, Input.ABS_Y, y],
    ]
    client.pointer(0, WIDTH - 1, HEIGHT - 1)
    client.pointer(1, 0, 0) // left down
    client.pointer(0b101, 0, 0) // and right
    client.pointer(0b1000, 0, 0) // both up, wheel up
    client.pointer(0, 0, 0)
    await until(() => pointer.length >= 15)
    expect(pointer).toEqual([
      ...at(TABLET_MAX, TABLET_MAX),
      ...at(0, 0),
      [Input.EV_KEY, Input.BTN_LEFT, 1],
      ...at(0, 0),
      [Input.EV_KEY, Input.BTN_RIGHT, 1],
      ...at(0, 0),
      [Input.EV_KEY, Input.BTN_LEFT, 0],
      [Input.EV_KEY, Input.BTN_RIGHT, 0],
      [Input.EV_REL, Input.REL_WHEEL, 1],
      ...at(0, 0),
    ])
  })

  it('tells a viewer that can be told (DesktopSize) that the screen got another size, then sends it all', async () => {
    let screen = new Framebuffer(WIDTH, HEIGHT, new Uint8Array(Framebuffer.size(WIDTH, HEIGHT)))
    const input = { send: () => {} } as unknown as VirtioInput
    server = new VncServer({ get output() { return screen }, keyboard: input, tablet: input, setDisplaySize: () => {} }, 'test')
    const port = await server.listen(0)
    client = await RfbClient.connect(port)
    const other = await RfbClient.connect(port) // (one that can't be told)
    try {
      client.setEncodings([0, -223])
      other.setEncodings([0])
      await client.update(false)
      await other.update(false)
      screen = new Framebuffer(120, 40, new Uint8Array(Framebuffer.size(120, 40)))
      screen.pixels.fill(0x777777)
      const [resized] = await client.update(true)
      expect([resized!.w, resized!.h, client.width, client.height]).toEqual([120, 40, 120, 40])
      const all = await client.update(true)
      expect(all.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([[0, 0, 120, 40]])
      // The other keeps its size, and gets what fits (100 × 40).
      const fits = await other.update(true)
      expect([other.width, other.height]).toEqual([WIDTH, HEIGHT])
      expect(fits.every(({ x, w, y, h }) => x + w <= 100 && y + h <= 40)).toBe(true)
    } finally {
      other.close()
    }
  })

  it('knows the keys of keysyms: characters, shifted ones, and keys that type none', () => {
    expect(['q', 'Q', '1', '!', '/', '?', ' '].map(c => linuxKey(c.charCodeAt(0)))).toEqual([16, 16, 2, 2, 53, 53, 57])
    expect([0xff1b, 0xff08, 0xff52, 0xffe3, 0xffbe, 0xffc9].map(linuxKey)).toEqual([1, 14, 103, 29, 59, 88])
    expect(linuxKey(0xe9)).toBeUndefined() // é
  })
})
