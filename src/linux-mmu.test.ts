import { createSocket } from 'node:dgram'
import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LinuxSession } from '../test/linux-session.js'
import { type BlockStorage, SnapshotStorage } from './block-storage.js'
import { FileStorage } from './file-storage.js'
import { UserNetwork, type UserNetworkOptions } from './net/user-network.js'

const IMAGES = new URL('../images/linux-mmu/', import.meta.url)
const FIRMWARE = new URL('fw_dynamic.bin', IMAGES)
const KERNEL = new URL('Image', IMAGES)
const ROOTFS = new URL('rootfs.ext4', IMAGES)
const BOOTARGS = 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw'

/**
 * Boots the regular (MMU) Linux image built by `npm run linux:build`: OpenSBI
 * in M-mode, the kernel in S-mode with Sv32 paging, glibc user space in U-mode,
 * root filesystem on a virtio disk (a copy of rootfs.ext4, so the image itself
 * stays pristine), eth0 on the user-mode network.
 */
describe.skipIf(![FIRMWARE, KERNEL, ROOTFS].every(existsSync))('Linux with MMU (OpenSBI + Sv32, virtio disk)', () => {
  // (describe bodies run even when skipped, so file work goes in hooks)
  let dir: string
  let disk: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'risc-linux-'))
    disk = join(dir, 'rootfs.ext4')
    copyFileSync(ROOTFS, disk, constants.COPYFILE_FICLONE) // instant on APFS/btrfs, else a copy
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function boot(storage: BlockStorage, network = new UserNetwork()) {
    const s = new LinuxSession(
      [readFileSync(FIRMWARE), { load: [{ offset: 0x400000, data: readFileSync(KERNEL) }], next: { offset: 0x400000 } }],
      { ramSize: 256 * 1024 * 1024, bootargs: BOOTARGS, disk: storage, network },
    )
    s.waitFor('login: ', 3_000_000_000)
    s.type('root\n')
    s.waitFor('# ')
    return s
  }

  it('boots from the disk, runs programs including Midnight Commander, keeps what it wrote', { timeout: 600_000 }, () => {
    const file = new FileStorage(disk)
    const s = boot(file)
    expect(s.screen).toContain('OpenSBI')
    expect(s.screen).toMatch(/virtio_blk virtio\d+: \[vda\]/)
    expect(s.screen).toMatch(/EXT4-fs \(vda\): mounted filesystem/)

    s.type('grep -E "^(isa|mmu)" /proc/cpuinfo; echo "done-$((40+2))"\n')
    s.waitFor('done-42')
    expect(s.screen).toMatch(/mmu\s*:\s*sv32/)

    s.type('hello from-mmu\n')
    s.waitFor('argv[1] = from-mmu')
    expect(s.screen).toMatch(/Hello from Linux \S+ on riscv32!/)

    // Midnight Commander: wait for its menu bar, then quit with F10.
    s.type('mc\n')
    s.waitFor('Command', 2_000_000_000)
    s.type('\x1b[21~')
    s.waitFor('# ', 2_000_000_000)

    s.type('echo "persisted-$((6*7))" > /root/note.txt; sync; echo "synced-$((1+1))"\n')
    s.waitFor('synced-2')
    s.type('exit\n')
    expect(s.runToPowerOff()).toBe('poweroff')
    file.close()
  })

  it('sees the earlier write after a reboot; --snapshot writes never reach the image', { timeout: 600_000 }, () => {
    const file = new FileStorage(disk, { readOnly: true })
    const s = boot(new SnapshotStorage(file))
    s.type('cat /root/note.txt\n')
    s.waitFor('persisted-42')

    const marker = `snapshot-only-${Date.now()}`
    s.type(`echo ${marker} > /root/snap.txt; sync; cat /root/snap.txt\n`)
    s.waitFor(marker + '\r\n') // the command's output, not its echo
    s.type('exit\n')
    expect(s.runToPowerOff()).toBe('poweroff')
    file.close()

    const image = readFileSync(disk)
    expect(image.includes('persisted-42')).toBe(true)
    expect(image.includes(marker)).toBe(false)
  })

  it('talks to the outside world: DHCP, ping, HTTP (wget and curl), DNS, and knows the date', { timeout: 600_000 }, async () => {
    // "The outside world": an HTTP server and a DNS server on this host.
    const http = createServer((_, res) => res.end('hello from the host\n'))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const httpPort = (http.address() as AddressInfo).port
    const dns = createSocket('udp4')
    dns.on('message', (query, from) => dns.send(answerA(query, [10, 0, 2, 2]), from.port, from.address))
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))
    const options: UserNetworkOptions = { dnsServer: `127.0.0.1:${dns.address().port}` }

    const file = new FileStorage(disk, { readOnly: true })
    const network = new UserNetwork(options)
    try {
      const s = boot(new SnapshotStorage(file), network)
      s.type('ip -4 addr show eth0; ping -c 1 10.0.2.2; echo "done-$((1+1))"\n')
      await s.waitForAsync('done-2')
      expect(s.screen).toContain('inet 10.0.2.15/24')
      expect(s.screen).toMatch(/1 packets transmitted, 1 packets received/)

      s.type(`wget -q -O - http://10.0.2.2:${httpPort}/\n`)
      await s.waitForAsync('hello from the host')

      // The date comes from the emulator's RTC (HTTPS certificate checks need it).
      s.type(`echo "year=$(date -u +%Y)"; curl --version | grep -o https | head -1; curl -s -w "curl:%{http_code}\\n" http://10.0.2.2:${httpPort}/\n`)
      await s.waitForAsync('curl:200')
      expect(s.screen).toContain(`year=${new Date().getUTCFullYear()}`)
      expect(s.screen).toMatch(/^https\r$/m)

      s.type(`nslookup example.test; wget -q -O - http://example.test:${httpPort}/ | tr a-z A-Z\n`)
      await s.waitForAsync('HELLO FROM THE HOST')
      expect(s.screen).toMatch(/Name:\s+example\.test\s+Address:\s+10\.0\.2\.2/)

      s.type('exit\n')
      expect(s.runToPowerOff()).toBe('poweroff')
    } finally {
      network.close()
      file.close()
      http.close()
      dns.close()
    }
  })
})

/** A DNS response giving every A query in `query` the address `addr`. */
function answerA(query: Buffer, addr: number[]): Buffer {
  let end = 12
  while (query[end] !== 0) end += query[end]! + 1 // QNAME labels
  end += 5 // zero label, QTYPE, QCLASS
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...addr]) // name → offset 12, A, IN, TTL 60
  const response = Buffer.concat([query.subarray(0, end), answer])
  response.writeUInt16BE(0x8180, 2) // response, recursion available, no error
  response.writeUInt16BE(1, 6) // ANCOUNT
  response.writeUInt16BE(0, 8) // NSCOUNT
  response.writeUInt16BE(0, 10) // ARCOUNT
  return response
}
