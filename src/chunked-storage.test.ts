import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ChunkManifest, ChunkedStorage, gunzip } from './chunked-storage.js'

const CHUNK = 4096
/** 3.5 chunks: byte i is i % 251, but chunk 1 is all zeros (so not stored). */
const IMAGE = new Uint8Array(3 * CHUNK + CHUNK / 2).map((_, i) => (Math.floor(i / CHUNK) === 1 ? 0 : i % 251))

describe('ChunkedStorage', () => {
  let server: Server
  let url: string
  const requests: string[] = []

  beforeAll(async () => {
    // A plain web server with the image split as scripts/site.ts splits it.
    const files = new Map<string, Uint8Array>()
    const manifest: ChunkManifest = { size: IMAGE.length, chunk: CHUNK, chunks: [0, 2, 3] }
    files.set('/disk/manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    for (const i of manifest.chunks) files.set(`/disk/${i}.gz`, gzipSync(IMAGE.subarray(i * CHUNK, (i + 1) * CHUNK)))
    server = createServer((req, res) => {
      requests.push(req.url!)
      const file = files.get(req.url!)
      res.writeHead(file ? 200 : 404).end(file)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/disk/manifest.json`
  })
  afterAll(() => server.close())

  it('reads chunks as needed, each once, unpacked; those not stored are zeros', async () => {
    requests.length = 0
    const disk = await ChunkedStorage.open(url)
    expect([disk.size, disk.readOnly]).toEqual([IMAGE.length, true])
    const dest = new Uint8Array(2 * CHUNK)
    // Chunks 0 (half), 1 (not stored), 2 (half): two fetched, at the same time as another read of chunk 2.
    await Promise.all([disk.read(CHUNK / 2, dest), disk.read(2 * CHUNK, new Uint8Array(1))])
    expect(dest).toEqual(IMAGE.subarray(CHUNK / 2, CHUNK / 2 + 2 * CHUNK))
    expect(requests).toEqual(['/disk/manifest.json', '/disk/0.gz', '/disk/2.gz'])
    expect(disk.read(CHUNK + 10, dest.subarray(0, 10))).toBeUndefined() // zeros: nothing to fetch
    expect(disk.read(0, dest.subarray(0, 10))).toBeUndefined() // here already
    // The last chunk is short.
    await disk.read(IMAGE.length - 10, dest.subarray(0, 10))
    expect(dest.subarray(0, 10)).toEqual(IMAGE.subarray(-10))
    expect(() => disk.write()).toThrow(/read-only/)
  })

  it('unpacks gzip data, and leaves other data (unpacked by the browser already) alone', async () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 7)
    expect(await gunzip(new Uint8Array(gzipSync(data)))).toEqual(data)
    expect(await gunzip(data)).toBe(data)
  })
})
