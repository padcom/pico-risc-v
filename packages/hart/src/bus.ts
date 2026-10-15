/**
 * Anything the CPU can load from / store to. RAM implements it today;
 * memory-mapped devices (e.g. a text console) will implement it later and be
 * composed behind a single address-decoding bus.
 *
 * All values are unsigned; addresses are 32-bit unsigned.
 */
export interface Bus {
  read8(addr: number): number
  read16(addr: number): number
  read32(addr: number): number
  write8(addr: number, value: number): void
  write16(addr: number, value: number): void
  write32(addr: number, value: number): void
}

export class BusError extends Error {
  constructor(
    readonly addr: number,
    readonly kind: 'read' | 'write',
  ) {
    super(`Bus ${kind} fault at 0x${(addr >>> 0).toString(16).padStart(8, '0')}`)
  }
}

/**
 * Base for devices built from 32-bit registers: subclasses implement word
 * access at 4-byte aligned offsets; narrower accesses are derived from it.
 */
export abstract class WordDevice implements Bus {
  protected abstract readWord(offset: number): number
  protected abstract writeWord(offset: number, value: number): void

  read32(addr: number): number {
    return this.readWord(addr & ~3) >>> 0
  }

  read16(addr: number): number {
    return (this.readWord(addr & ~3) >>> ((addr & 2) * 8)) & 0xffff
  }

  read8(addr: number): number {
    return (this.readWord(addr & ~3) >>> ((addr & 3) * 8)) & 0xff
  }

  write32(addr: number, value: number): void {
    this.writeWord(addr & ~3, value >>> 0)
  }

  write16(addr: number, value: number): void {
    const shift = (addr & 2) * 8
    const word = this.readWord(addr & ~3)
    this.writeWord(addr & ~3, ((word & ~(0xffff << shift)) | ((value & 0xffff) << shift)) >>> 0)
  }

  write8(addr: number, value: number): void {
    const shift = (addr & 3) * 8
    const word = this.readWord(addr & ~3)
    this.writeWord(addr & ~3, ((word & ~(0xff << shift)) | ((value & 0xff) << shift)) >>> 0)
  }
}
