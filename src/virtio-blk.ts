import type { BlockStorage } from './block-storage.js'
import { type GuestMemory, length, type Chain, VirtioMmioDevice } from './virtio.js'

export type { GuestMemory } from './virtio.js'

const SECTOR = 512

// Feature bits
const VIRTIO_BLK_F_RO = 1 << 5
const VIRTIO_BLK_F_BLK_SIZE = 1 << 6
const VIRTIO_BLK_F_FLUSH = 1 << 9

// Request types and status codes
const VIRTIO_BLK_T_IN = 0
const VIRTIO_BLK_T_OUT = 1
const VIRTIO_BLK_T_FLUSH = 4
const VIRTIO_BLK_T_GET_ID = 8
const VIRTIO_BLK_S_OK = 0
const VIRTIO_BLK_S_IOERR = 1
const VIRTIO_BLK_S_UNSUPP = 2

const DEVICE_ID = 'risc-emulator disk'

/**
 * virtio block device with a single request queue. Requests are carried out
 * when the driver notifies the queue: right away, or, with a storage that
 * reads asynchronously, when it has the data (requests may complete in any
 * order).
 */
export class VirtioBlock extends VirtioMmioDevice {
  protected readonly deviceId = 2
  /** Requests still being carried out, by an asynchronous storage. */
  private pending = 0
  /** Bumped by reset: requests from before it don't complete after it. */
  private generation = 0

  constructor(
    private readonly storage: BlockStorage,
    memory: GuestMemory,
    irq: (high: boolean) => void,
  ) {
    super(memory, irq, [256])
  }

  /** True while the storage is still busy with requests. */
  get busy(): boolean {
    return this.pending > 0
  }

  override reset(): void {
    super.reset()
    this.generation++
    this.pending = 0
  }

  get capacitySectors(): number {
    return Math.floor(this.storage.size / SECTOR)
  }

  protected deviceFeatures(word: number): number {
    if (word !== 0) return 0
    return VIRTIO_BLK_F_BLK_SIZE | VIRTIO_BLK_F_FLUSH | (this.storage.readOnly ? VIRTIO_BLK_F_RO : 0)
  }

  /** struct virtio_blk_config: capacity (u64, in sectors) … blk_size (u32 at 0x14). */
  protected readConfig(offset: number): number {
    switch (offset) {
      case 0x00: return this.capacitySectors % 0x1_0000_0000
      case 0x04: return Math.floor(this.capacitySectors / 0x1_0000_0000)
      case 0x14: return SECTOR
      default: return 0
    }
  }

  protected queueNotified(): void {
    const q = this.queues[0]!
    let handled = false
    for (let chain = q.pop(); chain; chain = q.pop()) {
      const written = this.handleRequest(chain)
      if (typeof written === 'number') {
        q.push(chain.head, written)
        handled = true
        continue
      }
      const generation = this.generation
      this.pending++
      void written.then(written => {
        if (generation !== this.generation) return
        this.pending--
        this.guarded(() => {
          q.push(chain.head, written)
          this.signalUsed()
        })
      })
    }
    if (handled) this.signalUsed()
  }

  /**
   * Header (device-readable): type u32, reserved u32, sector u64. Status: the
   * last device-writable byte. Data: everything in between. Returns the bytes
   * written to guest memory (once the storage is done, if it's asynchronous).
   */
  private handleRequest({ readable, writable }: Chain): number | Promise<number> {
    const q = this.queues[0]!
    const out = q.read(readable)
    const inLength = length(writable)
    if (out.length < 16 || inLength < 1) throw new RangeError('request too short')
    const header = new DataView(out.buffer, out.byteOffset, 16)
    const type = header.getUint32(0, true)
    const offset = (header.getUint32(8, true) + header.getUint32(12, true) * 0x1_0000_0000) * SECTOR
    const data = new Uint8Array(inLength - 1)

    let status = VIRTIO_BLK_S_OK
    let dataWritten = 0
    let storage: void | Promise<void> = undefined
    switch (type) {
      case VIRTIO_BLK_T_IN:
        if (offset + data.length > this.storage.size) status = VIRTIO_BLK_S_IOERR
        else {
          storage = this.storage.read(offset, data)
          dataWritten = data.length
        }
        break
      case VIRTIO_BLK_T_OUT: {
        const payload = out.subarray(16)
        if (this.storage.readOnly || offset + payload.length > this.storage.size) status = VIRTIO_BLK_S_IOERR
        else storage = this.storage.write(offset, payload)
        break
      }
      case VIRTIO_BLK_T_FLUSH:
        this.storage.flush()
        break
      case VIRTIO_BLK_T_GET_ID: {
        const id = new TextEncoder().encode(DEVICE_ID).subarray(0, 20) // up to 20 bytes, NUL padded
        data.set(id.subarray(0, data.length))
        dataWritten = Math.min(20, data.length)
        break
      }
      default:
        status = VIRTIO_BLK_S_UNSUPP
    }

    const complete = () => {
      q.write(writable, data.subarray(0, dataWritten))
      q.write(writable, Uint8Array.of(status), inLength - 1) // status: always the very last byte
      return dataWritten + 1
    }
    if (!storage) return complete()
    // (After a reset, the guest's buffers may be in other use: hands off.)
    const generation = this.generation
    return storage.then(
      () => (generation === this.generation ? complete() : 0),
      () => {
        status = VIRTIO_BLK_S_IOERR
        dataWritten = 0
        return generation === this.generation ? complete() : 0
      },
    )
  }
}
