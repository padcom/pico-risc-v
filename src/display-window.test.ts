import { describe, expect, it } from 'vitest'
import { openWindow } from './display-window.js'
import { fit } from './fit.js'
import { Framebuffer } from './framebuffer.js'
import { LINUX_KEYS, linuxKeyOfScancode } from './keymap.js'
import type { VirtioInput } from './virtio-input.js'

// A real window (SDL): where the optional package is there, and a display to open it on.
const sdl = await import('@kmamal/sdl').then(m => m.default).catch(() => undefined)

describe('the screen in a window', () => {
  it('keeps its shape: as big as fits, centered', () => {
    expect(fit(1024, 768, 1024, 768)).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
    expect(fit(1024, 768, 2048, 1536)).toEqual({ x: 0, y: 0, width: 2048, height: 1536 })
    expect(fit(1024, 768, 1400, 768)).toEqual({ x: 188, y: 0, width: 1024, height: 768 }) // wider: bars left and right
    expect(fit(1024, 768, 512, 800)).toEqual({ x: 0, y: 208, width: 512, height: 384 }) // taller: above and below
  })

  it("takes keys by their place on the keyboard (USB scancodes, SDL's)", () => {
    // [scancode, KEY_*]: A, Z, 1, 0, Enter, Space, `, F1, F12, Up, keypad 0, the ISO key left of Z
    const keys = [[4, 30], [29, 44], [30, 2], [39, 11], [40, 28], [44, 57], [53, 41], [58, 59], [69, 88], [82, 103], [98, 82], [100, 86]]
    expect(keys.map(([scancode]) => [scancode, linuxKeyOfScancode(scancode!)])).toEqual(keys)
    expect([224, 225, 226, 227, 228, 229, 230, 231].map(linuxKeyOfScancode)).toEqual([
      LINUX_KEYS.ControlLeft, LINUX_KEYS.ShiftLeft, LINUX_KEYS.AltLeft, LINUX_KEYS.MetaLeft,
      LINUX_KEYS.ControlRight, LINUX_KEYS.ShiftRight, LINUX_KEYS.AltRight, LINUX_KEYS.MetaRight,
    ])
    expect(linuxKeyOfScancode(0)).toBeUndefined() // (unknown)
  })

  it.skipIf(!sdl || sdl.video.displays.length === 0)('opens a window that shows the screen, and closes', async () => {
    const screen = new Framebuffer(320, 200, new Uint8Array(Framebuffer.size(320, 200)))
    screen.pixels.fill(0x336699)
    const input = { send: () => {} } as unknown as VirtioInput
    let closed = false
    const window = await openWindow({ output: screen, keyboard: input, tablet: input, setDisplaySize: () => {} }, 'risc-emulator test', () => (closed = true))
    // A few frames: the screen, then a change to it.
    await new Promise(resolve => setTimeout(resolve, 100))
    screen.pixels.fill(0xff8800, 0, 320 * 100)
    await new Promise(resolve => setTimeout(resolve, 100))
    window.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(closed).toBe(true)
  })
})
