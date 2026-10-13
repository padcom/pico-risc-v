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

/** Set up by linux/debian/build.sh (npm start runs it). */
const FIRMWARE = new URL('../images/debian/fw_dynamic.bin', import.meta.url)
const UBOOT = new URL('../images/debian/u-boot.bin', import.meta.url)
// The disk as built (not disk.raw, the one npm start boots, which you change).
const DISK = fileURLToPath(new URL('../images/debian/pristine.raw', import.meta.url))
/** Instructions to wait for any one thing at the shell (logging in alone takes over 1 billion). */
const BUDGET = 5_000_000_000

/**
 * Debian 13 (trixie, riscv64): Debian's cloud image, booted the way a RISC-V
 * board boots it, all of it Debian's: OpenSBI, U-Boot (UEFI), GRUB, Debian's
 * kernel and initrd, systemd. The disk is a snapshot over the image, so the
 * image stays pristine.
 */
describe.skipIf(![FIRMWARE, UBOOT, DISK].every(existsSync))('Debian 13 riscv64 cloud image', () => {
  it(
    'boots on 4 harts with nothing failed; CPUs, randomness, floating point, network (DHCP, ping, DNS, HTTP), date; keeps writes across a reboot',
    { timeout: 1_800_000 },
    async () => {
      // "The outside world": an HTTP server and a DNS server on this host.
      const http = createServer((_, res) => res.end('hello from the host\n'))
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
      const httpPort = (http.address() as AddressInfo).port
      const dns = createSocket('udp4')
      dns.on('message', (query, from) => dns.send(answerA(query, [10, 0, 2, 2]), from.port, from.address))
      await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))

      const imageModified = statSync(DISK).mtimeMs
      const file = new FileStorage(DISK, { readOnly: true })
      const network = new UserNetwork({ dnsServer: `127.0.0.1:${dns.address().port}` })
      try {
        const s = new LinuxSession(
          [readFileSync(FIRMWARE), { load: [{ offset: 0x200000, data: readFileSync(UBOOT) }], next: { offset: 0x200000 } }],
          {
            ramSize: 1024 * 1024 * 1024,
            harts: 4, // as npm start
            disk: new SnapshotStorage(file),
            network,
            // Virtual time at about the emulator's real speed: at the default 10
            // MIPS systemd's service timeouts expire before a service is up.
            instructionsPerMicrosecond: 100,
          },
        )
        const login = async () => {
          // The login on the virtio console (hvc0), the one typing goes to.
          // (Not the serial port's: the console's asks the terminal for its
          // cursor position first, and there's none here to answer.)
          await s.waitForAsync('debian hvc0\r\n\r\ndebian login: ', 60_000_000_000, 900_000)
          expect(s.screen).toContain('Debian GNU/Linux 13')
          s.type('root\n')
          await s.waitForAsync('# ', BUDGET, 600_000)
        }
        /** The screen without Debian's colors. */
        const plain = () => s.screen.replace(/\x1b\[[0-9;]*m/g, '')

        await login()
        expect(s.screen).toContain('U-Boot')

        // GRUB loaded Debian's kernel.
        s.type('cat /proc/cmdline\n')
        await s.waitForAsync('-riscv64 ', BUDGET, 600_000)
        expect(s.screen).toMatch(/BOOT_IMAGE=\/boot\/vmlinu[xz]-\S+-riscv64 /)

        // The root file system on the virtio disk, grown to the disk's size on the first boot.
        s.type('findmnt -no SOURCE /; df -B1G --output=size / | tail -1; echo "done-$((0+1))"\n')
        await s.waitForAsync('done-1', BUDGET, 600_000)
        expect(s.screen).toMatch(/^\/dev\/vda1\r$/m)
        expect(Number(s.screen.match(/^ *(\d+)\r\n(?=done-1)/m)?.[1])).toBeGreaterThan(5)

        // Every unit started: "running", not "degraded".
        s.type('systemctl is-system-running --wait; systemctl --failed --no-legend --no-pager; echo "done-$((1+1))"\n')
        await s.waitForAsync('done-2', BUDGET, 600_000)
        expect(s.screen).toMatch(/^running\r$/m)

        s.type('. /etc/os-release; echo "$VERSION_CODENAME-$(dpkg --print-architecture)"; dpkg-query -W apt systemd | wc -l\n')
        await s.waitForAsync('trixie-riscv64', BUDGET, 600_000)
        await s.waitForAsync('2\r\n', BUDGET, 600_000)

        // The CPUs as Linux sees them: 4, all online, RV64GC with Sv39 paging.
        s.type('echo "cpus-$(nproc)-$(grep -c ^processor /proc/cpuinfo)"; grep -E "^(isa|mmu)" /proc/cpuinfo | sort | uniq -c; echo "done-$((1+2))"\n')
        await s.waitForAsync('done-3', BUDGET, 600_000)
        expect(s.screen).toContain('cpus-4-4')
        expect(s.screen).toMatch(/4 isa\s*:\s*rv64imafdc/)
        expect(s.screen).toMatch(/4 mmu\s*:\s*sv39/)

        // Randomness is ready right away (seeded through the device tree):
        // /dev/random blocks until it is.
        s.type('echo "rng-$(head -c 16 /dev/random | wc -c)"\n')
        await s.waitForAsync('rng-16', BUDGET, 600_000)

        // Floating point in user space (hard-float ABI): awk computes in doubles.
        s.type(`awk 'BEGIN { printf "fp=%.12f\\n", 3 / 7 * 1.5 - 0.1 }'\n`)
        await s.waitForAsync('fp=0.542857142857', BUDGET, 600_000)

        // Address by DHCP (networkd); names through resolved, to the emulator's DNS.
        s.type('ip -4 addr show eth0; resolvectl dns eth0; ping -c 1 10.0.2.2; echo "done-$((2+2))"\n')
        await s.waitForAsync('done-4', BUDGET, 600_000)
        expect(plain()).toContain('inet 10.0.2.15/24')
        expect(plain()).toMatch(/eth0\): 10\.0\.2\.3/)
        expect(plain()).toMatch(/1 packets transmitted, 1 received/)
        s.type(`curl -s http://example.test:${httpPort}/ | tr a-z A-Z\n`)
        await s.waitForAsync('HELLO FROM THE HOST', BUDGET, 600_000)

        // The date comes from the emulator's RTC (HTTPS certificate checks need it).
        s.type('echo "year=$(date -u +%Y)"\n')
        await s.waitForAsync(`year=${new Date().getUTCFullYear()}`, BUDGET, 600_000)

        // A write survives a reboot (in the snapshot: the image file is untouched).
        s.type('echo "persisted-$((6*7))" > /root/note.txt; sync; reboot\n')
        expect(s.runToPowerOff(20_000_000_000)).toBe('reboot')
        s.machine.reboot()
        await login()
        s.type('cat /root/note.txt\n')
        await s.waitForAsync('persisted-42\r\n', BUDGET, 600_000)

        s.type('poweroff\n')
        expect(s.runToPowerOff(20_000_000_000)).toBe('poweroff')
      } finally {
        network.close()
        file.close()
        http.close()
        dns.close()
      }
      expect(statSync(DISK).mtimeMs).toBe(imageModified)
    },
  )
})
