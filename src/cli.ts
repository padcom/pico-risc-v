#!/usr/bin/env node
/**
 * Interactive runner: boots a flat binary image (Linux `Image` or a bare-metal
 * program) and connects the emulated terminal to this process's stdin/stdout.
 *
 *   node dist/cli.js [--memory <MiB>] [--harts <n>] [--kernel <file> [--initrd <file>]] [--disk <file> [--snapshot]]
 *                    [--net [--forward <host port>:<guest port>]...] [--bootargs <string>]
 *                    [--display] [--vnc <port>] [--virtual-clock] <image>
 *
 * The machine has RV64GC CPUs: one, or --harts of them (up to 8; each takes
 * about 115 MB for its caches), each running on a thread of its own (with
 * --virtual-clock they take turns on one).
 *
 * With --kernel, <image> is firmware (OpenSBI's fw_dynamic.bin), and <file>
 * the next boot stage: a bootloader (U-Boot) or a Linux kernel. It is loaded
 * 2 MiB into RAM, as on QEMU's virt machine, and the firmware told to enter
 * it there in S-mode. --initrd adds an initramfs for that kernel.
 *
 * --disk attaches a raw disk image file as a virtio block device (/dev/vda);
 * the guest's writes go to the file. With --snapshot they are kept in memory
 * instead and discarded on exit, leaving the file untouched.
 *
 * --net plugs a virtio network card (eth0) into a user-mode NAT: the guest
 * gets 10.0.2.15 by DHCP, can make outgoing TCP/UDP connections and use DNS;
 * 10.0.2.2 is this host's localhost. --forward 2222:22 (repeatable) lets
 * connections in: one to this host's localhost:2222 reaches the guest's
 * port 22 (e.g. ssh -p 2222 root@localhost).
 *
 * --display gives the machine a screen (1024×768), with a keyboard and a
 * mouse, and a sound card, and opens a window that shows it and takes the
 * keys and the mouse (closing it quits), and plays its sound. It takes the optional package @kmamal/sdl (SDL, which
 * npm installs where it can). --vnc <port> shows the screen to VNC viewers
 * on this machine too (or instead, without --display): macOS's Screen
 * Sharing (vnc://localhost:5900 with --vnc 5900; any password), TigerVNC...
 *
 * Press Ctrl-A then X to quit (Ctrl-A Ctrl-A sends a literal Ctrl-A).
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { type BlockStorage, SnapshotStorage } from './block-storage.js'
import { openWindow } from './display-window.js'
import { FileStorage } from './file-storage.js'
import { Machine } from './machine.js'
import { openSpeaker } from './speaker.js'
import { UserNetwork } from '@padcom/pico-risc-v-relay'
import { VncServer } from './vnc-server.js'

/** Instructions per scheduling slice; small enough to keep input responsive. */
const SLICE = 200_000
const CTRL_A = 0x01
/** Where the next boot stage goes: after the firmware, where U-Boot expects it (2 MiB, also Linux's alignment). */
const KERNEL_OFFSET = 0x200000

function usage(): never {
  console.error(
    'usage: risc-emulator [--memory <MiB>] [--harts <n>] [--kernel <file> [--initrd <file>]] [--disk <file> [--snapshot]] [--net [--forward <host port>:<guest port>]...] [--bootargs <string>] [--display] [--vnc <port>] [--virtual-clock] <image>',
  )
  process.exit(2)
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        memory: { type: 'string', default: '64' },
        harts: { type: 'string', default: '1' },
        kernel: { type: 'string' },
        initrd: { type: 'string' },
        disk: { type: 'string' },
        snapshot: { type: 'boolean', default: false },
        net: { type: 'boolean', default: false },
        forward: { type: 'string', multiple: true, default: [] },
        bootargs: { type: 'string' },
        display: { type: 'boolean', default: false },
        vnc: { type: 'string' },
        'virtual-clock': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch {
    usage()
  }
})()
if (values.help || positionals.length !== 1) usage()

const ramSize = Number(values.memory) * 1024 * 1024
if (!Number.isInteger(ramSize) || ramSize <= 0) usage()
const harts = Number(values.harts)
if (!Number.isInteger(harts) || harts < 1 || harts > 8) usage()
const threaded = harts > 1 && !values['virtual-clock']

let pending: number[] = []
const flush = () => {
  if (pending.length) process.stdout.write(Uint8Array.from(pending))
  pending = []
}

const diskFile = values.disk ? new FileStorage(values.disk, { readOnly: values.snapshot }) : undefined
const disk: BlockStorage | undefined = diskFile && values.snapshot ? new SnapshotStorage(diskFile) : diskFile

const forwards = values.forward.map(spec => {
  const [host, guest, extra] = spec.split(':').map(Number)
  const port = (n: number | undefined) => n !== undefined && Number.isInteger(n) && n > 0 && n < 65536
  return port(host) && port(guest) && extra === undefined ? { host: host!, guest: guest! } : usage()
})
if (forwards.length && !values.net) usage()
if (values.initrd && !values.kernel) usage()
const vncPort = values.vnc === undefined ? undefined : Number(values.vnc)
if (vncPort !== undefined && (!Number.isInteger(vncPort) || vncPort < 0 || vncPort > 65535)) usage()

const network = values.net ? new UserNetwork() : undefined
for (const { host, guest } of forwards) {
  // A port in use (say, by another emulator) is no reason not to run.
  await network!.forward(host, guest).then(
    () => process.stdin.isTTY && process.stderr.write(`[risc-emulator] localhost:${host} is forwarded to the guest's port ${guest}\n`),
    (e: Error) => process.stderr.write(`[risc-emulator] can't forward localhost:${host} to the guest's port ${guest}: ${e.message}\n`),
  )
}

const machine = new Machine({
  ramSize,
  harts,
  disk,
  network,
  bootargs: values.bootargs,
  display: values.display || vncPort !== undefined ? { width: 1024, height: 768 } : undefined,
  sound: values.display,
  clock: values['virtual-clock'] ? 'virtual' : 'realtime',
  output: byte => {
    // (Threads run on their own: flush soon, rather than after a slice.)
    if (pending.push(byte) === 1 && threaded) setImmediate(flush)
  },
})
machine.boot(
  readFileSync(positionals[0]!),
  values.kernel
    ? {
        load: [{ offset: KERNEL_OFFSET, data: readFileSync(values.kernel) }],
        next: { offset: KERNEL_OFFSET },
        initrd: values.initrd ? readFileSync(values.initrd) : undefined,
      }
    : {},
)

const display = machine.screen && machine
if (display && vncPort !== undefined) {
  // (Can't listen there, say another emulator does: no VNC, but run.)
  await new VncServer(display).listen(vncPort).then(
    port => process.stderr.write(`[risc-emulator] the screen: vnc://localhost:${port} (VNC; any password)\n`),
    (e: Error) => process.stderr.write(`[risc-emulator] can't show the screen on localhost:${vncPort}: ${e.message}\n`),
  )
}
if (display && values.display) {
  // (No window, say without the package or a desktop to open it on: run anyway.)
  await openWindow(display, 'risc-emulator', () => quit(0, '[risc-emulator] the window was closed')).catch((e: Error) =>
    process.stderr.write(`[risc-emulator] can't open a window for the screen (${e.message}); --vnc <port> shows it to VNC viewers\n`),
  )
}
if (machine.sound) {
  await openSpeaker(machine.sound).catch((e: Error) => process.stderr.write(`[risc-emulator] no sound (${e.message})\n`))
}

function quit(code: number, message?: string): never {
  flush()
  diskFile?.close()
  network?.close()
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  if (message) process.stderr.write(`\n${message}\n`)
  process.exit(code)
}

// The terminal's size, and changes to it (for the guest's console).
if (process.stdout.isTTY) {
  const resize = () => machine.resize(process.stdout.columns, process.stdout.rows)
  resize()
  process.stdout.on('resize', resize)
}

// Keyboard → terminal, with a QEMU-style Ctrl-A escape.
let escaped = false
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stderr.write('[risc-emulator] Ctrl-A X to quit\n')
}
process.stdin.on('data', (chunk: Buffer) => {
  const bytes: number[] = []
  for (const b of chunk) {
    if (escaped) {
      escaped = false
      if (b === 0x78 || b === 0x58) quit(0, '[risc-emulator] terminated') // x / X
      if (b === CTRL_A) bytes.push(CTRL_A)
    } else if (b === CTRL_A && process.stdin.isTTY) {
      escaped = true
    } else {
      bytes.push(b)
    }
  }
  machine.type(bytes)
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const yieldToEvents = () => new Promise(resolve => setImmediate(resolve))

for (;;) {
  const result = threaded ? await machine.runThreaded() : machine.run(SLICE)
  flush()
  switch (result) {
    case 'poweroff':
      quit(0)
    case 'reboot':
      machine.reboot()
      break
    case 'breakpoint':
      quit(1, `[risc-emulator] EBREAK at pc=0x${machine.cpu.pc.toString(16)}`)
    case 'idle':
      // Sleeping in WFI: wait for the timer (input is polled by the guest on timer ticks).
      await sleep(Math.min(machine.microsUntilTimer() / 1000, 10))
      break
    case 'limit':
      await yieldToEvents()
      break
  }
}
