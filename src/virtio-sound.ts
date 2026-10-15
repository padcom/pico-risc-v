import { length, VirtioMmioDevice, type Chain, type GuestMemory, type Segment, type Virtqueue } from './virtio.js'

// Queues
const CONTROL = 0
const TX = 2 // (1: events, of which there are none; 3: recording, which there isn't)

// Requests (struct virtio_snd_hdr's code) and statuses (include/uapi/linux/virtio_snd.h)
const R_JACK_INFO = 0x0001
const R_PCM_INFO = 0x0100
const R_PCM_SET_PARAMS = 0x0101
const R_PCM_PREPARE = 0x0102
const R_PCM_RELEASE = 0x0103
const R_PCM_START = 0x0104
const R_PCM_STOP = 0x0105
const R_CHMAP_INFO = 0x0200
const S_OK = 0x8000
const S_BAD_MSG = 0x8001
const S_NOT_SUPP = 0x8002

/** Sample formats (VIRTIO_SND_PCM_FMT_*) taken, and their bytes per sample. */
const FORMATS: Record<number, number> = { 3: 1, 4: 1, 5: 2, 17: 4, 19: 4 } // S8, U8, S16, S32, FLOAT
/** Frame rates (VIRTIO_SND_PCM_RATE_*) taken. */
const RATES: Record<number, number> = { 1: 8000, 2: 11025, 3: 16000, 4: 22050, 5: 32000, 6: 44100, 7: 48000 }
/** struct virtio_snd_pcm_info, struct virtio_snd_chmap_info: their sizes. */
const PCM_INFO = 32
const CHMAP_INFO = 24
/**
 * How long before it has played a message goes back (µs), unless it's the
 * last: how far ahead the guest keeps the sound (see VirtioSound).
 */
const LEAD = 50_000
/** Channel positions (VIRTIO_SND_CHMAP_*): front left, front right. */
const FL = 3
const FR = 4

/** A message of sound to play: where its status goes, and when it's done playing (µs). */
interface Playing {
  head: number
  status: Segment[]
  bytes: number
  frames: Float32Array
  done: number
}

/**
 * A virtio sound card (Linux's virtio_snd, an ALSA driver): one output
 * stream (PCM), 1 or 2 channels of 8-, 16- or 32-bit or float samples, 8 to
 * 48 kHz. What the guest plays goes to `output`, as stereo float samples
 * (-1 to 1, left and right in turn) at its rate.
 *
 * The guest sends the sound in messages (a period each, as ALSA has them),
 * which play one after another on the machine's clock (`now`, in µs); each
 * is handed back as it plays, which is what keeps the guest's programs going
 * at the sound's own pace. tick() hands back those that are due; dueIn()
 * says when the next is. A message goes back a while (LEAD) before it has
 * played: a program keeps a short buffer (SDL's, two periods of 10 ms or
 * so), and the next message comes a little late now and then, as the host
 * and the emulated machine take their time (the page's main thread, which
 * serves the devices, most of all); were they handed back once played, its
 * buffer would run dry then, or the device would, and the sound would have
 * gaps (and less of it come than plays: the host's own buffer would run
 * dry). Ahead by LEAD, it's late only when later than that. The last one
 * goes back once it has played, so that the guest knows when all of it has
 * (aplay ends then, say).
 *
 * No jacks, no recording, no controls (volume: the host's).
 */
export class VirtioSound extends VirtioMmioDevice {
  protected readonly deviceId = 25
  /** Where what's played goes (as it comes; the host plays it as it can). */
  output: ((samples: Float32Array, rate: number) => void) | undefined
  private params: { channels: number; format: number; rate: number } | undefined
  private running = false
  /** Messages played or waiting to (until START), in order. */
  private playing: Playing[] = []
  /** When what's been sent so far ends (µs): the next message plays from then. */
  private end = 0

  constructor(
    memory: GuestMemory,
    irq: (high: boolean) => void,
    private readonly now: () => number,
  ) {
    super(memory, irq, [64, 64, 256, 64])
  }

  override reset(): void {
    super.reset()
    this.params = undefined
    this.running = false
    this.playing = []
  }

  /** µs until a message is due to go back (Infinity if none is going). */
  dueIn(): number {
    const next = this.running && this.playing.length ? this.handBackAt(0) : Infinity
    return next === Infinity ? Infinity : Math.max(0, next - this.now())
  }

  /** Hand back the messages that are due. */
  tick(): void {
    if (!this.running || !this.playing.length || this.handBackAt(0) > this.now()) return
    const now = this.now()
    this.guarded(() => {
      while (this.playing.length && this.handBackAt(0) <= now) this.handBack(this.playing.shift()!)
      this.signalUsed()
    })
  }

  /** When message `i` goes back: LEAD before it has played; the last, once it has. */
  private handBackAt(i: number): number {
    const { done } = this.playing[i]!
    return i === this.playing.length - 1 ? done : done - LEAD
  }

  protected deviceFeatures(): number {
    return 0
  }

  /** struct virtio_snd_config: jacks, streams, chmaps (controls: only with VIRTIO_SND_F_CTLS). */
  protected readConfig(offset: number): number {
    return offset === 4 || offset === 8 ? 1 : 0
  }

  protected queueNotified(index: number): void {
    const q = this.queues[index]!
    if (index === CONTROL) {
      let handled = false
      for (let chain = q.pop(); chain; chain = q.pop()) {
        q.push(chain.head, this.control(q, chain))
        handled = true
      }
      if (handled) this.signalUsed()
    } else if (index === TX) {
      for (let chain = q.pop(); chain; chain = q.pop()) this.take(q, chain)
      this.tick()
    }
    // (Event buffers just stay.)
  }

  /** Carry out a control request; returns the bytes of the response written. */
  private control(q: Virtqueue, chain: Chain): number {
    const request = q.read(chain.readable)
    const view = new DataView(request.buffer)
    const u32 = (at: number) => (request.length >= at + 4 ? view.getUint32(at, true) : -1)
    const answer = (status: number, data = new Uint8Array(0)) => {
      const response = new Uint8Array(4 + data.length)
      new DataView(response.buffer).setUint32(0, status, true)
      response.set(data, 4)
      return q.write(chain.writable, response.subarray(0, Math.min(response.length, length(chain.writable))))
    }
    const code = u32(0)
    if (code === R_PCM_INFO || code === R_CHMAP_INFO || code === R_JACK_INFO) {
      // struct virtio_snd_query_info: start_id, count, size. One stream, one channel map, no jacks.
      const [start, count, size] = [u32(4), u32(8), u32(12)]
      const items = code === R_JACK_INFO ? 0 : 1
      if (start < 0 || count < 0 || start + count > items || size <= 0 || size > 1024) return answer(S_BAD_MSG)
      const data = new Uint8Array(count * size)
      for (let i = 0; i < count; i++) data.set((code === R_PCM_INFO ? pcmInfo() : chmapInfo()).subarray(0, size), i * size)
      return answer(S_OK, data)
    }
    // struct virtio_snd_pcm_hdr: stream_id. (Stream 0, the only one.)
    if (code >= R_PCM_SET_PARAMS && code <= R_PCM_STOP && u32(4) !== 0) return answer(S_BAD_MSG)
    switch (code) {
      case R_PCM_SET_PARAMS: {
        if (request.length < 24) return answer(S_BAD_MSG)
        // buffer_bytes, period_bytes, features, then channels, format, rate.
        const [channels, format, rate] = [request[20]!, request[21]!, request[22]!]
        if (channels < 1 || channels > 2 || !(format in FORMATS) || !(rate in RATES) || u32(16) !== 0) return answer(S_NOT_SUPP)
        this.params = { channels, format, rate: RATES[rate]! }
        return answer(S_OK)
      }
      case R_PCM_PREPARE:
        if (!this.params) return answer(S_BAD_MSG)
        this.release()
        return answer(S_OK)
      case R_PCM_RELEASE:
        this.release()
        return answer(S_OK)
      case R_PCM_START:
        if (!this.params) return answer(S_BAD_MSG)
        this.running = true
        this.end = this.now()
        for (const message of this.playing) this.play(message)
        return answer(S_OK)
      case R_PCM_STOP:
        // (What's been sent plays on: messages go back when it has, or at RELEASE.)
        this.running = false
        return answer(S_OK)
      default:
        return answer(S_NOT_SUPP)
    }
  }

  /** Take a message of sound (struct virtio_snd_pcm_xfer, the samples; the status after them). */
  private take(q: Virtqueue, chain: Chain): void {
    const data = q.read(chain.readable)
    const message: Playing = { head: chain.head, status: chain.writable, bytes: data.length - 4, frames: new Float32Array(0), done: Infinity }
    if (!this.params || data.length < 4 || new DataView(data.buffer).getUint32(0, true) !== 0) {
      this.handBack(message, S_BAD_MSG)
      this.signalUsed()
      return
    }
    message.frames = stereo(data.subarray(4), this.params.channels, this.params.format)
    this.playing.push(message)
    if (this.running) this.play(message)
  }

  /** Send a message's sound to the output, and work out when it's done playing. */
  private play(message: Playing): void {
    if (message.done !== Infinity || !this.params) return
    const rate = this.params.rate
    // From where the last one ends (or now, if the guest fell behind).
    const start = Math.max(this.end, this.now())
    this.end = message.done = start + ((message.frames.length / 2) * 1e6) / rate
    this.output?.(message.frames, rate)
  }

  /** Hand all messages back (as played): the stream is stopped for good. */
  private release(): void {
    this.running = false
    if (!this.playing.length) return
    for (const message of this.playing) this.handBack(message)
    this.playing = []
    this.signalUsed()
  }

  /** struct virtio_snd_pcm_status: status, latency_bytes (none: it has played). */
  private handBack(message: Playing, status = S_OK): void {
    const q = this.queues[TX]!
    const response = new Uint8Array(8)
    new DataView(response.buffer).setUint32(0, status, true)
    q.push(message.head, q.write(message.status, response))
  }
}

/** struct virtio_snd_pcm_info: the stream's (an output). */
function pcmInfo(): Uint8Array {
  const info = new Uint8Array(PCM_INFO)
  const view = new DataView(info.buffer)
  view.setBigUint64(8, Object.keys(FORMATS).reduce((bits, f) => bits | (1n << BigInt(f)), 0n), true)
  view.setBigUint64(16, Object.keys(RATES).reduce((bits, r) => bits | (1n << BigInt(r)), 0n), true)
  info.set([0, 1, 2], 24) // direction: output; 1 to 2 channels
  return info
}

/** struct virtio_snd_chmap_info: the stream's channels, stereo (output). */
function chmapInfo(): Uint8Array {
  const info = new Uint8Array(CHMAP_INFO)
  info.set([0, 2, FL, FR], 4)
  return info
}

/** Samples in a stream format (`channels` of them a frame), as stereo floats. */
function stereo(bytes: Uint8Array, channels: number, format: number): Float32Array {
  const width = FORMATS[format]!
  const frames = Math.floor(bytes.length / (width * channels))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sample = (at: number): number => {
    switch (format) {
      case 3: return view.getInt8(at) / 128
      case 4: return (bytes[at]! - 128) / 128
      case 5: return view.getInt16(at, true) / 32768
      case 17: return view.getInt32(at, true) / 2147483648
      default: return Math.max(-1, Math.min(1, view.getFloat32(at, true)))
    }
  }
  const out = new Float32Array(2 * frames)
  for (let i = 0; i < frames; i++) {
    const at = i * width * channels
    out[2 * i] = sample(at)
    out[2 * i + 1] = channels === 2 ? sample(at + width) : out[2 * i]!
  }
  return out
}
