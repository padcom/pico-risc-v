#!/usr/bin/env node
/**
 * `npx @padcom/pico-risc-v-relay`: a network for Pico RISC-V's web page,
 * where it has none (GitHub Pages): run this, then open the page with
 * ?relay=ws://localhost:8081. The page's network card then reaches the
 * internet through a user-mode NAT here, on this machine (and localhost:2222
 * reaches the guest's ssh).
 *
 *   pico-risc-v-relay [--port <port>] [--origin <origin>]...
 *
 * The NAT reaches what this machine reaches, so only pages from allowed
 * origins may use it, not any web site open in the browser: pages from this
 * machine (localhost), Pico RISC-V's GitHub Pages (https://padcom.github.io),
 * and those given with --origin (a fork's Pages, say). It listens on
 * localhost only.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { isLocalOrigin, serveNetworks } from './relay.js'

/** Where Pico RISC-V's page is published. */
const PICO_RISC_V_PAGES = 'https://padcom.github.io'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8081' },
    origin: { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (values.help) {
  console.log('usage: pico-risc-v-relay [--port <port>] [--origin <origin>]...')
  console.log(`  a network for Pico RISC-V's page: open it with ?relay=ws://localhost:<port> (default 8081);`)
  console.log(`  pages from localhost and ${PICO_RISC_V_PAGES} may use it, and those given with --origin`)
  process.exit(0)
}

const origins = new Set([PICO_RISC_V_PAGES, ...values.origin].map(origin => origin.replace(/\/$/, '')))
const server = createServer((_, response) =>
  response.writeHead(426, { 'content-type': 'text/plain' }).end("A WebSocket relay for Pico RISC-V's page: open the page with ?relay=ws://localhost:<this port>\n"),
)
serveNetworks(server, {
  allowed: origin => origin === undefined || isLocalOrigin(origin) || origins.has(origin),
  forwards: [[2222, 22]],
})
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[relay] ${error.code === 'EADDRINUSE' ? `port ${values.port} is taken (--port <another>)` : error.message}`)
  process.exit(1)
})
server.listen(Number(values.port), '127.0.0.1', () => {
  const port = (server.address() as AddressInfo).port
  console.log(`[relay] ws://localhost:${port} for pages from localhost${[...origins].map(o => `, ${o}`).join('')}`)
  console.log(`[relay] open the page with ?relay=ws://localhost:${port}`)
})
