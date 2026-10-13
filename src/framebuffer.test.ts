import { describe, expect, it } from 'vitest'
import { Framebuffer } from './framebuffer.js'

describe('Framebuffer', () => {
  it('takes whole pages', () => {
    expect(Framebuffer.size(1024, 768)).toBe(1024 * 768 * 4)
    expect(Framebuffer.size(3, 3)).toBe(4096)
  })

  it('draws x8r8g8b8 pixels as opaque RGBA, and says whether anything changed', () => {
    const memory = new Uint8Array(Framebuffer.size(2, 2))
    const screen = new Framebuffer(2, 2, memory)
    expect(screen.stride).toBe(8)
    const rgba = new Uint8ClampedArray(2 * 2 * 4)
    expect(screen.draw(rgba)).toBe(true)
    expect([...rgba]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
    expect(screen.draw(rgba)).toBe(false)

    // Little-endian xRGB: B, G, R, x (whatever x is).
    memory.set([0x30, 0x20, 0x10, 0x00], 4)
    memory.set([0x00, 0x00, 0xff, 0x77], 12)
    expect(screen.draw(rgba)).toBe(true)
    expect([...rgba]).toEqual([0, 0, 0, 255, 0x10, 0x20, 0x30, 255, 0, 0, 0, 255, 0xff, 0, 0, 255])
    expect(screen.draw(rgba)).toBe(false)
  })
})
