/**
 * Backing store of a virtual disk: a flat array of bytes, read and written at
 * byte offsets (the block device deals in 512-byte sectors on top of this).
 */
export interface BlockStorage {
  /** Size in bytes. */
  readonly size: number
  readonly readOnly: boolean
  /** Fill `dest` with the bytes at `offset`. */
  read(offset: number, dest: Uint8Array): void
  /** Store `src` at `offset`. */
  write(offset: number, src: Uint8Array): void
  /** Make written data durable (fsync for files). */
  flush(): void
}

/** A disk held entirely in memory (tests, or a scratch disk). */
export class MemoryStorage implements BlockStorage {
  readonly bytes: Uint8Array

  constructor(
    sizeOrBytes: number | Uint8Array,
    readonly readOnly = false,
  ) {
    this.bytes = typeof sizeOrBytes === 'number' ? new Uint8Array(sizeOrBytes) : sizeOrBytes
  }

  get size(): number {
    return this.bytes.length
  }

  read(offset: number, dest: Uint8Array): void {
    dest.set(this.bytes.subarray(offset, offset + dest.length))
  }

  write(offset: number, src: Uint8Array): void {
    this.bytes.set(src, offset)
  }

  flush(): void {}
}

const CHUNK = 4096

/**
 * Copy-on-write overlay (QEMU's -snapshot): reads come from the base storage
 * unless written before, writes go to memory and are lost when the overlay is.
 * The base is never modified.
 */
export class SnapshotStorage implements BlockStorage {
  readonly readOnly = false
  private readonly chunks = new Map<number, Uint8Array>()

  constructor(private readonly base: BlockStorage) {}

  get size(): number {
    return this.base.size
  }

  read(offset: number, dest: Uint8Array): void {
    this.forEachChunk(offset, dest.length, (index, inChunk, at, length) => {
      const chunk = this.chunks.get(index)
      const part = dest.subarray(at, at + length)
      if (chunk) part.set(chunk.subarray(inChunk, inChunk + length))
      else this.base.read(offset + at, part)
    })
  }

  write(offset: number, src: Uint8Array): void {
    this.forEachChunk(offset, src.length, (index, inChunk, at, length) => {
      let chunk = this.chunks.get(index)
      if (!chunk) {
        chunk = new Uint8Array(Math.min(CHUNK, this.size - index * CHUNK))
        this.base.read(index * CHUNK, chunk)
        this.chunks.set(index, chunk)
      }
      chunk.set(src.subarray(at, at + length), inChunk)
    })
  }

  flush(): void {}

  /** Bytes changed so far (in whole chunks). */
  get dirtyBytes(): number {
    let total = 0
    for (const chunk of this.chunks.values()) total += chunk.length
    return total
  }

  private forEachChunk(
    offset: number,
    length: number,
    fn: (index: number, inChunk: number, at: number, length: number) => void,
  ): void {
    for (let at = 0; at < length; ) {
      const pos = offset + at
      const inChunk = pos % CHUNK
      const n = Math.min(CHUNK - inChunk, length - at)
      fn(Math.floor(pos / CHUNK), inChunk, at, n)
      at += n
    }
  }
}
