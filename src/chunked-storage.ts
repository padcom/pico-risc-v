import type { BlockStorage } from './block-storage.js'

/**
 * `bytes`, unpacked if they're gzip data. (Not just because the name ends in
 * .gz: a web server may send such a file with Content-Encoding: gzip, and
 * the browser has unpacked it already.)
 */
export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const unpacked = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(unpacked).arrayBuffer())
}

/**
 * How a disk image is split into chunks (scripts/site.ts makes them): in
 * `manifest.json`, next to chunk `i` of `chunk` bytes, `<i>.gz` (gzip
 * compressed). Chunks that are all zeros aren't there (`chunks` lists
 * those that are), as most of a disk with free space.
 */
export interface ChunkManifest {
  size: number
  chunk: number
  chunks: number[]
}

export interface ChunkedStorageOptions {
  /** Keep at most this many bytes of what was read (default 256 MiB); the least recently used go first. */
  cache?: number
}

/**
 * A disk image from a plain web server (GitHub Pages, say: no Range
 * requests to count on, files of limited size), split into compressed chunks
 * (ChunkManifest), fetched only as they're needed. Read-only (put a
 * SnapshotStorage on top for writes). Reads of chunks already here complete
 * right away; others when they've been fetched.
 */
export class ChunkedStorage implements BlockStorage {
  readonly readOnly = true
  readonly size: number
  private readonly chunk: number
  private readonly present: Set<number>
  /** Chunks, least recently used first. */
  private readonly chunks = new Map<number, Uint8Array>()
  private readonly fetching = new Map<number, Promise<Uint8Array>>()
  private readonly maxChunks: number

  private constructor(
    /** The manifest's URL: the chunks are next to it. */
    readonly url: URL,
    manifest: ChunkManifest,
    { cache = 256 * 1024 * 1024 }: ChunkedStorageOptions,
  ) {
    this.size = manifest.size
    this.chunk = manifest.chunk
    this.present = new Set(manifest.chunks)
    this.maxChunks = Math.max(1, Math.floor(cache / this.chunk))
  }

  /** The image whose manifest is at `url`. */
  static async open(url: string | URL, options: ChunkedStorageOptions = {}): Promise<ChunkedStorage> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
    return new ChunkedStorage(new URL(response.url || url), (await response.json()) as ChunkManifest, options)
  }

  read(offset: number, dest: Uint8Array): void | Promise<void> {
    const first = Math.floor(offset / this.chunk)
    const last = Math.floor((offset + dest.length - 1) / this.chunk)
    const copy = (index: number, chunk: Uint8Array | undefined) => {
      const start = Math.max(offset, index * this.chunk)
      const end = Math.min(offset + dest.length, (index + 1) * this.chunk)
      if (chunk) dest.set(chunk.subarray(start - index * this.chunk, end - index * this.chunk), start - offset)
      else dest.fill(0, start - offset, end - offset)
    }
    const pending: Promise<void>[] = []
    for (let index = first; index <= last && dest.length; index++) {
      const chunk = this.chunks.get(index)
      if (!this.present.has(index)) copy(index, undefined)
      else if (chunk) {
        // Most recently used now.
        this.chunks.delete(index)
        this.chunks.set(index, chunk)
        copy(index, chunk)
      } else {
        pending.push(this.fetchChunk(index).then(chunk => copy(index, chunk)))
      }
    }
    return pending.length ? Promise.all(pending).then(() => {}) : undefined
  }

  write(): never {
    throw new Error(`${this.url} is read-only`)
  }

  flush(): void {}

  private fetchChunk(index: number): Promise<Uint8Array> {
    let fetching = this.fetching.get(index)
    if (!fetching) {
      const url = new URL(`${index}.gz`, this.url)
      fetching = fetch(url)
        .then(async response => {
          if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
          const chunk = await gunzip(new Uint8Array(await response.arrayBuffer()))
          const expected = Math.min(this.chunk, this.size - index * this.chunk)
          if (chunk.length !== expected) throw new Error(`${url}: ${chunk.length} bytes, not ${expected}`)
          this.chunks.set(index, chunk)
          if (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value!)
          return chunk
        })
        .finally(() => this.fetching.delete(index))
      this.fetching.set(index, fetching)
    }
    return fetching
  }
}
