import type { NetworkBackend } from './virtio-net.js'

/**
 * A network reached over a WebSocket, a binary message per Ethernet frame
 * each way: in a browser, which can't open sockets of its own, the network
 * card's way out, through a server that puts the frames on a network (npm
 * run web: a user-mode NAT per connection, see net/websocket.ts).
 */
export class WebSocketNetwork implements NetworkBackend {
  private readonly socket: WebSocket
  private receive: (frame: Uint8Array) => void = () => {}
  /** The connection is up; it went down (or never came up). */
  onopen: () => void = () => {}
  onclose: () => void = () => {}
  /** Whether the connection came up (false: it closed before). */
  readonly opened: Promise<boolean>
  /** Frames sent before the socket opened. */
  private waiting: Uint8Array<ArrayBuffer>[] = []

  constructor(url: string | URL) {
    this.socket = new WebSocket(url)
    this.socket.binaryType = 'arraybuffer'
    this.opened = new Promise(resolve => {
      this.socket.addEventListener('open', () => resolve(true))
      this.socket.addEventListener('close', () => resolve(false))
    })
    this.socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) this.receive(new Uint8Array(data))
    }
    this.socket.onopen = () => {
      for (const frame of this.waiting) this.socket.send(frame)
      this.waiting = []
      this.onopen()
    }
    this.socket.onclose = () => {
      this.waiting = []
      this.onclose()
    }
  }

  send(frame: Uint8Array): void {
    // (A copy: the frame may be a view of the guest's memory, which is shared,
    // and WebSocket won't send from shared memory.)
    const copy = frame.slice()
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(copy)
    else if (this.socket.readyState === WebSocket.CONNECTING) this.waiting.push(copy)
  }

  attach(receive: (frame: Uint8Array) => void): void {
    this.receive = receive
  }

  close(): void {
    this.socket.close()
  }
}
