import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SnapshotStorage } from './block-storage.js'
import { HttpStorage } from './http-storage.js'

/** 1 MiB + 100 bytes: byte i is i % 251. */
const IMAGE = new Uint8Array(1024 * 1024 + 100).map((_, i) => i % 251)
const CHUNK = 256 * 1024

describe('HttpStorage', () => {
  let server: Server
  let url: string
  const ranges: string[] = []

  beforeAll(async () => {
    // A web server for IMAGE, with Range requests (as npm run web's).
    server = createServer((req, res) => {
      if (req.method === 'HEAD') return res.writeHead(200, { 'content-length': IMAGE.length }).end()
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!.map(Number)
      ranges.push(`${start}-${end}`)
      res.writeHead(206, { 'content-length': end! - start! + 1 }).end(IMAGE.subarray(start!, end! + 1))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/disk.img`
  })
  afterAll(() => server.close())

  it('reads ranges as needed, in chunks, each once; then right away', async () => {
    ranges.length = 0
    const disk = await HttpStorage.open(url)
    expect([disk.size, disk.readOnly]).toEqual([IMAGE.length, true])
    const dest = new Uint8Array(100)
    // Across the first two chunks: both fetched (once, though asked for twice at the same time).
    await Promise.all([disk.read(CHUNK - 50, dest), disk.read(CHUNK - 10, new Uint8Array(1))])
    expect(dest).toEqual(IMAGE.subarray(CHUNK - 50, CHUNK + 50))
    expect(ranges).toEqual([`0-${CHUNK - 1}`, `${CHUNK}-${2 * CHUNK - 1}`])
    expect(disk.read(10, dest)).toBeUndefined() // here already
    expect(dest).toEqual(IMAGE.subarray(10, 110))
    // The last chunk is short.
    await disk.read(IMAGE.length - 10, dest.subarray(0, 10))
    expect(dest.subarray(0, 10)).toEqual(IMAGE.subarray(-10))
    expect(ranges.at(-1)).toBe(`${4 * CHUNK}-${IMAGE.length - 1}`)
    expect(() => disk.write()).toThrow(/read-only/)
  })

  it('keeps at most `cache` bytes, dropping the least recently used chunk', async () => {
    ranges.length = 0
    const disk = await HttpStorage.open(url, { cache: 2 * CHUNK })
    const byte = new Uint8Array(1)
    await disk.read(0, byte)
    await disk.read(CHUNK, byte)
    expect(disk.read(0, byte)).toBeUndefined() // chunk 0 used last now
    await disk.read(2 * CHUNK, byte) // drops chunk 1
    expect(disk.read(0, byte)).toBeUndefined()
    await disk.read(CHUNK, byte)
    expect(ranges.length).toBe(4)
  })

  it('takes writes in a snapshot overlay on top', async () => {
    const snap = new SnapshotStorage(await HttpStorage.open(url))
    await snap.write(1000, Uint8Array.of(1, 2, 3))
    const back = new Uint8Array(5)
    await snap.read(999, back)
    expect([...back]).toEqual([IMAGE[999], 1, 2, 3, IMAGE[1003]])
  })
})
