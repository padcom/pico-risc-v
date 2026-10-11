import { createSocket } from 'node:dgram'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { answerA } from '../test/dns.js'
import { LinuxSession } from '../test/linux-session.js'
import { SnapshotStorage } from './block-storage.js'
import { FileStorage } from './file-storage.js'
import { UserNetwork } from './net/user-network.js'

const RV64 = new URL('../images/linux-rv64/', import.meta.url)
const FIRMWARE = new URL('fw_dynamic.bin', RV64)
const KERNEL = new URL('Image', RV64)
/** Built by linux/debian/build.sh (npm run debian:build). */
const ROOTFS = new URL('../images/debian/rootfs.ext4', import.meta.url)

/**
 * Debian 13 (trixie, riscv64), unmodified from Debian's archive, on the rv64
 * flavor's kernel and OpenSBI: systemd boots it, systemd-networkd and
 * systemd-resolved bring up the network. The disk is a snapshot, so the image
 * stays pristine.
 */
describe.skipIf(![FIRMWARE, KERNEL, ROOTFS].every(existsSync))('Debian 13 riscv64 (systemd)', () => {
  it('boots with systemd with nothing failed; network, DNS and HTTP through systemd-resolved; dpkg', { timeout: 900_000 }, async () => {
    const http = createServer((_, res) => res.end('hello from the host\n'))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const httpPort = (http.address() as AddressInfo).port
    const dns = createSocket('udp4')
    dns.on('message', (query, from) => dns.send(answerA(query, [10, 0, 2, 2]), from.port, from.address))
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))

    const file = new FileStorage(fileURLToPath(ROOTFS), { readOnly: true })
    const network = new UserNetwork({ dnsServer: `127.0.0.1:${dns.address().port}` })
    try {
      const s = new LinuxSession(
        [readFileSync(FIRMWARE), { load: [{ offset: 0x400000, data: readFileSync(KERNEL) }], next: { offset: 0x400000 } }],
        {
          xlen: 64,
          ramSize: 512 * 1024 * 1024,
          bootargs: 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
          disk: new SnapshotStorage(file),
          network,
          // Virtual time at about the emulator's real speed: at the default 10
          // MIPS systemd's service timeouts expire before a service is up.
          instructionsPerMicrosecond: 100,
        },
      )
      await s.waitForAsync('login: ', 20_000_000_000, 600_000)
      expect(s.screen).toContain('Debian GNU/Linux 13')
      s.type('root\n')
      await s.waitForAsync('# ')

      // Every unit started: "running", not "degraded".
      s.type('systemctl is-system-running --wait; systemctl --failed --no-legend --no-pager; echo "done-$((1+1))"\n')
      await s.waitForAsync('done-2', 2_000_000_000)
      expect(s.screen).toMatch(/^running\r$/m)

      s.type('. /etc/os-release; echo "$VERSION_CODENAME-$(dpkg --print-architecture)"; dpkg-query -W apt systemd | wc -l\n')
      await s.waitForAsync('trixie-riscv64')
      await s.waitForAsync('2\r\n')

      // Address by DHCP (networkd); names through resolved, to the emulator's DNS.
      s.type('ip -4 addr show eth0; resolvectl dns eth0; echo "done-$((2+2))"\n')
      await s.waitForAsync('done-4')
      const plain = s.screen.replace(/\x1b\[[0-9;]*m/g, '') // without Debian's colors
      expect(plain).toContain('inet 10.0.2.15/24')
      expect(plain).toMatch(/eth0\): 10\.0\.2\.3/)
      s.type(`curl -s http://example.test:${httpPort}/ | tr a-z A-Z\n`)
      await s.waitForAsync('HELLO FROM THE HOST', 2_000_000_000)

      s.type('poweroff\n')
      expect(s.runToPowerOff(10_000_000_000)).toBe('poweroff')
    } finally {
      network.close()
      file.close()
      http.close()
      dns.close()
    }
  })
})
