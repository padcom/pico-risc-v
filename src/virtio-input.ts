import { VirtioMmioDevice, type GuestMemory } from './virtio.js'

/** Queues. */
const EVENTS = 0
const STATUS = 1

/** What the driver selects in the config space to read (VIRTIO_INPUT_CFG_*). */
const enum Select {
  IdName = 0x01,
  IdSerial = 0x02,
  IdDevids = 0x03,
  PropBits = 0x10,
  EvBits = 0x11,
  AbsInfo = 0x12,
}

/** Linux's input event types and codes (include/uapi/linux/input-event-codes.h), the ones used here. */
export const Input = {
  EV_SYN: 0x00,
  EV_KEY: 0x01,
  EV_REL: 0x02,
  EV_ABS: 0x03,
  EV_REP: 0x14,
  SYN_REPORT: 0,
  REL_HWHEEL: 0x06,
  REL_WHEEL: 0x08,
  ABS_X: 0x00,
  ABS_Y: 0x01,
  BTN_LEFT: 0x110,
  BTN_RIGHT: 0x111,
  BTN_MIDDLE: 0x112,
} as const

/** The tablet's coordinates go from 0 to this (as QEMU's). */
export const TABLET_MAX = 0x7fff
/** Events waiting for the guest's buffers, at most (then new ones are dropped). */
const MAX_PENDING = 4096

/** What an input device can do: the event codes of each type, and the range of each absolute axis. */
interface Capabilities {
  name: string
  codes: Map<number, number[]>
  abs?: Map<number, { min: number; max: number }>
}

/**
 * A virtio input device (Linux's virtio_input): events as Linux's input
 * layer has them (evdev: type, code, value), which the guest's programs (X,
 * the console) read as from any keyboard or mouse. Two kinds, as QEMU's:
 *  - keyboard(): keys (EV_KEY, KEY_* codes), repeated by the guest (EV_REP)
 *  - tablet(): an absolute pointer (ABS_X, ABS_Y, 0 to TABLET_MAX over the
 *    screen, so the guest's pointer is where the host's is), with buttons
 *    and a wheel
 * send() passes events on; the guest's status messages (keyboard LEDs) are
 * taken and ignored.
 */
export class VirtioInput extends VirtioMmioDevice {
  protected readonly deviceId = 18
  private select = 0
  private subsel = 0
  /** Events (8 bytes each) waiting for the guest's buffers. */
  private pending: Uint8Array[] = []
  /** What the config space shows for the current select/subsel. */
  private selected: Uint8Array = new Uint8Array(0)

  private constructor(
    private readonly capabilities: Capabilities,
    memory: GuestMemory,
    irq: (high: boolean) => void,
  ) {
    super(memory, irq, [64, 64])
  }

  static keyboard(memory: GuestMemory, irq: (high: boolean) => void): VirtioInput {
    const keys = Array.from({ length: 255 }, (_, i) => i + 1) // KEY_ESC... (all KEY_*, below the buttons)
    return new VirtioInput({ name: 'risc-emulator keyboard', codes: new Map([[Input.EV_KEY, keys], [Input.EV_REP, []]]) }, memory, irq)
  }

  static tablet(memory: GuestMemory, irq: (high: boolean) => void): VirtioInput {
    return new VirtioInput(
      {
        name: 'risc-emulator tablet',
        codes: new Map([
          [Input.EV_KEY, [Input.BTN_LEFT, Input.BTN_RIGHT, Input.BTN_MIDDLE]],
          [Input.EV_REL, [Input.REL_HWHEEL, Input.REL_WHEEL]],
          [Input.EV_ABS, [Input.ABS_X, Input.ABS_Y]],
        ]),
        abs: new Map([
          [Input.ABS_X, { min: 0, max: TABLET_MAX }],
          [Input.ABS_Y, { min: 0, max: TABLET_MAX }],
        ]),
      },
      memory,
      irq,
    )
  }

  /** Pass events on to the guest ([type, code, value] each), then a SYN_REPORT: they happened together. */
  send(...events: [type: number, code: number, value: number][]): void {
    for (const [type, code, value] of [...events, [Input.EV_SYN, Input.SYN_REPORT, 0] as const]) {
      if (this.pending.length >= MAX_PENDING) break
      const event = new Uint8Array(8)
      const view = new DataView(event.buffer)
      view.setUint16(0, type, true)
      view.setUint16(2, code, true)
      view.setInt32(4, value, true)
      this.pending.push(event)
    }
    if (this.ready) this.guarded(() => this.deliver())
  }

  override reset(): void {
    super.reset()
    this.pending = []
    this.select = this.subsel = 0
    this.selected = new Uint8Array(0)
  }

  protected deviceFeatures(): number {
    return 0
  }

  /**
   * struct virtio_input_config: select u8, subsel u8, size u8, reserved
   * u8[5], then (at 8) the answer, `size` bytes of it.
   */
  protected readConfig(offset: number): number {
    if (offset === 0) return this.select | (this.subsel << 8) | (this.selected.length << 16)
    let word = 0
    for (let i = 3; i >= 0; i--) word = (word << 8) | (this.selected[offset - 8 + i] ?? 0)
    return word >>> 0
  }

  protected override writeConfig(offset: number, value: number): void {
    if (offset !== 0) return
    this.select = value & 0xff
    this.subsel = (value >>> 8) & 0xff
    this.selected = this.answer()
  }

  protected queueNotified(index: number): void {
    if (index === EVENTS) this.deliver() // new buffers
    else if (index === STATUS) {
      const q = this.queues[STATUS]!
      let handled = false
      for (let chain = q.pop(); chain; chain = q.pop()) {
        q.push(chain.head, 0)
        handled = true
      }
      if (handled) this.signalUsed()
    }
  }

  /** What the config space shows for select and subsel (empty: nothing). */
  private answer(): Uint8Array {
    const { name, codes, abs } = this.capabilities
    switch (this.select) {
      case Select.IdName:
        return new TextEncoder().encode(name)
      case Select.IdDevids: {
        // bustype BUS_VIRTUAL, vendor, product, version
        const ids = new Uint8Array(8)
        new DataView(ids.buffer).setUint16(0, 0x06, true)
        return ids
      }
      case Select.EvBits: {
        const list = codes.get(this.subsel)
        if (!list) return new Uint8Array(0)
        // A bitmap of the codes, as long as it takes; a type without codes
        // (EV_REP) answers a byte, to say it's there.
        const bitmap = new Uint8Array(Math.max(1, ...list.map(code => (code >> 3) + 1)))
        for (const code of list) bitmap[code >> 3]! |= 1 << (code & 7)
        return bitmap
      }
      case Select.AbsInfo: {
        const axis = abs?.get(this.subsel)
        if (!axis) return new Uint8Array(0)
        // min, max, fuzz, flat, res
        const info = new Uint8Array(20)
        const view = new DataView(info.buffer)
        view.setUint32(0, axis.min, true)
        view.setUint32(4, axis.max, true)
        return info
      }
      default: // IdSerial, PropBits: none
        return new Uint8Array(0)
    }
  }

  /** Move pending events into buffers the guest made available, one each. */
  private deliver(): void {
    const q = this.queues[EVENTS]!
    let handled = false
    while (this.pending.length) {
      const chain = q.pop()
      if (!chain) break
      q.push(chain.head, q.write(chain.writable, this.pending.shift()!))
      handled = true
    }
    if (handled) this.signalUsed()
  }
}
