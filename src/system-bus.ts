import { type Bus, BusError } from './bus.js'

interface Region {
  readonly base: number
  readonly size: number
  readonly device: Bus
}

/**
 * Physical address decoder. Devices are mapped at [base, base + size) and see
 * addresses as offsets from their base, like chip-select logic on a real board.
 * Accesses that hit no device (or straddle a region boundary) raise a BusError.
 */
export class SystemBus implements Bus {
  private readonly regions: Region[] = []
  private last: Region = { base: 0, size: 0, device: undefined as never }

  map(base: number, size: number, device: Bus): this {
    base >>>= 0
    for (const r of this.regions) {
      if (base < r.base + r.size && r.base < base + size) {
        throw new Error(`Region 0x${base.toString(16)}+0x${size.toString(16)} overlaps an existing mapping`)
      }
    }
    this.regions.push({ base, size, device })
    return this
  }

  read8(addr: number): number {
    const r = this.decode(addr, 1, 'read')
    return r.device.read8((addr >>> 0) - r.base)
  }

  read16(addr: number): number {
    const r = this.decode(addr, 2, 'read')
    return r.device.read16((addr >>> 0) - r.base)
  }

  read32(addr: number): number {
    const r = this.decode(addr, 4, 'read')
    return r.device.read32((addr >>> 0) - r.base)
  }

  write8(addr: number, value: number): void {
    const r = this.decode(addr, 1, 'write')
    r.device.write8((addr >>> 0) - r.base, value)
  }

  write16(addr: number, value: number): void {
    const r = this.decode(addr, 2, 'write')
    r.device.write16((addr >>> 0) - r.base, value)
  }

  write32(addr: number, value: number): void {
    const r = this.decode(addr, 4, 'write')
    r.device.write32((addr >>> 0) - r.base, value)
  }

  private decode(addr: number, width: number, kind: 'read' | 'write'): Region {
    addr >>>= 0
    // Fast path: consecutive accesses usually hit the same device (RAM).
    let r = this.last
    if (addr >= r.base && addr + width <= r.base + r.size) return r
    for (r of this.regions) {
      if (addr >= r.base && addr + width <= r.base + r.size) return (this.last = r)
    }
    throw new BusError(addr, kind)
  }
}
