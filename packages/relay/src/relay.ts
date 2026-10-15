import type { Server } from 'node:http'
import { UserNetwork } from './user-network.js'
import { relay, WebSocketConnection } from './websocket.js'

export interface RelayOptions {
  /** The path WebSocket connections come to (e.g. /net); any if not given. */
  path?: string
  /**
   * Whether a page from `origin` may connect (its Origin header; undefined
   * for a client that isn't a browser, such as a script on this machine,
   * which could reach the network itself anyway).
   */
  allowed: (origin: string | undefined) => boolean
  /** Host ports forwarded to guest ports, as `npm start` does (2222 → 22), if free. */
  forwards?: [host: number, guest: number][]
}

/**
 * Give each page that connects (a WebSocket to `server`) a network: a
 * user-mode NAT of its own here, which its network card's Ethernet frames
 * go through (WebSocketNetwork, in the page).
 *
 * The NAT reaches what this machine reaches, its own services included
 * (10.0.2.2 is its localhost), so only pages from allowed origins get one:
 * otherwise any web site open in the browser could use it, through
 * ws://localhost.
 */
export function serveNetworks(server: Server, { path, allowed, forwards = [] }: RelayOptions): void {
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if ((path && url.pathname !== path) || !allowed(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const ws = WebSocketConnection.accept(request, socket)
    if (!ws) return
    const network = new UserNetwork()
    // A port in use (say, by npm start, or another page) is no reason not to run.
    for (const [host, guest] of forwards) network.forward(host, guest).catch(() => {})
    relay(ws, network)
  })
}

/** True for pages served from this machine (localhost, 127.0.0.1, [::1]; any port). */
export function isLocalOrigin(origin: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}
