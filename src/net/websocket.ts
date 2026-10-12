import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { NetworkBackend } from '../virtio-net.js'

/** RFC 6455: what a server adds to the client's key to show it speaks WebSocket. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONTINUATION = 0x0
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
/** Biggest message taken (a frame is at most about 1.5 KiB). */
const MAX_MESSAGE = 1 << 20

/**
 * The server side of a WebSocket connection (RFC 6455), just what carrying
 * Ethernet frames takes: binary messages, ping, close. For npm run web (Node
 * has a WebSocket client, but no server).
 */
export class WebSocketConnection {
  /** A binary message from the client. */
  onmessage: (data: Uint8Array) => void = () => {}
  onclose: () => void = () => {}
  private buffer = Buffer.alloc(0)
  /** A message coming in fragments. */
  private fragments: Buffer[] = []

  private constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('close', () => this.onclose())
    socket.on('error', () => socket.destroy())
  }

  /** Answer an HTTP upgrade request (the server's 'upgrade' event); undefined if it isn't a WebSocket one. */
  static accept(request: IncomingMessage, socket: Duplex): WebSocketConnection | undefined {
    const key = request.headers['sec-websocket-key']
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return undefined
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    return new WebSocketConnection(socket)
  }

  send(data: Uint8Array): void {
    this.frame(OP_BINARY, data)
  }

  close(): void {
    this.frame(OP_CLOSE, new Uint8Array(0))
    this.socket.end()
  }

  /** A whole message in one frame (FIN set, unmasked, as servers send them). */
  private frame(opcode: number, data: Uint8Array): void {
    if (this.socket.destroyed) return
    const n = data.length
    const header = Buffer.alloc(n < 126 ? 2 : n < 0x10000 ? 4 : 10)
    header[0] = 0x80 | opcode
    if (n < 126) header[1] = n
    else if (n < 0x10000) {
      header[1] = 126
      header.writeUInt16BE(n, 2)
    } else {
      header[1] = 127
      header.writeBigUInt64BE(BigInt(n), 2)
    }
    this.socket.write(Buffer.concat([header, data]))
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const b = this.buffer
      if (b.length < 2) return
      const fin = (b[0]! & 0x80) !== 0
      const opcode = b[0]! & 0x0f
      const masked = (b[1]! & 0x80) !== 0
      let length = b[1]! & 0x7f
      let at = 2
      if (length === 126) {
        if (b.length < 4) return
        length = b.readUInt16BE(2)
        at = 4
      } else if (length === 127) {
        if (b.length < 10) return
        length = Number(b.readBigUInt64BE(2))
        at = 10
      }
      if (!masked || length > MAX_MESSAGE) return void this.socket.destroy() // (clients must mask)
      if (b.length < at + 4 + length) return
      const mask = b.subarray(at, at + 4)
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!
      this.buffer = b.subarray(at + 4 + length)

      if (opcode === OP_CLOSE) return this.close()
      if (opcode === OP_PING) this.frame(0xa, payload) // pong
      else if (opcode === OP_BINARY || opcode === OP_CONTINUATION) {
        this.fragments.push(payload)
        if (fin) {
          const message = Buffer.concat(this.fragments)
          this.fragments = []
          this.onmessage(message)
        }
      }
      // (Text messages, pongs: nothing to do.)
    }
  }
}

/** Carry Ethernet frames between a WebSocket and a network, until the socket closes (then the network is closed). */
export function relay(socket: WebSocketConnection, network: NetworkBackend): void {
  network.attach(frame => socket.send(frame))
  socket.onmessage = frame => network.send(frame)
  socket.onclose = () => network.close?.()
}
