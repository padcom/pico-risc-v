import { createSocket } from 'node:dgram'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROADCAST_MAC,
  checksum,
  ethernet,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ip,
  ipv4,
  parseArp,
  parseEthernet,
  parseIpv4,
  parseTcp,
  parseUdp,
  PROTO_ICMP,
  PROTO_TCP,
  PROTO_UDP,
  type Tcp,
  tcp,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  udp,
} from './net/packet.js'
import { DNS_IP, GATEWAY_IP, GUEST_IP, UserNetwork } from './net/user-network.js'
import { VirtioNet } from './virtio-net.js'

const GUEST_MAC = Uint8Array.of(0x52, 0x54, 0x00, 0x12, 0x34, 0x56)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const bytes = (s: string) => new TextEncoder().encode(s)

/** Check what the guest receives would pass Linux's checks: IP header and TCP/UDP checksums. */
function expectValidChecksums(frame: Uint8Array) {
  const eth = parseEthernet(frame)!
  if (eth.type !== ETHERTYPE_IPV4) return
  const header = eth.payload.subarray(0, 20)
  expect(checksum(header)).toBe(0)
  const p = parseIpv4(eth.payload)!
  if (p.proto === PROTO_TCP || p.proto === PROTO_UDP) {
    const pseudo = (p.src >>> 16) + (p.src & 0xffff) + (p.dst >>> 16) + (p.dst & 0xffff) + p.proto + p.payload.length
    expect(checksum(p.payload, pseudo)).toBe(0)
  }
}

/** The network as seen from the guest: send frames in, collect frames out. */
function guest(options?: ConstructorParameters<typeof UserNetwork>[0]) {
  const net = new UserNetwork(options)
  const inbox: Uint8Array[] = []
  net.attach(frame => {
    expectValidChecksums(frame)
    inbox.push(frame)
  })
  const sendIp = (packet: Uint8Array) => net.send(ethernet(Uint8Array.of(0x52, 0x55, 10, 0, 2, 2), GUEST_MAC, ETHERTYPE_IPV4, packet))
  /** Wait (in real time) until a frame matching `pick` arrives; returns what pick returned. */
  async function expectFrame<T>(pick: (frame: Uint8Array) => T | undefined, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      for (let i = 0; i < inbox.length; i++) {
        const hit = pick(inbox[i]!)
        if (hit !== undefined) {
          inbox.splice(i, 1)
          return hit
        }
      }
      if (Date.now() > deadline) throw new Error('expected frame did not arrive')
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
  const tcpFrom = (port: number) => (frame: Uint8Array) => {
    const p = parseIpv4(parseEthernet(frame)!.payload)
    if (p?.proto !== PROTO_TCP) return undefined
    const s = parseTcp(p.payload)!
    return s.srcPort === port ? s : undefined
  }
  return { net, inbox, sendIp, expectFrame, tcpFrom }
}

describe('user-mode network (NAT)', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => cleanup.splice(0).forEach(fn => fn()))

  it('answers ARP for the gateway and DNS addresses only', () => {
    const { net, inbox } = guest()
    const request = (target: number) => {
      const arp = new Uint8Array(28)
      const v = new DataView(arp.buffer)
      v.setUint16(0, 1)
      v.setUint16(2, ETHERTYPE_IPV4)
      arp[4] = 6
      arp[5] = 4
      v.setUint16(6, 1)
      arp.set(GUEST_MAC, 8)
      v.setUint32(14, GUEST_IP)
      v.setUint32(24, target)
      net.send(ethernet(BROADCAST_MAC, GUEST_MAC, ETHERTYPE_ARP, arp))
    }
    request(GATEWAY_IP)
    request(ip('10.0.2.99'))
    request(DNS_IP)
    expect(inbox).toHaveLength(2)
    const replies = inbox.map(f => parseArp(parseEthernet(f)!.payload)!)
    expect(replies.map(r => [r.op, r.senderIp])).toEqual([[2, GATEWAY_IP], [2, DNS_IP]])
    expect([...parseEthernet(inbox[0]!)!.dst]).toEqual([...GUEST_MAC])
  })

  it('answers pings to the gateway', () => {
    const { sendIp, inbox } = guest()
    const echo = Uint8Array.of(8, 0, 0, 0, 0x12, 0x34, 0, 1, ...bytes('ping!'))
    new DataView(echo.buffer).setUint16(2, checksum(echo))
    sendIp(ipv4(GUEST_IP, GATEWAY_IP, PROTO_ICMP, echo))
    const reply = parseIpv4(parseEthernet(inbox[0]!)!.payload)!
    expect([reply.src, reply.dst, reply.payload[0]]).toEqual([GATEWAY_IP, GUEST_IP, 0])
    expect(text(reply.payload.subarray(8))).toBe('ping!')
    expect(checksum(reply.payload)).toBe(0)
  })

  it('pings other hosts through the host (here: a fake ping)', async () => {
    const asked: string[] = []
    const { sendIp, expectFrame, net } = guest({
      ping: async host => {
        asked.push(host)
        await new Promise(resolve => setTimeout(resolve, 5))
        return host === '192.0.2.1' // answers; 192.0.2.2 doesn't
      },
    })
    const echo = (dst: string, seq: number) => {
      const e = Uint8Array.of(8, 0, 0, 0, 0x12, 0x34, 0, seq, ...bytes('hi'))
      new DataView(e.buffer).setUint16(2, checksum(e))
      sendIp(ipv4(GUEST_IP, ip(dst), PROTO_ICMP, e))
    }
    echo('192.0.2.2', 1)
    echo('192.0.2.1', 2)
    expect(net.busy).toBe(true)
    const reply = await expectFrame(f => {
      const p = parseIpv4(parseEthernet(f)!.payload)
      return p?.proto === PROTO_ICMP ? p : undefined
    })
    expect([reply.src, reply.payload[0], reply.payload[7]]).toEqual([ip('192.0.2.1'), 0, 2]) // reply to seq 2 only
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(net.busy).toBe(false)
    expect(asked.sort()).toEqual(['192.0.2.1', '192.0.2.2'])
  })

  it('hands out 10.0.2.15 by DHCP with gateway and DNS', () => {
    const { net, inbox } = guest()
    const dhcp = (type: number) => {
      const m = new Uint8Array(300)
      const v = new DataView(m.buffer)
      m[0] = 1
      m[1] = 1
      m[2] = 6
      v.setUint32(4, 0xcafe)
      m.set(GUEST_MAC, 28)
      v.setUint32(236, 0x63825363)
      m.set([53, 1, type, 255], 240)
      net.send(ethernet(BROADCAST_MAC, GUEST_MAC, ETHERTYPE_IPV4, udp(0, 68, 0xffffffff, 67, m)))
      const reply = parseUdp(parseIpv4(parseEthernet(inbox.shift()!)!.payload)!.payload)!
      const r = new DataView(reply.data.buffer, reply.data.byteOffset)
      const options = new Map<number, number[]>()
      for (let i = 240; reply.data[i] !== 255; i += 2 + reply.data[i + 1]!) {
        options.set(reply.data[i]!, [...reply.data.subarray(i + 2, i + 2 + reply.data[i + 1]!)])
      }
      return { ports: [reply.srcPort, reply.dstPort], xid: r.getUint32(4), yiaddr: r.getUint32(16), options }
    }
    const offer = dhcp(1)
    expect(offer.ports).toEqual([67, 68])
    expect([offer.xid, offer.yiaddr]).toEqual([0xcafe, GUEST_IP])
    expect(offer.options.get(53)).toEqual([2]) // OFFER
    expect(offer.options.get(3)).toEqual([10, 0, 2, 2]) // router
    expect(offer.options.get(6)).toEqual([10, 0, 2, 3]) // DNS
    expect(dhcp(3).options.get(53)).toEqual([5]) // REQUEST → ACK
  })

  async function server(handle: (data: Buffer, reply: (s: string) => void, end: () => void) => void) {
    const s: Server = createServer(sock => sock.on('data', (d: Buffer) => handle(d, r => sock.write(r), () => sock.end())))
    await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => s.close())
    return (s.address() as AddressInfo).port
  }

  it('proxies a TCP connection to the host: handshake, data both ways, close', async () => {
    const port = await server((data, reply, end) => {
      reply(text(data).toUpperCase())
      end()
    })
    const { net, sendIp, expectFrame, tcpFrom } = guest()
    const seg = (s: Partial<Tcp>) =>
      sendIp(tcp(GUEST_IP, GATEWAY_IP, { srcPort: 40000, dstPort: port, seq: 0, ack: 0, flags: TCP_ACK, window: 65535, data: new Uint8Array(0), ...s }))

    seg({ seq: 1000, flags: TCP_SYN, mss: 1460 })
    const synAck = await expectFrame(tcpFrom(port))
    expect(synAck.flags).toBe(TCP_SYN | TCP_ACK)
    expect(synAck.ack).toBe(1001)
    expect(net.busy).toBe(true)

    let theirs = (synAck.seq + 1) >>> 0
    seg({ seq: 1001, ack: theirs })
    seg({ seq: 1001, ack: theirs, flags: TCP_ACK | TCP_PSH, data: bytes('hello') })
    expect((await expectFrame(tcpFrom(port))).ack).toBe(1006) // our data acknowledged

    const data = await expectFrame(f => {
      const s = tcpFrom(port)(f)
      return s?.data.length ? s : undefined
    })
    expect(text(data.data)).toBe('HELLO')
    theirs = (theirs + data.data.length) >>> 0
    seg({ seq: 1006, ack: theirs })

    const fin = await expectFrame(f => {
      const s = tcpFrom(port)(f)
      return s && s.flags & TCP_FIN ? s : undefined
    })
    expect(fin.seq).toBe(theirs)
    seg({ seq: 1006, ack: (theirs + 1) >>> 0, flags: TCP_FIN | TCP_ACK })
    expect((await expectFrame(tcpFrom(port))).ack).toBe(1007)
    expect(net.busy).toBe(false) // both sides closed: connection forgotten
  })

  it('resets a TCP connection the host refuses', async () => {
    // A port that was just in use and is now closed: nothing listens there.
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const closedPort = (probe.address() as AddressInfo).port
    await new Promise(resolve => probe.close(resolve))
    const { sendIp, expectFrame, tcpFrom } = guest()
    sendIp(tcp(GUEST_IP, GATEWAY_IP, { srcPort: 40001, dstPort: closedPort, seq: 5, ack: 0, flags: TCP_SYN, window: 65535, data: new Uint8Array(0) }))
    const rst = await expectFrame(tcpFrom(closedPort))
    expect(rst.flags & TCP_RST).toBe(TCP_RST)
    expect(rst.ack).toBe(6)
  })

  it('relays UDP to the host and DNS to the configured resolver', async () => {
    const echo = createSocket('udp4')
    echo.on('message', (msg, from) => echo.send(Buffer.from(`echo:${msg}`), from.port, from.address))
    await new Promise<void>(resolve => echo.bind(0, '127.0.0.1', resolve))
    cleanup.push(() => echo.close())
    const echoPort = echo.address().port

    const { net, sendIp, expectFrame } = guest({ dnsServer: `127.0.0.1:${echoPort}` })
    cleanup.push(() => net.close())
    const udpTo = (port: number) => (frame: Uint8Array) => {
      const p = parseIpv4(parseEthernet(frame)!.payload)
      const d = p?.proto === PROTO_UDP ? parseUdp(p.payload) : undefined
      return d?.dstPort === port ? { from: p!.src, fromPort: d.srcPort, data: text(d.data) } : undefined
    }

    sendIp(udp(GUEST_IP, 5000, GATEWAY_IP, echoPort, bytes('hi')))
    expect(net.busy).toBe(true) // awaiting the reply
    expect(await expectFrame(udpTo(5000))).toEqual({ from: GATEWAY_IP, fromPort: echoPort, data: 'echo:hi' })

    sendIp(udp(GUEST_IP, 5001, DNS_IP, 53, bytes('query')))
    expect(await expectFrame(udpTo(5001))).toEqual({ from: DNS_IP, fromPort: 53, data: 'echo:query' })
  })
})

describe('virtio network card', () => {
  /** Driver side: queue 0 receives, queue 1 transmits; buffers in a fake guest RAM. */
  function card() {
    const ram = new Uint8Array(1 << 20)
    const view = new DataView(ram.buffer)
    const sent: Uint8Array[] = []
    let deliver: (frame: Uint8Array) => void = () => {}
    let irq = false
    const nic = new VirtioNet(
      { send: f => sent.push(f), attach: r => (deliver = r) },
      GUEST_MAC,
      (addr, length) => ram.subarray(addr, addr + length),
      high => (irq = high),
    )
    const queues = [0x1000, 0x4000].map((base, index) => {
      nic.write32(0x030, index)
      nic.write32(0x038, 8)
      nic.write32(0x080, base)
      nic.write32(0x090, base + 0x1000)
      nic.write32(0x0a0, base + 0x2000)
      nic.write32(0x044, 1)
      let availIdx = 0
      return {
        /** Offer one buffer (writable for RX, readable for TX) at `addr`. */
        offer(addr: number, length: number, writable: boolean) {
          view.setUint32(base, addr, true)
          view.setUint32(base + 8, length, true)
          view.setUint16(base + 12, writable ? 2 : 0, true)
          view.setUint16(base + 0x1000 + 4 + 2 * (availIdx % 8), 0, true)
          view.setUint16(base + 0x1000 + 2, ++availIdx, true)
          nic.write32(0x050, index)
        },
        usedLength: () => view.getUint32(base + 0x2000 + 4 + 4, true),
        usedIdx: () => view.getUint16(base + 0x2000 + 2, true),
      }
    })
    return { nic, ram, sent, deliver: (f: Uint8Array) => deliver(f), irq: () => irq, rx: queues[0]!, tx: queues[1]! }
  }

  it('reports its MAC address and link up', () => {
    const { nic } = card()
    expect([nic.read8(0x100), nic.read8(0x105), nic.read16(0x106)]).toEqual([0x52, 0x56, 1])
    expect(nic.read32(0x008)).toBe(1) // network card
  })

  it('transmits frames without the virtio-net header', () => {
    const { ram, sent, tx, irq } = card()
    ram.set([...new Uint8Array(12), ...bytes('frame!')], 0x10000)
    tx.offer(0x10000, 18, false)
    expect(sent.map(text)).toEqual(['frame!'])
    expect(irq()).toBe(true)
  })

  it('holds received frames until the guest offers buffers', () => {
    const { ram, rx, deliver, irq } = card()
    deliver(bytes('incoming'))
    expect(rx.usedIdx()).toBe(0)
    rx.offer(0x20000, 1526, true)
    expect(rx.usedIdx()).toBe(1)
    expect(rx.usedLength()).toBe(12 + 8)
    expect(ram[0x20000 + 10]).toBe(1) // num_buffers
    expect(text(ram.subarray(0x20000 + 12, 0x20000 + 20))).toBe('incoming')
    expect(irq()).toBe(true)
  })
})
