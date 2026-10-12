import type { BlockStorage } from './block-storage.js'

/** Bytes per request. */
const CHUNK = 256 * 1024

export interface HttpStorageOptions {
  /** Keep at most this many bytes of what was read (default 256 MiB); the least recently used go first. */
  cache?: number
}

/**
 * A disk image read over HTTP (in a browser: from the web server), in chunks
 * of CHUNK bytes with Range requests, only as they're needed. Read-only (put
 * a SnapshotStorage on top for writes). Reads of chunks already here
 * complete right away; others when the server has answered.
 */
export class HttpStorage implements BlockStorage {
  readonly readOnly = true
  /** Chunks, least recently used first. */
  private readonly chunks = new Map<number, Uint8Array>()
  private readonly fetching = new Map<number, Promise<Uint8Array>>()
  private readonly maxChunks: number

  private constructor(
    readonly url: string,
    readonly size: number,
    /** What the image holds, as far as the server says (its size, and ETag or Last-Modified). */
    readonly id: string | undefined,
    { cache = 256 * 1024 * 1024 }: HttpStorageOptions,
  ) {
    this.maxChunks = Math.max(1, Math.floor(cache / CHUNK))
  }

  /** The image at `url` (its size from a HEAD request). */
  static async open(url: string, options: HttpStorageOptions = {}): Promise<HttpStorage> {
    const response = await fetch(url, { method: 'HEAD' })
    const size = Number(response.headers.get('content-length'))
    if (!response.ok || !Number.isSafeInteger(size)) throw new Error(`${url}: ${response.status} ${response.statusText}`)
    const version = response.headers.get('etag') ?? response.headers.get('last-modified')
    return new HttpStorage(url, size, version ? `${size} ${version}` : undefined, options)
  }

  read(offset: number, dest: Uint8Array): void | Promise<void> {
    const first = Math.floor(offset / CHUNK)
    const last = Math.floor((offset + dest.length - 1) / CHUNK)
    const copy = (index: number, chunk: Uint8Array) => {
      const start = Math.max(offset, index * CHUNK)
      const end = Math.min(offset + dest.length, (index + 1) * CHUNK)
      dest.set(chunk.subarray(start - index * CHUNK, end - index * CHUNK), start - offset)
    }
    const pending: Promise<void>[] = []
    for (let index = first; index <= last && dest.length; index++) {
      const chunk = this.chunks.get(index)
      if (chunk) {
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
      const start = index * CHUNK
      const end = Math.min(start + CHUNK, this.size) - 1
      fetching = fetch(this.url, { headers: { range: `bytes=${start}-${end}` } })
        .then(async response => {
          if (response.status !== 206) throw new Error(`${this.url}: no range ${start}-${end} (${response.status})`)
          const chunk = new Uint8Array(await response.arrayBuffer())
          if (chunk.length !== end - start + 1) throw new Error(`${this.url}: short range ${start}-${end}`)
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
