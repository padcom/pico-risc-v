import { type Bus, BusError } from './bus.js'

/**
 * Little-endian RAM. Addresses are offsets from the start of the RAM; place it
 * in the physical address space by mapping it on a SystemBus.
 */
export class RAM implements Bus {
  readonly bytes: Uint8Array
  readonly size: number
  private readonly view: DataView

  /** `size` bytes of new RAM, or RAM over existing memory (e.g. the CPU's, see CPUOptions.ram). */
  constructor(sizeOrBytes: number | Uint8Array) {
    this.bytes = typeof sizeOrBytes === 'number' ? new Uint8Array(sizeOrBytes) : sizeOrBytes
    this.size = this.bytes.length
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
  }

  /** Copy raw bytes (e.g. a program image) into RAM at the given offset. */
  load(addr: number, data: ArrayLike<number>): void {
    this.bytes.set(data, this.offset(addr, data.length, 'write'))
  }

  read8(addr: number): number {
    return this.view.getUint8(this.offset(addr, 1, 'read'))
  }

  read16(addr: number): number {
    return this.view.getUint16(this.offset(addr, 2, 'read'), true)
  }

  read32(addr: number): number {
    return this.view.getUint32(this.offset(addr, 4, 'read'), true)
  }

  write8(addr: number, value: number): void {
    this.view.setUint8(this.offset(addr, 1, 'write'), value & 0xff)
  }

  write16(addr: number, value: number): void {
    this.view.setUint16(this.offset(addr, 2, 'write'), value & 0xffff, true)
  }

  write32(addr: number, value: number): void {
    this.view.setUint32(this.offset(addr, 4, 'write'), value >>> 0, true)
  }

  private offset(addr: number, width: number, kind: 'read' | 'write'): number {
    const off = addr >>> 0
    if (off + width > this.size) throw new BusError(addr, kind)
    return off
  }
}
