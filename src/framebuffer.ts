/**
 * A screen: a framebuffer in RAM, as boot firmware leaves one set up for the
 * OS (device tree: simple-framebuffer). The guest draws by writing pixels to
 * memory, at full speed (no device accesses); the host shows what's there,
 * now and then (draw()).
 *
 * Pixels are x8r8g8b8: 32-bit little-endian, blue in the lowest byte, the
 * top byte unused. It's what nearly everything expects (DRM's XRGB8888).
 */
export class Framebuffer {
  /** Bytes per pixel. */
  static readonly BPP = 4
  /** The device tree's name for the pixel format. */
  static readonly FORMAT = 'x8r8g8b8'

  readonly stride: number
  readonly size: number
  /** The pixels, as the guest has them (x8r8g8b8), row by row. */
  readonly pixels: Uint32Array

  /** A `width` × `height` screen over `bytes` (the framebuffer, at least size() long). */
  constructor(
    readonly width: number,
    readonly height: number,
    bytes: Uint8Array,
  ) {
    this.stride = width * Framebuffer.BPP
    this.size = Framebuffer.size(width, height)
    if (bytes.byteOffset % 4 || bytes.length < this.size) throw new RangeError('Framebuffer: memory too small or unaligned')
    this.pixels = new Uint32Array(bytes.buffer, bytes.byteOffset, width * height)
  }

  /** Bytes a `width` × `height` framebuffer takes (rounded up to whole 4 KiB pages). */
  static size(width: number, height: number): number {
    return Math.ceil((width * height * Framebuffer.BPP) / 4096) * 4096
  }

  /**
   * Put the screen into `rgba` (as ImageData has it: R, G, B, A bytes, A
   * opaque), a width × height one; false if it was there already.
   */
  draw(rgba: Uint8ClampedArray | Uint8Array): boolean {
    const target = new Uint32Array(rgba.buffer, rgba.byteOffset, this.pixels.length)
    let changed = false
    for (let i = 0; i < this.pixels.length; i++) {
      const p = this.pixels[i]!
      // xRGB (little-endian: B, G, R, x) → ABGR (R, G, B, A)
      const q = (0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff)) >>> 0
      if (target[i] !== q) {
        target[i] = q
        changed = true
      }
    }
    return changed
  }
}
