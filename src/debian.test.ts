import { createSocket } from 'node:dgram'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { answerA } from '../test/dns.js'
import { LinuxSession } from '../test/linux-session.js'
import { SnapshotStorage } from './block-storage.js'
import { FileStorage } from './file-storage.js'
import { UserNetwork } from './net/user-network.js'

/** Built by linux/kernel/build.sh and linux/debian/build.sh (npm start builds both). */
const FIRMWARE = new URL('../images/kernel/fw_dynamic.bin', import.meta.url)
const KERNEL = new URL('../images/kernel/Image', import.meta.url)
const ROOTFS = fileURLToPath(new URL('../images/debian/rootfs.ext4', import.meta.url))

/**
 * Debian 13 (trixie, riscv64), unmodified from Debian's archive, on our kernel
 * and OpenSBI: systemd boots it, systemd-networkd and systemd-resolved bring
 * up the network. The disk is a snapshot over the image, so the image stays
 * pristine.
 */
describe.skipIf(![FIRMWARE, KERNEL, ROOTFS].every(existsSync))('Debian 13 riscv64 (systemd)', () => {
  it(
    'boots with nothing failed; CPU, randomness, floating point, network (DHCP, ping, DNS, HTTP), date; keeps writes across a reboot',
    { timeout: 900_000 },
    async () => {
      // "The outside world": an HTTP server and a DNS server on this host.
      const http = createServer((_, res) => res.end('hello from the host\n'))
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
      const httpPort = (http.address() as AddressInfo).port
      const dns = createSocket('udp4')
      dns.on('message', (query, from) => dns.send(answerA(query, [10, 0, 2, 2]), from.port, from.address))
      await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))

      const imageModified = statSync(ROOTFS).mtimeMs
      const file = new FileStorage(ROOTFS, { readOnly: true })
      const network = new UserNetwork({ dnsServer: `127.0.0.1:${dns.address().port}` })
      try {
        const s = new LinuxSession(
          [readFileSync(FIRMWARE), { load: [{ offset: 0x400000, data: readFileSync(KERNEL) }], next: { offset: 0x400000 } }],
          {
            ramSize: 512 * 1024 * 1024,
            bootargs: 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0 root=/dev/vda rw',
            disk: new SnapshotStorage(file),
            network,
            // Virtual time at about the emulator's real speed: at the default 10
            // MIPS systemd's service timeouts expire before a service is up.
            instructionsPerMicrosecond: 100,
          },
        )
        const login = async () => {
          await s.waitForAsync('login: ', 20_000_000_000, 600_000)
          expect(s.screen).toContain('Debian GNU/Linux 13')
          s.type('root\n')
          await s.waitForAsync('# ')
        }
        /** The screen without Debian's colors. */
        const plain = () => s.screen.replace(/\x1b\[[0-9;]*m/g, '')

        await login()
        expect(s.screen).toMatch(/virtio_blk virtio\d+: \[vda\]/)
        expect(s.screen).toMatch(/EXT4-fs \(vda\): mounted filesystem/)

        // Every unit started: "running", not "degraded".
        s.type('systemctl is-system-running --wait; systemctl --failed --no-legend --no-pager; echo "done-$((1+1))"\n')
        await s.waitForAsync('done-2', 2_000_000_000)
        expect(s.screen).toMatch(/^running\r$/m)

        s.type('. /etc/os-release; echo "$VERSION_CODENAME-$(dpkg --print-architecture)"; dpkg-query -W apt systemd | wc -l\n')
        await s.waitForAsync('trixie-riscv64')
        await s.waitForAsync('2\r\n')

        // The CPU as Linux sees it: RV64GC with Sv39 paging.
        s.type('grep -E "^(isa|mmu)" /proc/cpuinfo; echo "done-$((1+2))"\n')
        await s.waitForAsync('done-3')
        expect(s.screen).toMatch(/isa\s*:\s*rv64imafdc/)
        expect(s.screen).toMatch(/mmu\s*:\s*sv39/)

        // Randomness is ready right away (seeded through the device tree):
        // /dev/random blocks until it is.
        s.type('echo "rng-$(head -c 16 /dev/random | wc -c)"\n')
        await s.waitForAsync('rng-16')

        // Floating point in user space (hard-float ABI): awk computes in doubles.
        s.type(`awk 'BEGIN { printf "fp=%.12f\\n", 3 / 7 * 1.5 - 0.1 }'\n`)
        await s.waitForAsync('fp=0.542857142857')

        // Address by DHCP (networkd); names through resolved, to the emulator's DNS.
        s.type('ip -4 addr show eth0; resolvectl dns eth0; ping -c 1 10.0.2.2; echo "done-$((2+2))"\n')
        await s.waitForAsync('done-4')
        expect(plain()).toContain('inet 10.0.2.15/24')
        expect(plain()).toMatch(/eth0\): 10\.0\.2\.3/)
        expect(plain()).toMatch(/1 packets transmitted, 1 received/)
        s.type(`curl -s http://example.test:${httpPort}/ | tr a-z A-Z\n`)
        await s.waitForAsync('HELLO FROM THE HOST', 2_000_000_000)

        // The date comes from the emulator's RTC (HTTPS certificate checks need it).
        s.type('echo "year=$(date -u +%Y)"\n')
        await s.waitForAsync(`year=${new Date().getUTCFullYear()}`)

        // A write survives a reboot (in the snapshot: the image file is untouched).
        s.type('echo "persisted-$((6*7))" > /root/note.txt; sync; reboot\n')
        expect(s.runToPowerOff(10_000_000_000)).toBe('reboot')
        s.machine.reboot()
        await login()
        s.type('cat /root/note.txt\n')
        await s.waitForAsync('persisted-42\r\n')

        s.type('poweroff\n')
        expect(s.runToPowerOff(10_000_000_000)).toBe('poweroff')
      } finally {
        network.close()
        file.close()
        http.close()
        dns.close()
      }
      expect(statSync(ROOTFS).mtimeMs).toBe(imageModified)
    },
  )
})
