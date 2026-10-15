/**
 * Stereo sound (float samples, left and right in turn) from whatever rate it
 * comes at to one rate (`to`, the host's), by linear interpolation, carried
 * on from one chunk to the next.
 */
export class Resampler {
  /**
   * The last frame of the previous chunk, and how far past it the next
   * output frame is (in input frames: 1 is this chunk's first).
   */
  private last = [0, 0]
  private at = 0
  private rate = 0

  constructor(readonly to: number) {}

  push(samples: Float32Array, rate: number): Float32Array {
    if (rate === this.to) return samples
    if (rate !== this.rate) {
      this.rate = rate
      this.at = 0
    }
    const frames = samples.length / 2
    const step = rate / this.to
    // Frame i of the input, -1 being the previous chunk's last.
    const frame = (i: number, c: number) => (i < 0 ? this.last[c]! : samples[2 * i + c]!)
    const out = new Float32Array(2 * Math.max(0, Math.ceil((frames - this.at) / step)))
    let n = 0
    for (; this.at < frames && n < out.length / 2; this.at += step, n++) {
      const i = Math.floor(this.at)
      const t = this.at - i
      for (let c = 0; c < 2; c++) out[2 * n + c] = frame(i - 1, c) * (1 - t) + frame(i, c) * t
    }
    this.at -= frames
    if (frames) this.last = [samples[2 * frames - 2]!, samples[2 * frames - 1]!]
    return out.subarray(0, 2 * n)
  }
}
