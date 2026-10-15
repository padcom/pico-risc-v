import { Resampler } from './resample.js'
import type { VirtioSound } from './virtio-sound.js'

/** Sound queued to play, at most (s): more (the guest got ahead) is dropped, rather than heard later and later. */
const MAX_QUEUED = 0.25
/**
 * Sound queued before it plays (s), from the start, and again whenever it
 * runs out: a cushion for what comes a little late now and then.
 */
const CUSHION = 0.06

/**
 * Plays chunks of stereo samples (posted to its port, at the context's rate)
 * as they come, once there are enough (CUSHION); silence when there aren't.
 */
const SPEAKER = `
class Speaker extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.offset = 0
    this.queued = 0
    this.waiting = true
    this.port.onmessage = ({ data }) => {
      if (this.queued > ${MAX_QUEUED} * sampleRate * 2) return
      this.chunks.push(data)
      this.queued += data.length
    }
  }
  process(inputs, [[left, right]]) {
    if (this.waiting && this.queued >= ${CUSHION} * sampleRate * 2) this.waiting = false
    for (let i = 0; i < left.length; i++) {
      const chunk = this.waiting ? undefined : this.chunks[0]
      if (!chunk) {
        this.waiting = true
        left[i] = right[i] = 0
        continue
      }
      left[i] = chunk[this.offset]
      right[i] = chunk[this.offset + 1]
      this.offset += 2
      this.queued -= 2
      if (this.offset >= chunk.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('speaker', Speaker)
`

/**
 * The sound card's output on the page (Web Audio). Browsers let a page make
 * sound only once it's been used: it starts with the first click or key
 * press (till then, what's played isn't heard).
 */
export function playOnPage(sound: VirtioSound): void {
  let speaker: { node: AudioWorkletNode; resampler: Resampler } | undefined
  let starting: Promise<void> | undefined
  const start = () => {
    starting ??= (async () => {
      const context = new AudioContext()
      const url = URL.createObjectURL(new Blob([SPEAKER], { type: 'text/javascript' }))
      await context.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      const node = new AudioWorkletNode(context, 'speaker', { numberOfInputs: 0, outputChannelCount: [2] })
      node.connect(context.destination)
      speaker = { node, resampler: new Resampler(context.sampleRate) }
      await context.resume()
    })().catch(() => {})
    removeEventListener('pointerdown', start, true)
    removeEventListener('keydown', start, true)
  }
  addEventListener('pointerdown', start, true)
  addEventListener('keydown', start, true)
  sound.output = (samples, rate) => {
    if (!speaker) return
    const out = speaker.resampler.push(samples, rate).slice()
    speaker.node.port.postMessage(out, [out.buffer])
  }
}
