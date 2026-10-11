#!/usr/bin/env node
/**
 * Interactive runner: boots a flat binary image (Linux `Image` or a bare-metal
 * program) and connects the emulated terminal to this process's stdin/stdout.
 *
 *   node dist/cli.js [--memory <MiB>] [--kernel <file>] [--bootargs <string>] [--virtual-clock] <image>
 *
 * With --kernel, <image> is firmware (OpenSBI's fw_dynamic.bin): the kernel is
 * loaded 4 MiB into RAM (RV32 kernels must be 4 MiB aligned) and the firmware
 * told to enter it there in S-mode.
 *
 * Press Ctrl-A then X to quit (Ctrl-A Ctrl-A sends a literal Ctrl-A).
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Machine } from './machine.js'

/** Instructions per scheduling slice; small enough to keep input responsive. */
const SLICE = 200_000
const CTRL_A = 0x01
/** Where the kernel goes: right after the firmware, 4 MiB aligned as RV32 Linux requires. */
const KERNEL_OFFSET = 0x400000

function usage(): never {
  console.error('usage: risc-emulator [--memory <MiB>] [--kernel <file>] [--bootargs <string>] [--virtual-clock] <image>')
  process.exit(2)
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        memory: { type: 'string', default: '64' },
        kernel: { type: 'string' },
        bootargs: { type: 'string' },
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

let pending: number[] = []
const flush = () => {
  if (pending.length) process.stdout.write(Uint8Array.from(pending))
  pending = []
}

const machine = new Machine({
  ramSize,
  bootargs: values.bootargs,
  clock: values['virtual-clock'] ? 'virtual' : 'realtime',
  output: byte => pending.push(byte),
})
machine.boot(
  readFileSync(positionals[0]!),
  values.kernel
    ? { load: [{ offset: KERNEL_OFFSET, data: readFileSync(values.kernel) }], next: { offset: KERNEL_OFFSET } }
    : {},
)

function quit(code: number, message?: string): never {
  flush()
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  if (message) process.stderr.write(`\n${message}\n`)
  process.exit(code)
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
  machine.terminal.type(bytes)
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const yieldToEvents = () => new Promise(resolve => setImmediate(resolve))

for (;;) {
  const result = machine.run(SLICE)
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
