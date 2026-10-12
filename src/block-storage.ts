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
  /** Make written data durable (fsync for files), by when the promise resolves, if any. */
  flush(): void | Promise<void>
  /**
   * What the storage holds, if it can say: changes when its contents may
   * have (a disk image rebuilt), so changes saved over it don't apply anymore.
   */
  readonly id?: string
}

/**
 * Where a SnapshotStorage keeps its chunks, to have them again next time (in
 * a browser: IndexedDB, see indexeddb-store.ts).
 */
export interface ChunkStore {
  /** The chunks it has, by index. */
  readonly saved: ReadonlySet<number>
  load(index: number): Promise<Uint8Array>
  /** Keep these chunks (replacing what it has of them): all of them, or none. */
  save(chunks: ReadonlyMap<number, Uint8Array>): Promise<void>
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
 *
 * With a ChunkStore, the overlay's chunks are kept: it starts with what the
 * store has (reading those chunks from it rather than from the base), and
 * flush() saves the chunks changed since, all at once. The guest flushes
 * (ext4 does at least every few seconds), so what's saved is a state the
 * disk was in, which its file system recovers from, as from a power cut.
 */
export class SnapshotStorage implements BlockStorage {
  readonly readOnly = false
  private readonly chunks = new Map<number, Uint8Array>()
  /** Chunks being copied from an asynchronous base (or loaded from the store). */
  private readonly copying = new Map<number, Promise<Uint8Array>>()
  /** Chunks changed since the store last saved them. */
  private readonly changed = new Set<number>()
  /** Saves, one after the other. */
  private saving: Promise<void> = Promise.resolve()
  /** A save failed (the guest goes on: it's the keeping that failed, not the disk). */
  onsaveerror: (error: unknown) => void = () => {}

  constructor(
    private readonly base: BlockStorage,
    private readonly store?: ChunkStore,
  ) {}

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
      else if (this.store?.saved.has(index)) {
        pending.push(Promise.resolve(this.copy(index)).then(chunk => part.set(chunk.subarray(inChunk, inChunk + length))))
      } else {
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
      const write = (chunk: Uint8Array) => {
        chunk.set(part, inChunk)
        this.changed.add(index)
      }
      if (chunk instanceof Uint8Array) write(chunk)
      else pending.push(chunk.then(write))
    })
    return all(pending)
  }

  /** Start a chunk off as a copy of the base (or of what the store has of it). */
  private copy(index: number): Uint8Array | Promise<Uint8Array> {
    const chunk = new Uint8Array(Math.min(CHUNK, this.size - index * CHUNK))
    const read = this.store?.saved.has(index)
      ? this.store.load(index).then(saved => chunk.set(saved))
      : this.base.read(index * CHUNK, chunk)
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

  /** With a store: save the chunks changed since the last time (done when the promise resolves). */
  flush(): void | Promise<void> {
    const store = this.store
    if (!store) return
    this.saving = this.saving.then(async () => {
      // (Writes still waiting for their chunk first, then a copy of each.)
      await Promise.all(this.copying.values())
      if (!this.changed.size) return
      const batch = new Map([...this.changed].map(index => [index, this.chunks.get(index)!.slice()]))
      this.changed.clear()
      await store.save(batch).catch(error => this.onsaveerror(error))
    })
    return this.saving
  }

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
