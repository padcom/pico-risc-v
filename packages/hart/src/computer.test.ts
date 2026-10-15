import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { asm as a, toBytes } from './asm.js'
import { Computer, MemoryMap, run } from './computer.js'
import { both, captureUart } from './uart.js'

const [T0, T1, T2, T3, A0, A1] = [5, 6, 7, 28, 10, 11]
const MIE = 0x304

/** Load a 32-bit constant (lui + addi, the addi's sign taken into account). */
const li = (rd: number, value: number) => {
  const low = ((value & 0xfff) << 20) >> 20
  return [a.lui(rd, (value - low) >>> 0), a.addi(rd, rd, low)]
}
const exit = (code: number) => [...li(A0, code), ...exitCode()]
/** Exit with the code in a0. */
const exitCode = () => [
  ...li(T2, 0x3333),
  a.slli(A1, A0, 16),
  a.or(A1, A1, T2),
  a.bne(A0, 0, 12),
  ...li(A1, 0x5555),
  ...li(T3, MemoryMap.SYSCON),
  a.sw(A1, T3, 0),
  a.jal(0, 0), // (until the syscon stops it)
]
/** Write `text` to the UART (its UTF-8 bytes). */
const print = (text: string) => [...li(T0, MemoryMap.UART), ...[...new TextEncoder().encode(text)].flatMap(byte => [a.addi(T1, 0, byte), a.sb(T1, T0, 0)])]
const program = (...words: number[][]) => toBytes(words.flat())

describe('run(): a bare-metal program on the computer', () => {
  it('ends with the exit code the program gives the syscon: 0, or any other', async () => {
    expect(await run(program(exit(0)), { uart: captureUart() })).toMatchObject({ reason: 'exit', exitCode: 0 })
    expect(await run(program(exit(42)), { uart: captureUart() })).toMatchObject({ reason: 'exit', exitCode: 42 })
  })

  it('passes what the program writes to the UART on as it is written, and has all of it at the end', async () => {
    const seen: string[] = []
    const uart = captureUart({ onText: text => seen.push(text) })
    const result = await run(program(print('Hi, π!\n'), exit(0)), { uart })
    // (A character at a time: π, two bytes in UTF-8, once both are there.)
    expect(seen).toEqual([...'Hi, π!\n'])
    expect(uart.text).toBe('Hi, π!\n')
    expect(result.output).toBe('Hi, π!\n')
    expect([...uart.bytes]).toEqual([...new TextEncoder().encode('Hi, π!\n')])
  })

  it('gives the program input: what it reads from the UART (here: a character back, in upper case, and as its exit code)', async () => {
    const answer = [
      ...li(T0, MemoryMap.UART),
      a.lbu(T1, T0, 5), // line status...
      a.andi(T1, T1, 1), // ...data ready?
      a.beq(T1, 0, -8),
      a.lbu(A0, T0, 0),
      a.addi(A0, A0, -32),
      a.sb(A0, T0, 0),
      ...exitCode(),
    ]
    // Given before it starts, and while it runs.
    expect(await run(program(answer), { uart: captureUart({ input: 'q' }) })).toMatchObject({ exitCode: 'Q'.charCodeAt(0), output: 'Q' })
    const uart = captureUart()
    const running = run(program(answer), { uart })
    await new Promise(resolve => setTimeout(resolve, 20))
    uart.send('x')
    expect(await running).toMatchObject({ reason: 'exit', exitCode: 'X'.charCodeAt(0), output: 'X' })
  })

  it('stops after maxInstructions, or when its signal says so', async () => {
    const forever = program([a.jal(0, 0)])
    expect(await run(forever, { uart: captureUart(), maxInstructions: 5000 })).toMatchObject({ reason: 'limit', exitCode: undefined, instructions: 5000 })
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 30)
    expect(await run(forever, { uart: captureUart(), signal: stop.signal })).toMatchObject({ reason: 'aborted' })
  })

  it('sleeps in WFI until the timer (mtime is real time, in µs), rather than spinning', async () => {
    const wait = [
      ...li(T0, MemoryMap.CLINT + 0xc000),
      a.ld(T1, T0, -8), // mtime (0xbff8)
      ...li(T2, 30_000),
      a.add(T1, T1, T2), // 30 ms from now
      ...li(T0, MemoryMap.CLINT + 0x4000),
      a.sd(T1, T0, 0), // mtimecmp
      a.addi(T1, 0, 0x80),
      a.csrrs(0, MIE, T1), // mie.MTIE (mstatus.MIE stays off: WFI just wakes)
      a.wfi(),
      ...exit(7),
    ]
    const start = performance.now()
    const result = await run(program(wait), { uart: captureUart() })
    expect(result).toMatchObject({ reason: 'exit', exitCode: 7 })
    expect(performance.now() - start).toBeGreaterThanOrEqual(29)
    expect(result.instructions).toBeLessThan(100)
  })

  it('writes to the console by default, and to several UARTs with both()', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await run(program(print('ok\n'), exit(0)))
      expect(Buffer.concat(write.mock.calls.map(([chunk]) => Buffer.from(chunk as Uint8Array))).toString()).toBe('ok\n')
    } finally {
      write.mockRestore()
    }
    const [one, two] = [captureUart(), captureUart()]
    await run(program(print('twice'), exit(0)), { uart: both(one, two) })
    expect([one.text, two.text]).toEqual(['twice', 'twice'])
  })

  it('runs ELF executables: the hello example (C, with c/crt0.S), a conversation through the UART', async () => {
    const elf = new URL('../examples/hello/hello.elf', import.meta.url)
    if (!existsSync(elf)) return // (no RISC-V GCC here: test/build-examples.ts)
    const uart = captureUart({ input: 'Ada\r' })
    const result = await run(readFileSync(elf), { uart })
    expect(result).toMatchObject({ reason: 'exit', exitCode: 3 })
    expect(result.output).toBe(
      "Hello from RISC-V! What's your name? Ada\r\nNice to meet you, Ada! Your name has 3 letters: that's my exit code.\n",
    )
  })

  it('loads a program again, from the start: a Computer runs one program after another', async () => {
    const computer = new Computer({ uart: captureUart() })
    computer.load(program(print('a'), exit(1)))
    expect(await computer.run()).toMatchObject({ exitCode: 1, output: 'a' })
    computer.load(program(print('b'), exit(2)))
    expect(await computer.run()).toMatchObject({ exitCode: 2, output: 'b' })
  })
})
