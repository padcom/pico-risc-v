/**
 * `npm run web`: the emulator in a web browser. Serves the page (web/) and
 * what it loads, then open http://localhost:8080/ (Debian, as npm start sets
 * it up; it must have been, once), or e.g. /?image=examples/build/hello.bin.
 *
 *   node scripts/web.ts [--port <port>]     (0: any free one)
 *
 * - Every response is cross-origin isolated (COOP/COEP): browsers only give
 *   such pages SharedArrayBuffer, which the harts' threads need.
 * - Files are served with Range requests: the page reads Debian's disk a
 *   piece at a time (src/http-storage.ts).
 * - /net is a WebSocket per page carrying the network card's Ethernet frames
 *   to a user-mode NAT here (src/net/relay.ts), which also forwards
 *   localhost:2222 to the guest's port 22, as npm start does. Only pages
 *   from this machine may connect.
 *
 * Only what the page needs is served, and only to this machine (localhost).
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildWasm } from '../packages/hart/scripts/build-wasm.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { port: { type: 'string', default: '8080' } } })

/** URL path prefixes served, and where from (relative to the project). */
const SERVED: [string, string][] = [
  ['/dist/', 'dist/'],
  ['/hart/dist/', 'packages/hart/dist/'],
  ['/hart/hart.wasm', 'packages/hart/build/hart.wasm'],
  ['/images/debian/', 'images/debian/'],
  ['/examples/build/', 'examples/build/'],
  ['/xterm/', 'node_modules/@xterm/xterm/'],
  ['/xterm-fit/', 'node_modules/@xterm/addon-fit/'],
  ['/', 'web/'],
]
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
}
const ISOLATED = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
}

// What the page loads, up to date.
buildWasm()
// (tsc -b: only what changed, here or in packages/.)
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
// (Once compiled.)
const { isLocalOrigin, serveNetworks } = await import('@padcom/pico-risc-v-relay')
if (!existsSync(join(root, 'images/debian/pristine.raw'))) {
  console.log('[web] Debian is not set up (npm start does it); bare-metal images still work: /?image=examples/build/hello.bin')
}

const server = createServer(serve)
// (Only for pages from here: not for other sites open in the browser.)
serveNetworks(server, { path: '/net', allowed: origin => origin === undefined || isLocalOrigin(origin), forwards: [[2222, 22]] })
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`[web] http://localhost:${(server.address() as AddressInfo).port}/`)
})

function serve(request: IncomingMessage, response: ServerResponse): void {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const file = resolve(path === '/' ? '/index.html' : path)
  if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return void response.writeHead(404, ISOLATED).end()
  }
  const { size, mtime } = statSync(file)
  const headers = {
    ...ISOLATED,
    'last-modified': mtime.toUTCString(),
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1)
    if (start > end) return void response.writeHead(416, { ...ISOLATED, 'content-range': `bytes */${size}` }).end()
    response.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` })
    if (request.method === 'HEAD') return void response.end()
    return void createReadStream(file, { start, end }).pipe(response)
  }
  response.writeHead(200, { ...headers, 'content-length': size })
  if (request.method === 'HEAD') return void response.end()
  createReadStream(file).pipe(response)
}

/** The file a URL path names, if it's one that's served (and exists). */
function resolve(path: string): string | undefined {
  for (const [prefix, dir] of SERVED) {
    if (!path.startsWith(prefix)) continue
    const base = normalize(join(root, dir))
    const file = normalize(join(base, path.slice(prefix.length)))
    // (Nothing outside what's served: no "..".)
    const inside = dir.endsWith('/') ? file.startsWith(base) : file === base
    if (inside && existsSync(file) && statSync(file).isFile()) return file
    return undefined
  }
  return undefined
}

/** dist/ is missing or older than some source file. */
