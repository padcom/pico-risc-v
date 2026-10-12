/**
 * Backing store of a virtual disk: a flat array of bytes, read and written at
 * byte offsets (the block device deals in 512-byte sectors on top of this).
 */
export interface BlockStorage {
  /** Size in bytes. */
  readonly size: number
  readonly readOnly: boolean
  /**
   * Fill `dest` with the bytes at `offset`: right away, or (a storage that
   * has to fetch them, such as HttpStorage) by when the promise resolves.
   */
  read(offset: number, dest: Uint8Array): void | Promise<void>
  /** Store `src` at `offset` (done by when the promise resolves, if any). */
  write(offset: number, src: Uint8Array): void | Promise<void>
  /** Make written data durable (fsync for files). */
  flush(): void
}

/** Wait for all of `pending`, if any (undefined if there are none). */
function all(pending: Promise<void>[]): Promise<void> | undefined {
  return pending.length ? Promise.all(pending).then(() => {}) : undefined
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
 * The base is never modified. A write to a chunk first copies it from the
 * base; with a base that reads asynchronously, the overlay is asynchronous
 * too, and accesses to a chunk being copied wait for it, in order.
 */
export class SnapshotStorage implements BlockStorage {
  readonly readOnly = false
  private readonly chunks = new Map<number, Uint8Array>()
  /** Chunks being copied from an asynchronous base. */
  private readonly copying = new Map<number, Promise<Uint8Array>>()

  constructor(private readonly base: BlockStorage) {}

  get size(): number {
    return this.base.size
  }

  read(offset: number, dest: Uint8Array): void | Promise<void> {
    const pending: Promise<void>[] = []
    this.forEachChunk(offset, dest.length, (index, inChunk, at, length) => {
      const part = dest.subarray(at, at + length)
      const chunk = this.chunks.get(index)
      const copying = this.copying.get(index)
      if (chunk) part.set(chunk.subarray(inChunk, inChunk + length))
      else if (copying) pending.push(copying.then(chunk => part.set(chunk.subarray(inChunk, inChunk + length))))
      else {
        const read = this.base.read(offset + at, part)
        if (read) pending.push(read)
      }
    })
    return all(pending)
  }

  write(offset: number, src: Uint8Array): void | Promise<void> {
    const pending: Promise<void>[] = []
    this.forEachChunk(offset, src.length, (index, inChunk, at, length) => {
      const part = src.subarray(at, at + length)
      const chunk = this.chunks.get(index) ?? this.copying.get(index) ?? this.copy(index)
      if (chunk instanceof Uint8Array) chunk.set(part, inChunk)
      else pending.push(chunk.then(chunk => chunk.set(part, inChunk)))
    })
    return all(pending)
  }

  /** Start a chunk off as a copy of the base. */
  private copy(index: number): Uint8Array | Promise<Uint8Array> {
    const chunk = new Uint8Array(Math.min(CHUNK, this.size - index * CHUNK))
    const read = this.base.read(index * CHUNK, chunk)
    if (!read) {
      this.chunks.set(index, chunk)
      return chunk
    }
    const copied = read.then(() => {
      this.chunks.set(index, chunk)
      this.copying.delete(index)
      return chunk
    })
    this.copying.set(index, copied)
    return copied
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
