import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const gccThere = (() => {
  try {
    execFileSync('riscv64-elf-gcc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * The packages (packages/*) as their users get them: packed (npm pack, which
 * builds them), installed into a project of their own from the tarballs,
 * and used from there: the hart's run() and its example, a C program built
 * with its C runtime, and the relay through npm exec (as npx runs it).
 */
describe('the packages, packed and installed', () => {
  let dir: string
  let tarballs: { hart: string; relay: string }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pico-risc-v-packages-'))
    const pack = (pkg: string) => {
      const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: join(root, 'packages', pkg), encoding: 'utf8' })
      return join(dir, out.trim().split('\n').at(-1)!)
    }
    tarballs = { hart: pack('hart'), relay: pack('relay') }
    const project = join(dir, 'project')
    execFileSync('mkdir', ['-p', project])
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'uses-pico-risc-v', private: true, type: 'module' }))
    execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', tarballs.hart, tarballs.relay], { cwd: project })
  }, 300_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const project = () => join(dir, 'project')
  const node = (script: string, input?: string) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: project(), encoding: 'utf8', input })

  it('ships the hart: its compiled code and core, its C runtime, its example (built), no tests', () => {
    const files = execFileSync('tar', ['-tzf', tarballs.hart], { encoding: 'utf8' }).split('\n')
    for (const file of ['dist/index.js', 'dist/index.d.ts', 'build/hart.wasm', 'c/crt0.S', 'c/pico.ld', 'c/pico.h', 'examples/hello/hello.elf', 'examples/hello/hello.c', 'README.md']) {
      expect(files).toContain(`package/${file}`)
    }
    expect(files.filter(file => file.endsWith('.test.ts'))).toEqual([])
    expect(readdirSync(join(project(), 'node_modules/@padcom'))).toEqual(['pico-risc-v-hart', 'pico-risc-v-relay'])
  })

  it('runs a program with run(): its exit code, its output as written (captured), its input', () => {
    const out = node(`
      import { readFileSync } from 'node:fs'
      import { captureUart, run } from '@padcom/pico-risc-v-hart'
      const pieces = []
      const uart = captureUart({ onText: text => pieces.push(text), input: 'Ada\\r' })
      const elf = readFileSync('node_modules/@padcom/pico-risc-v-hart/examples/hello/hello.elf')
      const result = await run(elf, { uart })
      console.log(JSON.stringify({ ...result, pieces: pieces.length }))
    `)
    const result = JSON.parse(out) as { reason: string; exitCode: number; output: string; pieces: number }
    expect(result).toMatchObject({ reason: 'exit', exitCode: 3 })
    expect(result.output).toContain('Nice to meet you, Ada!')
    expect(result.pieces).toBe(result.output.length) // (a character at a time)
  })

  it("runs its examples as they are: the console's (typed input) and the captured one", () => {
    const examples = 'node_modules/@padcom/pico-risc-v-hart/examples/hello'
    const typed = execFileSync(process.execPath, [`${examples}/run.mjs`], { cwd: project(), encoding: 'utf8', input: 'Bob\n' })
    expect(typed).toContain('Nice to meet you, Bob!')
    expect(typed).toContain('exited with code 3')
    const captured = execFileSync(process.execPath, [`${examples}/capture.mjs`, 'Claude'], { cwd: project(), encoding: 'utf8' })
    expect(captured).toContain('Nice to meet you, Claude!')
    expect(captured).toContain('[exit code 6;')
  })

  it.skipIf(!gccThere)('builds a C program with its C runtime (c/), which runs', () => {
    const c = 'node_modules/@padcom/pico-risc-v-hart/c'
    writeFileSync(join(project(), 'sum.c'), '#include "pico.h"\nint main(void) { unsigned long s = 0; for (int i = 1; i <= 100; i++) s += i; pico_putu(s); pico_putc(10); return 7; }\n')
    execFileSync(
      'riscv64-elf-gcc',
      ['-march=rv64imac', '-mabi=lp64', '-mcmodel=medany', '-O2', '-ffreestanding', '-nostdlib', '-nostartfiles', '-I', c, '-T', `${c}/pico.ld`, `${c}/crt0.S`, 'sum.c', '-o', 'sum.elf'],
      { cwd: project() },
    )
    const out = node(`
      import { readFileSync } from 'node:fs'
      import { captureUart, run } from '@padcom/pico-risc-v-hart'
      const { exitCode, output } = await run(readFileSync('sum.elf'), { uart: captureUart() })
      console.log(JSON.stringify({ exitCode, output }))
    `)
    expect(JSON.parse(out)).toEqual({ exitCode: 7, output: '5050\n' })
  })

  it('runs the relay with npm exec (npx), from its tarball: a WebSocket relay on the port it says', async () => {
    let relay: ChildProcess | undefined
    try {
      // (npx @padcom/pico-risc-v-relay is npm exec --package=@padcom/pico-risc-v-relay -- pico-risc-v-relay.)
      relay = spawn('npm', ['exec', '--yes', `--package=${tarballs.relay}`, '--', 'pico-risc-v-relay', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
      const port = await new Promise<string>((resolve, reject) => {
        let out = ''
        relay!.stdout!.on('data', (chunk: Buffer) => {
          out += chunk
          const found = /\[relay\] ws:\/\/localhost:(\d+) for pages from localhost, https:\/\/padcom\.github\.io/.exec(out)
          if (found) resolve(found[1]!)
        })
        relay!.on('exit', code => reject(new Error(`the relay exited (${code}): ${out}`)))
      })
      // A client that isn't a page (no Origin): it may connect.
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = () => reject(new Error('the relay refused the WebSocket'))
      })
      socket.close()
    } finally {
      relay?.kill()
    }
  }, 120_000)
})
