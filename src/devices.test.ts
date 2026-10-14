import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BlockStorage, type ChunkStore, MemoryStorage, SnapshotStorage } from './block-storage.js'
import { MIP_MEIP, MIP_SEIP } from './csr.js'
import { FileStorage } from './file-storage.js'
import { GoldfishRtc } from './goldfish-rtc.js'
import { Plic } from './plic.js'
import { VirtioBlock } from './virtio-blk.js'
import { VirtioConsole } from './virtio-console.js'
import { Input, TABLET_MAX, VirtioInput } from './virtio-input.js'
import { VirtioGpu } from './virtio-gpu.js'
import { LINUX_KEYS } from './keymap.js'

describe('PLIC', () => {
  function plic() {
    let mip = 0
    const p = new Plic((bit, on) => (mip = on ? mip | bit : mip & ~bit))
    p.reset()
    const enable = (ctx: number, mask: number) => p.write32(0x2000 + 0x80 * ctx, mask)
    const threshold = (ctx: number, t: number) => p.write32(0x200000 + 0x1000 * ctx, t)
    const claim = (ctx: number) => p.read32(0x200004 + 0x1000 * ctx)
    const complete = (ctx: number, id: number) => p.write32(0x200004 + 0x1000 * ctx, id)
    const priority = (id: number, prio: number) => p.write32(4 * id, prio)
    return { p, mip: () => mip, enable, threshold, claim, complete, priority }
  }

  it('signals M-mode (context 0) and S-mode (context 1) external interrupts', () => {
    const { p, mip, enable, priority } = plic()
    priority(1, 1)
    p.setLevel(1, true)
    expect(mip()).toBe(0) // not enabled anywhere yet
    enable(1, 1 << 1)
    expect(mip()).toBe(MIP_SEIP)
    enable(0, 1 << 1)
    expect(mip()).toBe(MIP_MEIP | MIP_SEIP)
    p.setLevel(1, false)
    expect(mip()).toBe(0)
  })

  it('has an M-mode and an S-mode context per hart; a source claimed by one is not offered to another', () => {
    const mip = [0, 0]
    const p = new Plic((bit, on, hart) => (mip[hart] = on ? mip[hart]! | bit : mip[hart]! & ~bit), 2)
    p.reset()
    p.write32(4 * 1, 1) // priority of source 1
    p.write32(0x2000 + 0x80 * 1, 1 << 1) // enabled for context 1: hart 0, S-mode
    p.write32(0x2000 + 0x80 * 3, 1 << 1) // context 3: hart 1, S-mode
    p.setLevel(1, true)
    expect(mip).toEqual([MIP_SEIP, MIP_SEIP])
    expect(p.read32(0x200004 + 0x1000 * 3)).toBe(1) // hart 1 claims it
    expect(mip).toEqual([0, 0])
    expect(p.read32(0x200004 + 0x1000 * 1)).toBe(0) // nothing left for hart 0
    p.write32(0x200004 + 0x1000 * 3, 1) // complete
    expect(mip).toEqual([MIP_SEIP, MIP_SEIP]) // still high: pending again
  })

  it('priority 0 never interrupts, and only priorities above the threshold do', () => {
    const { p, mip, enable, threshold, priority } = plic()
    enable(0, 1 << 3)
    p.setLevel(3, true)
    expect(mip()).toBe(0)
    priority(3, 2)
    expect(mip()).toBe(MIP_MEIP)
    threshold(0, 2)
    expect(mip()).toBe(0)
    threshold(0, 1)
    expect(mip()).toBe(MIP_MEIP)
  })

  it('claim returns the highest priority (lowest id on ties); a claimed source waits for complete', () => {
    const { p, mip, enable, claim, complete, priority } = plic()
    enable(1, (1 << 2) | (1 << 5) | (1 << 7))
    priority(2, 1)
    priority(5, 3)
    priority(7, 3)
    for (const id of [2, 5, 7]) p.setLevel(id, true)
    expect(claim(1)).toBe(5)
    expect(claim(1)).toBe(7)
    expect(claim(1)).toBe(2)
    expect(claim(1)).toBe(0) // nothing left
    expect(mip()).toBe(0)
    expect(p.read32(0x1000)).toBe(0) // in service: not pending
    p.setLevel(7, false)
    complete(1, 5) // line 5 still high → pending again
    expect(mip()).toBe(MIP_SEIP)
    expect(claim(1)).toBe(5)
  })
})

/** A minimal virtio driver: sets the device up and submits requests through queue 0. */
function virtioHarness(storage: BlockStorage) {
  const ram = new Uint8Array(1 << 20)
  const view = new DataView(ram.buffer)
  let irq = false
  let flushed = 0
  const counting: BlockStorage = {
    size: storage.size,
    readOnly: storage.readOnly,
    read: (offset, dest) => storage.read(offset, dest),
    write: (offset, src) => storage.write(offset, src),
    flush: () => {
      flushed++
    },
  }
  const dev = new VirtioBlock(
    counting,
    (addr, length) => {
      if (addr + length > ram.length) throw new RangeError('outside RAM')
      return ram.subarray(addr, addr + length)
    },
    high => (irq = high),
  )
  const QUEUE = 8
  const DESC = 0x1000
  const AVAIL = 0x2000
  const USED = 0x3000
  dev.write32(0x070, 1 | 2) // ACKNOWLEDGE | DRIVER
  dev.write32(0x024, 1)
  dev.write32(0x020, 1) // VIRTIO_F_VERSION_1
  dev.write32(0x070, 1 | 2 | 8) // FEATURES_OK
  dev.write32(0x030, 0)
  dev.write32(0x038, QUEUE)
  dev.write32(0x080, DESC)
  dev.write32(0x090, AVAIL)
  dev.write32(0x0a0, USED)
  dev.write32(0x044, 1)
  dev.write32(0x070, 1 | 2 | 8 | 4) // DRIVER_OK

  let availIdx = 0
  let next = 0x10000 // bump allocator for request buffers, 16-byte aligned
  const alloc = (n: number) => {
    const at = next
    next = (next + n + 15) & ~15
    return at
  }

  /** Submit a request; buffers are [length, writable] pairs after the 16-byte header. */
  function request(type: number, sector: number, buffers: { data?: Uint8Array; length?: number; writable: boolean }[]) {
    const header = alloc(16)
    view.setUint32(header, type, true)
    view.setUint32(header + 8, sector, true)
    const chain = [{ addr: header, length: 16, writable: false }]
    for (const b of buffers) {
      const length = b.data?.length ?? b.length!
      const addr = alloc(length)
      if (b.data) ram.set(b.data, addr)
      chain.push({ addr, length, writable: b.writable })
    }
    const status = alloc(1)
    ram[status] = 0xff
    chain.push({ addr: status, length: 1, writable: true })
    chain.forEach((d, i) => {
      const at = DESC + 16 * i
      view.setUint32(at, d.addr, true)
      view.setUint32(at + 4, 0, true)
      view.setUint32(at + 8, d.length, true)
      view.setUint16(at + 12, (i < chain.length - 1 ? 1 : 0) | (d.writable ? 2 : 0), true)
      view.setUint16(at + 14, i + 1, true)
    })
    view.setUint16(AVAIL + 4 + 2 * (availIdx % QUEUE), 0, true)
    view.setUint16(AVAIL + 2, ++availIdx, true)
    dev.write32(0x050, 0) // QueueNotify
    const usedIdx = view.getUint16(USED + 2, true)
    const slot = USED + 4 + 8 * ((usedIdx - 1) % QUEUE)
    return {
      status: ram[status],
      usedIdx,
      usedId: view.getUint32(slot, true),
      usedLen: view.getUint32(slot + 4, true),
      buffer: (i: number) => ram.subarray(chain[i + 1]!.addr, chain[i + 1]!.addr + chain[i + 1]!.length),
      /** The status byte as it is now (an asynchronous storage completes later). */
      statusNow: () => ram[status],
    }
  }

  return { dev, request, irq: () => irq, flushed: () => flushed, usedIdx: () => view.getUint16(USED + 2, true) }
}

describe('virtio block device', () => {
  const IN = 0, OUT = 1, FLUSH = 4, GET_ID = 8
  const sector = (fill: number) => new Uint8Array(512).fill(fill)

  it('identifies itself as a virtio-mmio v2 block device with the storage capacity', () => {
    const { dev } = virtioHarness(new MemoryStorage(64 * 1024))
    expect(dev.read32(0x000)).toBe(0x74726976)
    expect(dev.read32(0x004)).toBe(2)
    expect(dev.read32(0x008)).toBe(2)
    expect(dev.read32(0x100)).toBe(128) // sectors
    expect(dev.read32(0x104)).toBe(0)
    dev.write32(0x014, 1)
    expect(dev.read32(0x010) & 1).toBe(1) // VERSION_1
  })

  it('writes sectors to the storage and reads them back', () => {
    const storage = new MemoryStorage(64 * 1024)
    const { request } = virtioHarness(storage)
    const w = request(OUT, 3, [{ data: new Uint8Array([...sector(0xaa), ...sector(0xbb)]), writable: false }])
    expect(w.status).toBe(0)
    expect(w.usedLen).toBe(1) // just the status byte
    expect(storage.bytes[3 * 512]).toBe(0xaa)
    expect(storage.bytes[5 * 512 - 1]).toBe(0xbb)

    const r = request(IN, 3, [{ length: 1024, writable: true }])
    expect(r.status).toBe(0)
    expect(r.usedLen).toBe(1025)
    expect(r.buffer(0)[0]).toBe(0xaa)
    expect(r.buffer(0)[1023]).toBe(0xbb)
  })

  it('scatters a read across several buffers', () => {
    const storage = new MemoryStorage(new Uint8Array(4096).map((_, i) => i >> 9))
    const { request } = virtioHarness(storage)
    const r = request(IN, 1, [
      { length: 512, writable: true },
      { length: 1024, writable: true },
    ])
    expect(r.status).toBe(0)
    expect(r.buffer(0).every(b => b === 1)).toBe(true)
    expect([r.buffer(1)[0], r.buffer(1)[1023]]).toEqual([2, 3])
  })

  it('reports I/O errors beyond the end and on read-only disks, UNSUPP for unknown requests', () => {
    expect(virtioHarness(new MemoryStorage(4096)).request(IN, 8, [{ length: 512, writable: true }]).status).toBe(1)
    const ro = virtioHarness(new MemoryStorage(4096, true))
    ro.dev.write32(0x014, 0)
    expect(ro.dev.read32(0x010) & (1 << 5)).not.toBe(0) // VIRTIO_BLK_F_RO
    expect(ro.request(OUT, 0, [{ data: sector(1), writable: false }]).status).toBe(1)
    expect(virtioHarness(new MemoryStorage(4096)).request(99, 0, []).status).toBe(2)
  })

  it('flushes and reports its id', () => {
    const h = virtioHarness(new MemoryStorage(4096))
    expect(h.request(FLUSH, 0, []).status).toBe(0)
    expect(h.flushed()).toBe(1)
    const id = h.request(GET_ID, 0, [{ length: 20, writable: true }])
    expect(new TextDecoder().decode(id.buffer(0)).replace(/\0+$/, '')).toBe('risc-emulator disk')
  })

  it('raises its interrupt line on completion until the driver acknowledges', () => {
    const h = virtioHarness(new MemoryStorage(4096))
    expect(h.irq()).toBe(false)
    const r = h.request(FLUSH, 0, [])
    expect([r.usedIdx, r.usedId]).toEqual([1, 0])
    expect(h.irq()).toBe(true)
    expect(h.dev.read32(0x060)).toBe(1)
    h.dev.write32(0x064, 1)
    expect(h.irq()).toBe(false)
  })

  it('completes a request when an asynchronous storage has the data', async () => {
    const storage = new MemoryStorage(new Uint8Array(4096).fill(5))
    let release = () => {}
    const slow: BlockStorage = {
      size: storage.size,
      readOnly: false,
      read: (offset, dest) => new Promise<void>(resolve => (release = () => (storage.read(offset, dest), resolve()))),
      write: (offset, src) => storage.write(offset, src),
      flush: () => {},
    }
    const h = virtioHarness(slow)
    const r = h.request(IN, 1, [{ length: 512, writable: true }])
    expect([r.statusNow(), h.usedIdx(), h.irq(), h.dev.busy]).toEqual([0xff, 0, false, true])
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([r.statusNow(), h.usedIdx(), h.irq(), h.dev.busy]).toEqual([0, 1, true, false])
    expect(r.buffer(0).every(b => b === 5)).toBe(true)
  })

  it('drops a request still being read when reset meanwhile', async () => {
    let release = () => {}
    const slow: BlockStorage = {
      size: 4096,
      readOnly: false,
      read: () => new Promise<void>(resolve => (release = resolve)),
      write: () => {},
      flush: () => {},
    }
    const h = virtioHarness(slow)
    const r = h.request(IN, 0, [{ length: 512, writable: true }])
    h.dev.write32(0x070, 0) // reset
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([r.statusNow(), h.irq(), h.dev.busy]).toEqual([0xff, false, false])
  })

  it('a status write of 0 resets the device', () => {
    const h = virtioHarness(new MemoryStorage(4096))
    h.request(FLUSH, 0, [])
    h.dev.write32(0x070, 0)
    expect([h.dev.read32(0x070), h.dev.read32(0x044), h.irq()]).toEqual([0, 0, false])
  })
})

describe('virtio console', () => {
  /** A driver for queues 0 (receive) and 1 (transmit), 4 descriptors each. */
  function consoleHarness() {
    const ram = new Uint8Array(1 << 16)
    const view = new DataView(ram.buffer)
    let irq = false
    const out: number[] = []
    const dev = new VirtioConsole(
      (addr, length) => ram.subarray(addr, addr + length),
      high => (irq = high),
      byte => out.push(byte),
    )
    const queue = (index: number) => ({ desc: 0x1000 + 0x1000 * index * 3, avail: 0x2000 + 0x1000 * index * 3, used: 0x3000 + 0x1000 * index * 3 })
    dev.write32(0x070, 1 | 2)
    dev.write32(0x024, 1)
    dev.write32(0x020, 1) // VIRTIO_F_VERSION_1
    dev.write32(0x024, 0)
    dev.write32(0x020, 1) // VIRTIO_CONSOLE_F_SIZE
    dev.write32(0x070, 1 | 2 | 8)
    for (const index of [0, 1]) {
      const q = queue(index)
      dev.write32(0x030, index)
      dev.write32(0x038, 4)
      dev.write32(0x080, q.desc)
      dev.write32(0x090, q.avail)
      dev.write32(0x0a0, q.used)
      dev.write32(0x044, 1)
    }
    const avail = [0, 0]
    /** Make a buffer available in a queue. */
    const offer = (index: number, addr: number, length: number, writable: boolean) => {
      const q = queue(index)
      view.setUint32(q.desc, addr, true)
      view.setUint32(q.desc + 8, length, true)
      view.setUint16(q.desc + 12, writable ? 2 : 0, true)
      view.setUint16(q.avail + 4 + 2 * (avail[index]! % 4), 0, true)
      view.setUint16(q.avail + 2, ++avail[index]!, true)
      dev.write32(0x050, index) // QueueNotify
    }
    const used = (index: number) => ({ idx: view.getUint16(queue(index).used + 2, true), length: view.getUint32(queue(index).used + 8, true) })
    return { dev, ram, out, offer, used, irq: () => irq, driverOk: () => dev.write32(0x070, 1 | 2 | 8 | 4) }
  }

  it('reports the terminal size, and tells the driver when it is ready and when the size changes', () => {
    const h = consoleHarness()
    expect(h.dev.read32(0x008)).toBe(3) // device ID: console
    h.dev.resize(120, 40)
    expect([h.dev.read16(0x100), h.dev.read16(0x102)]).toEqual([120, 40]) // cols, rows
    expect(h.irq()).toBe(false) // (no driver yet)
    h.driverOk()
    expect(h.dev.read32(0x060)).toBe(2) // configuration change
    const generation = h.dev.read32(0x0fc)
    h.dev.write32(0x064, 2)
    expect(h.irq()).toBe(false)
    h.dev.resize(100, 30)
    expect([h.irq(), h.dev.read32(0x060), h.dev.read32(0x0fc)]).toEqual([true, 2, generation + 1])
    h.dev.write32(0x064, 2)
    h.dev.resize(100, 30) // the same: nothing to tell
    expect(h.irq()).toBe(false)
  })

  it('passes what the guest writes to the output, and typed input into its receive buffers', () => {
    const h = consoleHarness()
    h.driverOk()
    expect(h.dev.inUse).toBe(false)
    h.dev.type('hi')
    h.ram.set(new TextEncoder().encode('ok\r\n'), 0x8000)
    h.offer(1, 0x8000, 4, false) // transmit
    expect(String.fromCharCode(...h.out)).toBe('ok\r\n')
    expect(h.dev.inUse).toBe(true)
    expect(h.used(1).idx).toBe(1)
    h.offer(0, 0x9000, 16, true) // a receive buffer: the input waiting goes there
    expect([h.used(0).idx, h.used(0).length]).toEqual([1, 2])
    expect(new TextDecoder().decode(h.ram.subarray(0x9000, 0x9002))).toBe('hi')
  })
})

describe('virtio input', () => {
  /** A driver for the event queue (0) and the status queue (1), 4 descriptors each. */
  function inputHarness(make: typeof VirtioInput.keyboard) {
    const ram = new Uint8Array(1 << 16)
    const view = new DataView(ram.buffer)
    let irq = false
    const dev = make((addr, length) => ram.subarray(addr, addr + length), high => (irq = high))
    const queue = (index: number) => ({ desc: 0x1000 + 0x3000 * index, avail: 0x2000 + 0x3000 * index, used: 0x3000 + 0x3000 * index })
    const avail = [0, 0]
    /** Set the device up (again), with empty queues. */
    const init = () => {
      ram.fill(0)
      avail.fill(0)
      dev.write32(0x070, 1 | 2)
      dev.write32(0x024, 1)
      dev.write32(0x020, 1) // VIRTIO_F_VERSION_1
      dev.write32(0x070, 1 | 2 | 8)
      for (const index of [0, 1]) {
        const q = queue(index)
        dev.write32(0x030, index)
        dev.write32(0x038, 4)
        dev.write32(0x080, q.desc)
        dev.write32(0x090, q.avail)
        dev.write32(0x0a0, q.used)
        dev.write32(0x044, 1)
      }
      dev.write32(0x070, 1 | 2 | 8 | 4)
    }
    init()
    /** Make buffer `slot` (8 bytes at 0x8000 + 8·slot) available in a queue. */
    const offer = (index: number, slot: number) => {
      const q = queue(index)
      view.setUint32(q.desc + 16 * slot, 0x8000 + 8 * slot, true)
      view.setUint32(q.desc + 16 * slot + 8, 8, true)
      view.setUint16(q.desc + 16 * slot + 12, index === 0 ? 2 : 0, true)
      view.setUint16(q.avail + 4 + 2 * (avail[index]! % 4), slot, true)
      view.setUint16(q.avail + 2, ++avail[index]!, true)
      dev.write32(0x050, index) // QueueNotify
    }
    const used = (index: number) => view.getUint16(queue(index).used + 2, true)
    /** The event in buffer `slot`: type, code, value. */
    const event = (slot: number) => [view.getUint16(0x8000 + 8 * slot, true), view.getUint16(0x8002 + 8 * slot, true), view.getInt32(0x8004 + 8 * slot, true)]
    /** What the config space answers to select, subsel: its bytes. */
    const config = (select: number, subsel = 0) => {
      dev.write8(0x100, select)
      dev.write8(0x101, subsel)
      return Array.from({ length: dev.read8(0x102) }, (_, i) => dev.read8(0x108 + i))
    }
    return { dev, init, offer, used, event, config, irq: () => irq }
  }
  const bits = (bitmap: number[]) => bitmap.flatMap((byte, i) => [...Array(8).keys()].filter(bit => byte & (1 << bit)).map(bit => 8 * i + bit))

  it('answers what Linux asks a keyboard: its name, keys, and that the guest repeats them', () => {
    const h = inputHarness(VirtioInput.keyboard)
    expect(h.dev.read32(0x008)).toBe(18) // device ID: input
    expect(String.fromCharCode(...h.config(0x01))).toBe('risc-emulator keyboard')
    expect(h.config(0x03).slice(0, 2)).toEqual([6, 0]) // BUS_VIRTUAL
    expect(h.config(0x02)).toEqual([]) // no serial
    const keys = bits(h.config(0x11, Input.EV_KEY))
    expect(keys).toContain(1) // KEY_ESC
    expect(keys).toContain(LINUX_KEYS.KeyA)
    expect(Math.max(...keys)).toBeLessThan(Input.BTN_LEFT) // keys, no buttons
    expect(h.config(0x11, Input.EV_REP).length).toBeGreaterThan(0)
    expect(h.config(0x11, Input.EV_ABS)).toEqual([])
  })

  it('answers what Linux asks a tablet: buttons, wheels, and its axes with their range', () => {
    const h = inputHarness(VirtioInput.tablet)
    expect(String.fromCharCode(...h.config(0x01))).toBe('risc-emulator tablet')
    expect(bits(h.config(0x11, Input.EV_KEY))).toEqual([Input.BTN_LEFT, Input.BTN_RIGHT, Input.BTN_MIDDLE])
    expect(bits(h.config(0x11, Input.EV_REL))).toEqual([Input.REL_HWHEEL, Input.REL_WHEEL])
    expect(bits(h.config(0x11, Input.EV_ABS))).toEqual([Input.ABS_X, Input.ABS_Y])
    expect(h.config(0x11, Input.EV_REP)).toEqual([])
    const abs = new DataView(Uint8Array.from(h.config(0x12, Input.ABS_Y)).buffer)
    expect([abs.getUint32(0, true), abs.getUint32(4, true)]).toEqual([0, TABLET_MAX]) // min, max
    expect(h.config(0x12, 2)).toEqual([]) // no such axis
  })

  it('puts events into the guest\'s buffers, a SYN_REPORT after each lot, keeping them until there are buffers', () => {
    const h = inputHarness(VirtioInput.tablet)
    h.offer(0, 0)
    h.dev.send([Input.EV_ABS, Input.ABS_X, 1234], [Input.EV_KEY, Input.BTN_LEFT, 1])
    expect([h.used(0), h.irq()]).toEqual([1, true])
    expect(h.event(0)).toEqual([Input.EV_ABS, Input.ABS_X, 1234])
    h.dev.write32(0x064, 1)
    for (const slot of [1, 2, 3]) h.offer(0, slot)
    expect(h.used(0)).toBe(3)
    expect([h.event(1), h.event(2)]).toEqual([[Input.EV_KEY, Input.BTN_LEFT, 1], [Input.EV_SYN, Input.SYN_REPORT, 0]])
    h.dev.send([Input.EV_REL, Input.REL_WHEEL, -1])
    expect(h.used(0)).toBe(4)
    expect(h.event(3)).toEqual([Input.EV_REL, Input.REL_WHEEL, -1])
  })

  it('takes the guest\'s status messages (keyboard LEDs), and forgets events on a reset', () => {
    const h = inputHarness(VirtioInput.keyboard)
    h.offer(1, 0)
    expect(h.used(1)).toBe(1)
    h.dev.send([Input.EV_KEY, LINUX_KEYS.Enter!, 1]) // (no buffers for it)
    h.dev.write32(0x070, 0) // reset
    h.init()
    h.offer(0, 0)
    expect(h.used(0)).toBe(0)
    h.dev.send([Input.EV_KEY, LINUX_KEYS.Enter!, 0])
    expect(h.event(0)).toEqual([Input.EV_KEY, LINUX_KEYS.Enter, 0])
  })

  it('maps the browser\'s keys to Linux\'s by their place on the keyboard', () => {
    expect([LINUX_KEYS.Escape, LINUX_KEYS.KeyQ, LINUX_KEYS.KeyA, LINUX_KEYS.Enter, LINUX_KEYS.Space]).toEqual([1, 16, 30, 28, 57])
    expect([LINUX_KEYS.ArrowUp, LINUX_KEYS.ArrowDown, LINUX_KEYS.ControlRight, LINUX_KEYS.MetaLeft, LINUX_KEYS.F12]).toEqual([103, 108, 97, 125, 88])
    expect(new Set(Object.values(LINUX_KEYS)).size).toBe(Object.keys(LINUX_KEYS).length) // no two the same
  })
})

describe('virtio GPU', () => {
  /** A driver for its control queue (0, 4 descriptors): a command (request, response) at a time. */
  function gpuHarness(width = 1024, height = 768) {
    const ram = new Uint8Array(1 << 20)
    const view = new DataView(ram.buffer)
    let irq = false
    const memory = (addr: number, length: number) => ram.subarray(addr, addr + length)
    const gpu = new VirtioGpu(memory, memory, high => (irq = high), width, height)
    const q = { desc: 0x1000, avail: 0x2000, used: 0x3000 }
    gpu.write32(0x070, 1 | 2)
    gpu.write32(0x024, 1)
    gpu.write32(0x020, 1) // VIRTIO_F_VERSION_1
    gpu.write32(0x070, 1 | 2 | 8)
    gpu.write32(0x030, 0)
    gpu.write32(0x038, 4)
    gpu.write32(0x080, q.desc)
    gpu.write32(0x090, q.avail)
    gpu.write32(0x0a0, q.used)
    gpu.write32(0x044, 1)
    gpu.write32(0x070, 1 | 2 | 8 | 4)
    let avail = 0
    /** Send a command (32-bit fields after the header's type, flags...); returns the response. */
    const command = (type: number, fields: number[], { fence = 0, extra = new Uint8Array(0) } = {}) => {
      const request = new Uint8Array(24 + 4 * fields.length + extra.length)
      const r = new DataView(request.buffer)
      r.setUint32(0, type, true)
      if (fence) {
        r.setUint32(4, 1, true) // VIRTIO_GPU_FLAG_FENCE
        r.setBigUint64(8, BigInt(fence), true)
      }
      fields.forEach((v, i) => r.setUint32(24 + 4 * i, v, true))
      request.set(extra, 24 + 4 * fields.length)
      ram.set(request, 0x8000)
      ram.fill(0xaa, 0x9000, 0x9000 + 512)
      const descriptor = (i: number, addr: number, length: number, flags: number, next: number) => {
        view.setUint32(q.desc + 16 * i, addr, true)
        view.setUint32(q.desc + 16 * i + 8, length, true)
        view.setUint16(q.desc + 16 * i + 12, flags, true)
        view.setUint16(q.desc + 16 * i + 14, next, true)
      }
      descriptor(0, 0x8000, request.length, 1, 1) // NEXT
      descriptor(1, 0x9000, 512, 2, 0) // WRITE
      view.setUint16(q.avail + 4 + 2 * (avail % 4), 0, true)
      view.setUint16(q.avail + 2, ++avail, true)
      gpu.write32(0x050, 0)
      return new DataView(ram.buffer, 0x9000, 512)
    }
    return { gpu, ram, view, command, irq: () => irq }
  }
  const OK = 0x1100

  it('tells the driver its one display: the preferred size', () => {
    const h = gpuHarness(1024, 768)
    expect(h.gpu.read32(0x008)).toBe(16) // device ID: GPU
    expect([h.gpu.read32(0x100), h.gpu.read32(0x108)]).toEqual([0, 1]) // events_read, num_scanouts
    const info = h.command(0x0100, []) // GET_DISPLAY_INFO
    expect(info.getUint32(0, true)).toBe(0x1101)
    // pmodes[0]: x, y, width, height, enabled
    expect([0, 4, 8, 12, 16].map(at => info.getUint32(24 + at, true))).toEqual([0, 0, 1024, 768, 1])
    expect(info.getUint32(24 + 24 + 16, true)).toBe(0) // (pmodes[1]: not enabled)
  })

  it('shows what the guest draws: an image created, backed by guest memory, copied in, shown', () => {
    const h = gpuHarness()
    expect(h.gpu.output).toBeUndefined()
    // A 4 × 2 image (B8G8R8X8), its backing in two pieces (16 + 16 bytes).
    expect(h.command(0x0101, [7, 2, 4, 2]).getUint32(0, true)).toBe(OK) // RESOURCE_CREATE_2D
    const entries = new Uint8Array(32)
    const e = new DataView(entries.buffer)
    e.setBigUint64(0, 0x20000n, true)
    e.setUint32(8, 16, true)
    e.setBigUint64(16, 0x30000n, true)
    e.setUint32(24, 16, true)
    expect(h.command(0x0106, [7, 2], { extra: entries }).getUint32(0, true)).toBe(OK) // RESOURCE_ATTACH_BACKING
    for (let i = 0; i < 4; i++) h.view.setUint32(0x20000 + 4 * i, 0x100 + i, true) // row 0
    for (let i = 0; i < 4; i++) h.view.setUint32(0x30000 + 4 * i, 0x200 + i, true) // row 1
    // TRANSFER_TO_HOST_2D: all of it (x, y, width, height, offset (64 bits), resource).
    expect(h.command(0x0105, [0, 0, 4, 2, 0, 0, 7, 0]).getUint32(0, true)).toBe(OK)
    expect(h.command(0x0103, [0, 0, 4, 2, 0, 7]).getUint32(0, true)).toBe(OK) // SET_SCANOUT 0
    const output = h.gpu.output!
    expect([output.width, output.height]).toEqual([4, 2])
    expect([...output.pixels]).toEqual([0x100, 0x101, 0x102, 0x103, 0x200, 0x201, 0x202, 0x203])
    // A rectangle: (1, 1) 2 × 1, from where it is in the backing (row 1, pixel 1: byte 20).
    h.view.setUint32(0x30004, 0xabc, true)
    h.view.setUint32(0x30008, 0xdef, true)
    expect(h.command(0x0105, [1, 1, 2, 1, 20, 0, 7, 0]).getUint32(0, true)).toBe(OK)
    expect([...output.pixels]).toEqual([0x100, 0x101, 0x102, 0x103, 0x200, 0xabc, 0xdef, 0x203])
    expect(h.command(0x0104, [0, 0, 4, 2, 7, 0]).getUint32(0, true)).toBe(OK) // RESOURCE_FLUSH
  })

  it('answers what it can not do, and fenced commands with their fence', () => {
    const h = gpuHarness()
    expect(h.command(0x0105, [0, 0, 1, 1, 0, 0, 9, 0]).getUint32(0, true)).toBe(0x1203) // no resource 9
    expect(h.command(0x0101, [1, 67, 4, 4]).getUint32(0, true)).toBe(0x1205) // a format it doesn't do
    expect(h.command(0x0103, [0, 0, 4, 4, 1, 0]).getUint32(0, true)).toBe(0x1202) // scanout 1
    expect(h.command(0x0999, []).getUint32(0, true)).toBe(0x1200) // unknown
    const fenced = h.command(0x0101, [3, 2, 8, 8], { fence: 42 })
    expect([fenced.getUint32(0, true), fenced.getUint32(4, true), Number(fenced.getBigUint64(8, true))]).toEqual([OK, 1, 42])
  })

  it('tells the driver when the display gets another size (the width a multiple of 8)', () => {
    const h = gpuHarness(1024, 768)
    h.gpu.resize(1283, 720)
    expect([h.irq(), h.gpu.read32(0x060), h.gpu.read32(0x100)]).toEqual([true, 2, 1]) // config change; EVENT_DISPLAY
    const info = h.command(0x0100, [])
    expect([info.getUint32(24 + 8, true), info.getUint32(24 + 12, true)]).toEqual([1280, 720])
    h.gpu.write32(0x104, 1) // events_clear
    h.gpu.write32(0x064, 3)
    expect([h.gpu.read32(0x100), h.irq()]).toEqual([0, false])
    h.gpu.resize(1285, 720) // (the same, rounded)
    expect(h.irq()).toBe(false)
  })
})

describe('Goldfish RTC', () => {
  it('reports the host time in nanoseconds, high half latched by reading the low half', () => {
    let now = Date.UTC(2026, 9, 11, 12, 0, 0, 123)
    const rtc = new GoldfishRtc(() => now)
    const read = () => (BigInt(rtc.read32(0x00)) | (BigInt(rtc.read32(0x04)) << 32n))
    expect(read()).toBe(BigInt(now) * 1_000_000n)
    const low = rtc.read32(0x00)
    now += 10_000 // the high half stays latched until TIME_LOW is read again
    expect((BigInt(rtc.read32(0x04)) << 32n) | BigInt(low)).toBe(BigInt(now - 10_000) * 1_000_000n)
  })

  it('can be set (HIGH, then LOW), and keeps running from there', () => {
    let now = 1_000_000
    const rtc = new GoldfishRtc(() => now)
    const set = 1_700_000_000_000_000_000n // 2023-11-14
    rtc.write32(0x04, Number(set >> 32n))
    rtc.write32(0x00, Number(set & 0xffff_ffffn))
    now += 5 // ms
    const t = BigInt(rtc.read32(0x00)) | (BigInt(rtc.read32(0x04)) << 32n)
    expect(t).toBe(set + 5_000_000n)
  })
})

describe('storage', () => {
  /** A storage over `bytes` that answers each read on the next turn of the event loop. */
  function asynchronous(bytes: Uint8Array): BlockStorage & { reads: number } {
    const memory = new MemoryStorage(bytes)
    return {
      size: memory.size,
      readOnly: true,
      reads: 0,
      read(offset, dest) {
        this.reads++
        return new Promise(resolve => setTimeout(() => resolve(memory.read(offset, dest)), 0))
      },
      write: () => {
        throw new Error('read-only')
      },
      flush: () => {},
    }
  }

  it('a snapshot overlay over an asynchronous base: writes to a chunk being copied wait, in order', async () => {
    const base = asynchronous(new Uint8Array(10000).fill(7))
    const snap = new SnapshotStorage(base)
    const writes = [
      snap.write(4090, new Uint8Array(12).fill(9)), // straddles two 4 KiB chunks: both copied first
      snap.write(4094, new Uint8Array(2).fill(8)), // waits for the same copy, then goes on top
    ]
    expect(writes.every(w => w instanceof Promise)).toBe(true)
    const back = new Uint8Array(20)
    await Promise.all([...writes, snap.read(4085, back)])
    expect([...back]).toEqual([7, 7, 7, 7, 7, 9, 9, 9, 9, 8, 8, 9, 9, 9, 9, 9, 9, 7, 7, 7])
    expect(base.reads).toBe(2) // each chunk copied once
    expect(snap.read(4085, back)).toBeUndefined() // now all in the overlay: right away
  })

  /** A ChunkStore in memory, as IndexedDB keeps one; `batches`: the chunks of each save. */
  function memoryStore(failing = false) {
    const chunks = new Map<number, Uint8Array>()
    const batches: number[][] = []
    const store: ChunkStore = {
      get saved() {
        return new Set(chunks.keys())
      },
      load: async index => chunks.get(index)!.slice(),
      save: async batch => {
        if (failing) throw new Error('quota exceeded')
        batches.push([...batch.keys()])
        for (const [index, chunk] of batch) chunks.set(index, chunk.slice())
      },
    }
    return { store, batches }
  }

  it('a snapshot overlay with a store: changes saved on flush, all at once; a new overlay has them again', async () => {
    const base = new MemoryStorage(new Uint8Array(10000).fill(7))
    const { store, batches } = memoryStore()
    const snap = new SnapshotStorage(base, store)
    snap.write(4090, new Uint8Array(12).fill(9)) // chunks 0 and 1
    expect(batches).toEqual([])
    await snap.flush()
    expect(batches).toEqual([[0, 1]])
    await snap.flush() // nothing changed since
    snap.write(100, Uint8Array.of(5))
    await snap.flush()
    expect(batches).toEqual([[0, 1], [0]])

    // Next time (a page reloaded): the store's chunks instead of the base's.
    const again = new SnapshotStorage(base, store)
    const back = new Uint8Array(20)
    await again.read(4085, back)
    expect([...back]).toEqual([7, 7, 7, 7, 7, ...Array(12).fill(9), 7, 7, 7])
    const byte = new Uint8Array(1)
    await again.read(100, byte)
    expect(byte[0]).toBe(5)
    expect(base.bytes.every(b => b === 7)).toBe(true)
    await again.write(8192, Uint8Array.of(1)) // chunk 2: from the base, as before
    await again.flush()
    expect(batches.at(-1)).toEqual([2])
  })

  it('a snapshot overlay whose store fails to save says so, and goes on', async () => {
    const { store } = memoryStore(true)
    const snap = new SnapshotStorage(new MemoryStorage(8192), store)
    const errors: unknown[] = []
    snap.onsaveerror = error => errors.push(error)
    snap.write(0, Uint8Array.of(1))
    await snap.flush()
    expect(String(errors[0])).toMatch(/quota/)
    const byte = new Uint8Array(1)
    snap.read(0, byte)
    expect(byte[0]).toBe(1)
  })

  it('a snapshot overlay reads through to its base but never writes to it', () => {
    const base = new MemoryStorage(new Uint8Array(10000).fill(7))
    const snap = new SnapshotStorage(base)
    snap.write(4090, new Uint8Array(12).fill(9)) // straddles two 4 KiB chunks
    const back = new Uint8Array(20)
    snap.read(4085, back)
    expect([...back]).toEqual([7, 7, 7, 7, 7, ...Array(12).fill(9), 7, 7, 7])
    expect(base.bytes.every(b => b === 7)).toBe(true)
    expect(snap.dirtyBytes).toBe(8192)
  })

  describe('file-backed', () => {
    let dir: string
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('reads and writes the image file in place', () => {
      dir = mkdtempSync(join(tmpdir(), 'risc-disk-'))
      const path = join(dir, 'disk.img')
      writeFileSync(path, new Uint8Array(8192))
      const disk = new FileStorage(path)
      expect(disk.size).toBe(8192)
      disk.write(1000, new Uint8Array([1, 2, 3]))
      disk.flush()
      disk.close()
      expect([...readFileSync(path).subarray(1000, 1003)]).toEqual([1, 2, 3])

      const ro = new FileStorage(path, { readOnly: true })
      const out = new Uint8Array(4)
      ro.read(999, out)
      expect([...out]).toEqual([0, 1, 2, 3])
      expect(() => ro.write(0, out)).toThrow(/read-only/)
      ro.close()
    })
  })
})
