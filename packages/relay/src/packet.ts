/**
 * Just enough Ethernet / ARP / IPv4 / UDP / TCP to parse what a guest sends
 * and build what it receives. Multi-byte fields are big-endian (network order);
 * IPv4 addresses are unsigned 32-bit numbers.
 */

export const ETHERTYPE_IPV4 = 0x0800
export const ETHERTYPE_ARP = 0x0806
export const PROTO_ICMP = 1
export const PROTO_TCP = 6
export const PROTO_UDP = 17

export const TCP_FIN = 0x01
export const TCP_SYN = 0x02
export const TCP_RST = 0x04
export const TCP_PSH = 0x08
export const TCP_ACK = 0x10

export const BROADCAST_MAC = new Uint8Array(6).fill(0xff)

export const ip = (dotted: string) => dotted.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0
export const ipString = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

/** Internet checksum (RFC 1071) of `data`, continuing from a partial `sum`. */
export function checksum(data: Uint8Array, sum = 0): number {
  for (let i = 0; i + 1 < data.length; i += 2) sum += (data[i]! << 8) | data[i + 1]!
  if (data.length & 1) sum += data[data.length - 1]! << 8
  while (sum > 0xffff) sum = (sum & 0xffff) + Math.floor(sum / 0x10000)
  return ~sum & 0xffff
}

/** Partial sum of the IPv4 pseudo-header TCP and UDP checksums cover. */
const pseudoHeader = (src: number, dst: number, proto: number, length: number) =>
  (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + proto + length

// --- Ethernet ---------------------------------------------------------------

export interface Ethernet {
  dst: Uint8Array
  src: Uint8Array
  type: number
  payload: Uint8Array
}

export function parseEthernet(frame: Uint8Array): Ethernet | undefined {
  if (frame.length < 14) return undefined
  return { dst: frame.subarray(0, 6), src: frame.subarray(6, 12), type: view(frame).getUint16(12), payload: frame.subarray(14) }
}

export function ethernet(dst: Uint8Array, src: Uint8Array, type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(14 + payload.length)
  frame.set(dst, 0)
  frame.set(src, 6)
  view(frame).setUint16(12, type)
  frame.set(payload, 14)
  return frame
}

// --- ARP --------------------------------------------------------------------

export interface Arp {
  op: number // 1 request, 2 reply
  senderMac: Uint8Array
  senderIp: number
  targetIp: number
}

export function parseArp(p: Uint8Array): Arp | undefined {
  if (p.length < 28) return undefined
  const v = view(p)
  if (v.getUint16(0) !== 1 || v.getUint16(2) !== ETHERTYPE_IPV4) return undefined // Ethernet / IPv4 only
  return { op: v.getUint16(6), senderMac: p.subarray(8, 14), senderIp: v.getUint32(14), targetIp: v.getUint32(24) }
}

export function arpReply(mac: Uint8Array, ipAddr: number, toMac: Uint8Array, toIp: number): Uint8Array {
  const p = new Uint8Array(28)
  const v = view(p)
  v.setUint16(0, 1) // Ethernet
  v.setUint16(2, ETHERTYPE_IPV4)
  p[4] = 6
  p[5] = 4
  v.setUint16(6, 2) // reply
  p.set(mac, 8)
  v.setUint32(14, ipAddr)
  p.set(toMac, 18)
  v.setUint32(24, toIp)
  return p
}

// --- IPv4 -------------------------------------------------------------------

export interface Ipv4 {
  src: number
  dst: number
  proto: number
  payload: Uint8Array
}

/** Parse an IPv4 packet; fragments and malformed packets yield undefined. */
export function parseIpv4(p: Uint8Array): Ipv4 | undefined {
  if (p.length < 20 || p[0]! >> 4 !== 4) return undefined
  const v = view(p)
  const headerLength = (p[0]! & 0x0f) * 4
  const total = v.getUint16(2)
  if (total < headerLength || total > p.length) return undefined
  if (v.getUint16(6) & 0x3fff) return undefined // MF set or a fragment offset: not supported
  return { src: v.getUint32(12), dst: v.getUint32(16), proto: p[9]!, payload: p.subarray(headerLength, total) }
}

let nextId = 0
export function ipv4(src: number, dst: number, proto: number, payload: Uint8Array): Uint8Array {
  const p = new Uint8Array(20 + payload.length)
  const v = view(p)
  p[0] = 0x45 // version 4, 5-word header
  v.setUint16(2, p.length)
  v.setUint16(4, nextId++ & 0xffff)
  v.setUint16(6, 0x4000) // don't fragment
  p[8] = 64 // TTL
  p[9] = proto
  v.setUint32(12, src)
  v.setUint32(16, dst)
  v.setUint16(10, checksum(p.subarray(0, 20)))
  p.set(payload, 20)
  return p
}

// --- ICMP -------------------------------------------------------------------

/** Turn an ICMP echo request into its reply (same id, sequence and data), or undefined. */
export function icmpEchoReply(request: Uint8Array): Uint8Array | undefined {
  if (request.length < 8 || request[0] !== 8) return undefined
  const reply = request.slice()
  reply[0] = 0 // echo reply
  reply[2] = reply[3] = 0
  view(reply).setUint16(2, checksum(reply))
  return reply
}

// --- UDP --------------------------------------------------------------------

export interface Udp {
  srcPort: number
  dstPort: number
  data: Uint8Array
}

export function parseUdp(p: Uint8Array): Udp | undefined {
  if (p.length < 8) return undefined
  const v = view(p)
  const length = v.getUint16(4)
  if (length < 8 || length > p.length) return undefined
  return { srcPort: v.getUint16(0), dstPort: v.getUint16(2), data: p.subarray(8, length) }
}

/** A complete IPv4 packet carrying a UDP datagram. */
export function udp(src: number, srcPort: number, dst: number, dstPort: number, data: Uint8Array): Uint8Array {
  const d = new Uint8Array(8 + data.length)
  const v = view(d)
  v.setUint16(0, srcPort)
  v.setUint16(2, dstPort)
  v.setUint16(4, d.length)
  d.set(data, 8)
  const sum = checksum(d, pseudoHeader(src, dst, PROTO_UDP, d.length))
  v.setUint16(6, sum === 0 ? 0xffff : sum)
  return ipv4(src, dst, PROTO_UDP, d)
}

// --- TCP --------------------------------------------------------------------

export interface Tcp {
  srcPort: number
  dstPort: number
  seq: number
  ack: number
  flags: number
  window: number
  /** Maximum segment size option (SYN segments). */
  mss?: number
  data: Uint8Array
}

export function parseTcp(p: Uint8Array): Tcp | undefined {
  if (p.length < 20) return undefined
  const v = view(p)
  const headerLength = (p[12]! >> 4) * 4
  if (headerLength < 20 || headerLength > p.length) return undefined
  let mss: number | undefined
  for (let i = 20; i < headerLength; ) {
    const kind = p[i]!
    if (kind === 0) break // end of options
    if (kind === 1) {
      i++ // no-op
      continue
    }
    const len = p[i + 1] ?? 0
    if (len < 2) break
    if (kind === 2 && len === 4) mss = v.getUint16(i + 2)
    i += len
  }
  return {
    srcPort: v.getUint16(0),
    dstPort: v.getUint16(2),
    seq: v.getUint32(4),
    ack: v.getUint32(8),
    flags: p[13]! & 0x3f,
    window: v.getUint16(14),
    mss,
    data: p.subarray(headerLength),
  }
}

/** A complete IPv4 packet carrying a TCP segment. */
export function tcp(src: number, dst: number, s: Tcp): Uint8Array {
  const headerLength = s.mss === undefined ? 20 : 24
  const d = new Uint8Array(headerLength + s.data.length)
  const v = view(d)
  v.setUint16(0, s.srcPort)
  v.setUint16(2, s.dstPort)
  v.setUint32(4, s.seq >>> 0)
  v.setUint32(8, s.ack >>> 0)
  d[12] = (headerLength / 4) << 4
  d[13] = s.flags
  v.setUint16(14, s.window)
  if (s.mss !== undefined) {
    d[20] = 2 // MSS option
    d[21] = 4
    v.setUint16(22, s.mss)
  }
  d.set(s.data, headerLength)
  v.setUint16(16, checksum(d, pseudoHeader(src, dst, PROTO_TCP, d.length)))
  return ipv4(src, dst, PROTO_TCP, d)
}

/** Sequence-number arithmetic (mod 2^32). */
export const seqAdd = (a: number, b: number) => (a + b) >>> 0
export const seqDiff = (a: number, b: number) => ((a - b) | 0) // a - b, as a signed distance
