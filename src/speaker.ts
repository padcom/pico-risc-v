import { Resampler } from './resample.js'
import type { VirtioSound } from './virtio-sound.js'

/** The rate the speaker plays at. */
const RATE = 48_000
/** Sound queued to play, at most (s): more (the guest got ahead) is dropped, rather than heard later and later. */
const MAX_QUEUED = 0.25
/**
 * Sound queued before it plays (s), from the start, and again whenever it
 * runs out: a cushion for what comes a little late now and then.
 */
const CUSHION = 0.06

/**
 * The sound card's output on this machine's speakers (SDL, through the
 * optional @kmamal/sdl package, as the window). Throws if the package isn't
 * there.
 */
export async function openSpeaker(sound: VirtioSound): Promise<{ close(): void }> {
  const { default: sdl } = await import('@kmamal/sdl')
  const device = sdl.audio.openDevice({ type: 'playback' }, { channels: 2, frequency: RATE, format: 'f32', buffered: 1024 })
  const resampler = new Resampler(device.frequency)
  const bytesPerSecond = device.frequency * 2 * device.bytesPerSample
  sound.output = (samples, rate) => {
    const out = resampler.push(samples, rate)
    if (device.queued > MAX_QUEUED * bytesPerSecond) return
    if (device.playing && device.queued === 0) device.pause()
    device.enqueue(Buffer.from(out.buffer, out.byteOffset, out.byteLength))
    if (!device.playing && device.queued >= CUSHION * bytesPerSecond) device.play()
  }
  return {
    close: () => {
      sound.output = undefined
      device.close()
    },
  }
}
