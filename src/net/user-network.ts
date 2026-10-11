import { execFile } from 'node:child_process'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { getServers } from 'node:dns'
import { connect, type Socket } from 'node:net'
import type { NetworkBackend } from '../virtio-net.js'
import {
  arpReply,
  BROADCAST_MAC,
  ethernet,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  icmpEchoReply,
  ip,
  ipString,
  ipv4,
  parseArp,
  parseEthernet,
  parseIpv4,
  parseTcp,
  parseUdp,
  PROTO_ICMP,
  PROTO_TCP,
  PROTO_UDP,
  seqAdd,
  seqDiff,
  type Tcp,
  tcp,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  udp,
} from './packet.js'

/** The virtual network, as in QEMU's user-mode networking. */
export const GUEST_IP = ip('10.0.2.15')
export const GATEWAY_IP = ip('10.0.2.2') // the host itself (its loopback)
export const DNS_IP = ip('10.0.2.3')
const NETMASK = ip('255.255.255.0')
const ROUTER_MAC = Uint8Array.of(0x52, 0x55, 0x0a, 0x00, 0x02, 0x02)

const MSS = 1460
const WINDOW = 65535
const UDP_IDLE_MS = 60_000
const UDP_REPLY_WAIT_MS = 3_000
/** Stop reading from a host socket while this much data waits for the guest. */
const BACKLOG_HIGH = 256 * 1024

export interface UserNetworkOptions {
  /**
   * DNS server that queries to 10.0.2.3 are relayed to, as "host" or
   * "host:port" (default: the host's first IPv4 resolver, port 53).
   */
  dnsServer?: string
  /**
   * Pings a host on the guest's behalf; resolves to whether it answered.
   * Default: the host's `ping` command, which may send ICMP without root
   * (unlike a Node process).
   */
  ping?: (host: string) => Promise<boolean>
}

/** One echo request through the host's ping command (4 s timeout). */
const systemPing = (host: string) =>
  new Promise<boolean>(resolve => execFile('ping', ['-c', '1', host], { timeout: 4000 }, error => resolve(!error)))

/**
 * User-mode NAT, like QEMU's default "slirp" network. The emulator plays
 * the router the guest is connected to:
 *
 *   - answers ARP for 10.0.2.2 (gateway) and 10.0.2.3 (DNS), and pings to them;
 *     pings elsewhere are carried out with the host's ping command
 *   - hands out 10.0.2.15 by DHCP, with that gateway and DNS server
 *   - relays DNS queries to the host's resolver
 *   - relays other UDP datagrams through host UDP sockets
 *   - terminates the guest's TCP connections and opens matching host TCP
 *     connections, copying data both ways
 *
 * Connections to 10.0.2.2 go to the host's 127.0.0.1. Outgoing only: nothing
 * from outside can connect in.
 */
export class UserNetwork implements NetworkBackend {
  private receive: (frame: Uint8Array) => void = () => {}
  private guestMac = BROADCAST_MAC
  private readonly connections = new Map<string, TcpConnection>()
  private readonly udpRelays = new Map<string, UdpRelay>()
  private readonly dnsHost: string
  private readonly dnsPort: number
  private readonly ping: (host: string) => Promise<boolean>
  private pingsInFlight = 0

  constructor({ dnsServer, ping = systemPing }: UserNetworkOptions = {}) {
    this.ping = ping
    const [host, port] = (dnsServer ?? getServers().find(s => /^\d+\.\d+\.\d+\.\d+$/.test(s)) ?? '8.8.8.8').split(':')
    this.dnsHost = host!
    this.dnsPort = port ? Number(port) : 53
  }

  attach(receive: (frame: Uint8Array) => void): void {
    this.receive = receive
  }

  get busy(): boolean {
    if (this.connections.size || this.pingsInFlight) return true
    for (const r of this.udpRelays.values()) if (r.awaitingReply) return true
    return false
  }

  close(): void {
    for (const c of this.connections.values()) c.destroy()
    for (const r of this.udpRelays.values()) r.close()
  }

  send(frame: Uint8Array): void {
    const eth = parseEthernet(frame)
    if (!eth) return
    if (eth.type === ETHERTYPE_ARP) this.handleArp(eth.payload)
    else if (eth.type === ETHERTYPE_IPV4) {
      this.guestMac = eth.src.slice()
      const packet = parseIpv4(eth.payload)
      if (packet?.proto === PROTO_UDP) this.handleUdp(packet.src, packet.dst, packet.payload)
      else if (packet?.proto === PROTO_TCP) this.handleTcp(packet.src, packet.dst, packet.payload)
      else if (packet?.proto === PROTO_ICMP) this.handleIcmp(packet.src, packet.dst, packet.payload)
    }
    // Anything else (IPv6, ...) has nowhere to go.
  }

  /** Send an IPv4 packet to the guest. */
  toGuest(packet: Uint8Array, dstMac = this.guestMac): void {
    this.receive(ethernet(dstMac, ROUTER_MAC, ETHERTYPE_IPV4, packet))
  }

  /** The host address and port behind a guest-visible destination. */
  hostEndpoint(addr: number, port: number): { host: string; port: number } {
    if (addr === GATEWAY_IP) return { host: '127.0.0.1', port }
    if (addr === DNS_IP && port === 53) return { host: this.dnsHost, port: this.dnsPort }
    return { host: ipString(addr), port }
  }

  forget(key: string): void {
    this.connections.delete(key)
  }

  private handleArp(payload: Uint8Array): void {
    const arp = parseArp(payload)
    if (!arp || arp.op !== 1) return
    this.guestMac = arp.senderMac.slice()
    if (arp.targetIp === GATEWAY_IP || arp.targetIp === DNS_IP) {
      this.receive(ethernet(arp.senderMac, ROUTER_MAC, ETHERTYPE_ARP, arpReply(ROUTER_MAC, arp.targetIp, arp.senderMac, arp.senderIp)))
    }
  }

  private handleIcmp(src: number, dst: number, payload: Uint8Array): void {
    const reply = icmpEchoReply(payload)
    if (!reply) return // only echo requests are handled
    if (dst === GATEWAY_IP || dst === DNS_IP) return this.toGuest(ipv4(dst, src, PROTO_ICMP, reply))
    // Elsewhere: ask the real host whether it answers, then answer for it (the
    // guest sees the round-trip time plus the time to run the ping command).
    this.pingsInFlight++
    void this.ping(ipString(dst)).then(alive => {
      this.pingsInFlight--
      if (alive) this.toGuest(ipv4(dst, src, PROTO_ICMP, reply))
    })
  }

  private handleUdp(src: number, dst: number, payload: Uint8Array): void {
    const datagram = parseUdp(payload)
    if (!datagram) return
    if (datagram.dstPort === 67) return this.handleDhcp(datagram.data)
    // One host socket per guest port and destination.
    const key = `${datagram.srcPort}>${dst}:${datagram.dstPort}`
    let relay = this.udpRelays.get(key)
    if (!relay) {
      relay = new UdpRelay(this, src, datagram.srcPort, dst, datagram.dstPort, () => this.udpRelays.delete(key))
      this.udpRelays.set(key, relay)
    }
    relay.send(datagram.data)
  }

  private handleTcp(src: number, dst: number, payload: Uint8Array): void {
    const segment = parseTcp(payload)
    if (!segment) return
    const key = `${segment.srcPort}>${dst}:${segment.dstPort}`
    const existing = this.connections.get(key)
    if (existing) return existing.fromGuest(segment)
    if ((segment.flags & (TCP_SYN | TCP_ACK)) === TCP_SYN) {
      this.connections.set(key, new TcpConnection(this, key, src, dst, segment))
    } else if (!(segment.flags & TCP_RST)) {
      // Not a connection we know: reset it.
      const len = segment.data.length + (segment.flags & TCP_FIN ? 1 : 0)
      this.toGuest(
        tcp(dst, src, {
          srcPort: segment.dstPort,
          dstPort: segment.srcPort,
          seq: segment.flags & TCP_ACK ? segment.ack : 0,
          ack: seqAdd(segment.seq, len),
          flags: TCP_RST | TCP_ACK,
          window: 0,
          data: new Uint8Array(0),
        }),
      )
    }
  }

  // --- DHCP (RFC 2131): always offer the same address ------------------------

  private handleDhcp(request: Uint8Array): void {
    if (request.length < 240 || request[0] !== 1) return // BOOTREQUEST
    const v = new DataView(request.buffer, request.byteOffset, request.byteLength)
    if (v.getUint32(236) !== 0x63825363) return // magic cookie
    let type = 0
    for (let i = 240; i < request.length && request[i] !== 255; ) {
      const code = request[i]!
      if (code === 0) {
        i++
        continue
      }
      if (code === 53) type = request[i + 2]!
      i += 2 + (request[i + 1] ?? 0)
    }
    const replyType = type === 1 ? 2 : type === 3 ? 5 : 0 // DISCOVER → OFFER, REQUEST → ACK
    if (!replyType) return

    const reply = new Uint8Array(300)
    const r = new DataView(reply.buffer)
    reply[0] = 2 // BOOTREPLY
    reply[1] = 1 // Ethernet
    reply[2] = 6
    r.setUint32(4, v.getUint32(4)) // xid
    r.setUint32(16, GUEST_IP) // yiaddr
    r.setUint32(20, GATEWAY_IP) // siaddr
    reply.set(request.subarray(28, 44), 28) // chaddr
    r.setUint32(236, 0x63825363)
    const options = [
      [53, replyType],
      [54, ...bytes(GATEWAY_IP)], // server id
      [51, ...bytes(86400)], // lease time
      [1, ...bytes(NETMASK)],
      [3, ...bytes(GATEWAY_IP)], // router
      [6, ...bytes(DNS_IP)], // DNS server
    ]
    let at = 240
    for (const [code, ...data] of options) {
      reply.set([code!, data.length, ...data], at)
      at += 2 + data.length
    }
    reply[at] = 255
    this.toGuest(udp(GATEWAY_IP, 67, 0xffffffff, 68, reply), BROADCAST_MAC)
  }
}

const bytes = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** A guest UDP flow (port → destination) relayed through a host UDP socket. */
class UdpRelay {
  private readonly socket: UdpSocket
  private idle: ReturnType<typeof setTimeout> | undefined
  private lastSend = 0
  private replied = true

  constructor(
    private readonly net: UserNetwork,
    private readonly guestIp: number,
    private readonly guestPort: number,
    private readonly dst: number,
    private readonly dstPort: number,
    private readonly onClose: () => void,
  ) {
    this.socket = createSocket('udp4')
    this.socket.on('message', data => {
      this.replied = true
      // Replies appear to come from where the guest sent to (DNS → 10.0.2.3, localhost → 10.0.2.2).
      this.net.toGuest(udp(this.dst, this.dstPort, this.guestIp, this.guestPort, data))
    })
    this.socket.on('error', () => this.close())
  }

  get awaitingReply(): boolean {
    return !this.replied && Date.now() - this.lastSend < UDP_REPLY_WAIT_MS
  }

  send(data: Uint8Array): void {
    this.lastSend = Date.now()
    this.replied = false
    const { host, port } = this.net.hostEndpoint(this.dst, this.dstPort)
    this.socket.send(data, port, host)
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), UDP_IDLE_MS)
    this.idle.unref()
  }

  close(): void {
    clearTimeout(this.idle)
    this.socket.close()
    this.onClose()
  }
}

/**
 * One guest TCP connection, terminated here and continued over a host socket.
 * The link to the guest is in-memory and lossless, so we never retransmit; we
 * only have to respect the guest's receive window.
 */
class TcpConnection {
  private readonly guestPort: number
  private readonly remotePort: number
  private readonly socket: Socket
  private state: 'connecting' | 'syn-received' | 'established' = 'connecting'
  private readonly iss = (Math.random() * 0x1_0000_0000) >>> 0
  private sndUna = this.iss // oldest byte the guest hasn't acknowledged
  private sndNxt = this.iss // next byte we send
  private rcvNxt: number // next byte we expect from the guest
  private guestWindow: number
  private readonly mss: number
  private backlog: Buffer[] = [] // host data not yet sent to the guest
  private backlogBytes = 0
  private hostEnded = false
  private finSent = false
  private guestFin = false
  private closed = false

  constructor(
    private readonly net: UserNetwork,
    private readonly key: string,
    private readonly guestIp: number,
    private readonly remoteIp: number,
    syn: Tcp,
  ) {
    this.guestPort = syn.srcPort
    this.remotePort = syn.dstPort
    this.rcvNxt = seqAdd(syn.seq, 1)
    this.guestWindow = syn.window
    this.mss = Math.min(syn.mss ?? 536, MSS)

    this.socket = connect(net.hostEndpoint(remoteIp, syn.dstPort))
    this.socket.setNoDelay(true)
    this.socket.on('connect', () => {
      this.state = 'syn-received'
      this.sendSynAck()
    })
    this.socket.on('data', (data: Buffer) => { // a Buffer: no encoding is set
      this.backlog.push(data)
      this.backlogBytes += data.length
      if (this.backlogBytes > BACKLOG_HIGH) this.socket.pause()
      this.pump()
    })
    this.socket.on('end', () => {
      this.hostEnded = true
      this.pump()
    })
    this.socket.on('error', () => this.reset())
    this.socket.on('close', () => {
      if (this.state !== 'established' && !this.closed) this.reset() // refused / failed before the handshake ended
    })
  }

  fromGuest(s: Tcp): void {
    if (s.flags & TCP_RST) return this.destroy()
    if (s.flags & TCP_SYN) {
      if (this.state === 'syn-received') this.sendSynAck() // our SYN-ACK got lost? (can't happen, but harmless)
      return
    }
    if (!(s.flags & TCP_ACK)) return

    // Acknowledgement of what we sent.
    if (seqDiff(s.ack, this.sndUna) > 0 && seqDiff(s.ack, this.sndNxt) <= 0) {
      this.sndUna = s.ack
      if (this.state === 'syn-received') this.state = 'established'
    }
    this.guestWindow = s.window

    // Data, in order (out-of-order can't happen on a lossless link; just re-ACK).
    if (s.data.length || s.flags & TCP_FIN) {
      if (s.seq === this.rcvNxt) {
        if (s.data.length) {
          this.socket.write(s.data.slice())
          this.rcvNxt = seqAdd(this.rcvNxt, s.data.length)
        }
        if (s.flags & TCP_FIN && !this.guestFin) {
          this.guestFin = true
          this.rcvNxt = seqAdd(this.rcvNxt, 1)
          this.socket.end()
        }
      }
      this.segment(TCP_ACK)
    }

    this.pump()
    if (this.guestFin && this.finSent && this.sndUna === this.sndNxt) this.destroy()
  }

  /** Send what the guest's window allows; FIN once the host is done and everything is out. */
  private pump(): void {
    if (this.state === 'connecting' || this.closed) return
    while (this.backlogBytes > 0) {
      const room = this.guestWindow - seqDiff(this.sndNxt, this.sndUna)
      const n = Math.min(room, this.mss, this.backlogBytes)
      if (n <= 0) break
      const chunk = this.take(n)
      this.segment(TCP_ACK | TCP_PSH, chunk)
      this.sndNxt = seqAdd(this.sndNxt, chunk.length)
    }
    if (this.backlogBytes < BACKLOG_HIGH / 4 && this.socket.isPaused()) this.socket.resume()
    if (this.hostEnded && !this.backlogBytes && !this.finSent) {
      this.segment(TCP_FIN | TCP_ACK)
      this.sndNxt = seqAdd(this.sndNxt, 1)
      this.finSent = true
    }
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let at = 0; at < n; ) {
      const head = this.backlog[0]!
      const part = Math.min(head.length, n - at)
      out.set(head.subarray(0, part), at)
      at += part
      if (part === head.length) this.backlog.shift()
      else this.backlog[0] = head.subarray(part)
    }
    this.backlogBytes -= n
    return out
  }

  private sendSynAck(): void {
    this.sndNxt = seqAdd(this.iss, 1)
    this.segment(TCP_SYN | TCP_ACK, new Uint8Array(0), this.iss, MSS)
  }

  private segment(flags: number, data: Uint8Array = new Uint8Array(0), seq = this.sndNxt, mss?: number): void {
    this.net.toGuest(
      tcp(this.remoteIp, this.guestIp, {
        srcPort: this.remotePort,
        dstPort: this.guestPort,
        seq,
        ack: this.rcvNxt,
        flags,
        window: WINDOW,
        mss,
        data,
      }),
    )
  }

  /** Abort: tell the guest, drop the host side. */
  private reset(): void {
    if (this.closed) return
    this.segment(TCP_RST | TCP_ACK)
    this.destroy()
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.net.forget(this.key)
  }
}
