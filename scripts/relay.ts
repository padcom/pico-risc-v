/**
 * `npm run relay`: a network for the emulator's page where it has none, such
 * as on GitHub Pages (npm run site): run this, then open the page with
 * ?relay=ws://localhost:8081. The page's network card then reaches the
 * internet through a user-mode NAT here, on this machine, as with npm start
 * (which also forwards localhost:2222 to the guest's ssh).
 *
 *   node scripts/relay.ts [--port <port>] [--origin <origin>]...
 *
 * The NAT reaches what this machine reaches, so only pages from allowed
 * origins may use it, not any web site open in the browser: pages from this
 * machine (localhost), this project's GitHub Pages (from the git remote:
 * https://<owner>.github.io), and those given with --origin. It listens on
 * localhost only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({
  options: { port: { type: 'string', default: '8081' }, origin: { type: 'string', multiple: true, default: [] } },
})

if (emulatorStale()) {
  console.log('[relay] compiling the emulator')
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
}
const { isLocalOrigin, serveNetworks } = await import('../dist/net/relay.js')

const origins = new Set([...values.origin, ...githubPages()].map(origin => origin.replace(/\/$/, '')))
const server = createServer((_, response) => response.writeHead(426, { 'content-type': 'text/plain' }).end('A WebSocket relay for the emulator\'s page: see scripts/relay.ts\n'))
serveNetworks(server, {
  allowed: origin => origin === undefined || isLocalOrigin(origin) || origins.has(origin),
  forwards: [[2222, 22]],
})
server.listen(Number(values.port), '127.0.0.1', () => {
  const port = (server.address() as AddressInfo).port
  console.log(`[relay] ws://localhost:${port} for pages from localhost${[...origins].map(o => `, ${o}`).join('')}`)
  console.log(`[relay] open the page with ?relay=ws://localhost:${port}`)
})

/** This project's GitHub Pages origin, if its git remote is on GitHub. */
function githubPages(): string[] {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
    const owner = /github\.com[:/]([^/]+)\//.exec(remote)?.[1]
    return owner ? [`https://${owner.toLowerCase()}.github.io`] : []
  } catch {
    return []
  }
}

/** dist/ is missing or older than some source file. */
function emulatorStale(): boolean {
  const built = join(root, 'dist/net/relay.js')
  if (!existsSync(built)) return true
  const time = statSync(built).mtimeMs
  return readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .some(f => statSync(join(root, 'src', f)).mtimeMs > time)
}
