import type { ChunkStore } from './block-storage.js'

/** A request's result, when it has one. */
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** When a transaction has committed. */
const committed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'))
  })

/**
 * A disk's saved chunks (a SnapshotStorage's) in the browser's IndexedDB, so
 * the web page has its disk as it left it, next time: a database per disk
 * (`risc-emulator-disk-<name>`), with the chunks, and which image (the
 * base's id) they go with. Chunks saved for another image don't apply to
 * this one (the site has a new one, say): opening the store drops them.
 */
export class IndexedDbStore implements ChunkStore {
  readonly saved: Set<number>
  /** After clear(): saves do nothing (a running machine mustn't save again). */
  private cleared = false

  private constructor(
    private readonly db: IDBDatabase,
    saved: number[],
    /** Whether it had chunks for another image, now dropped. */
    readonly discarded: boolean,
  ) {
    this.saved = new Set(saved)
  }

  /** The store of disk `name`, for the base image `image` (its id). */
  static async open(name: string, image: string): Promise<IndexedDbStore> {
    const request = indexedDB.open(`risc-emulator-disk-${name}`, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('chunks')
      request.result.createObjectStore('meta')
    }
    const db = await result(request)
    const transaction = db.transaction(['chunks', 'meta'], 'readwrite')
    const done = committed(transaction)
    const chunks = transaction.objectStore('chunks')
    const meta = transaction.objectStore('meta')
    const was = await result(meta.get('image'))
    let discarded = false
    if (was !== image) {
      discarded = was !== undefined && (await result(chunks.count())) > 0
      chunks.clear()
      meta.put(image, 'image')
    }
    const saved = (await result(chunks.getAllKeys())) as number[]
    await done
    return new IndexedDbStore(db, saved, discarded)
  }

  async load(index: number): Promise<Uint8Array> {
    const chunk = await result(this.db.transaction('chunks').objectStore('chunks').get(index))
    if (!(chunk instanceof Uint8Array)) throw new Error(`no saved chunk ${index}`)
    return chunk
  }

  async save(batch: ReadonlyMap<number, Uint8Array>): Promise<void> {
    if (this.cleared) return
    const transaction = this.db.transaction('chunks', 'readwrite')
    const done = committed(transaction)
    const chunks = transaction.objectStore('chunks')
    for (const [index, chunk] of batch) chunks.put(chunk, index)
    await done
    for (const index of batch.keys()) this.saved.add(index)
  }

  /** Forget everything saved, and save nothing more (the page reloads next). */
  async clear(): Promise<void> {
    this.cleared = true
    const transaction = this.db.transaction('chunks', 'readwrite')
    const done = committed(transaction)
    transaction.objectStore('chunks').clear()
    await done
    this.saved.clear()
  }
}
