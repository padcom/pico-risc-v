import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

/** The page (web/, src/browser.ts) as npm run web serves it, in headless Chromium (npx playwright install chromium). */
describe.skipIf(!existsSync(chromium.executablePath()))('in a browser (npm run web, Chromium)', () => {
  let server: ChildProcess
  let url: string

  beforeAll(async () => {
    server = spawn(process.execPath, ['scripts/web.ts', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
    url = await new Promise<string>((resolve, reject) => {
      let out = ''
      server.stdout!.on('data', (chunk: Buffer) => {
        out += chunk
        const found = /http:\/\/localhost:\d+\//.exec(out)
        if (found) resolve(found[0])
      })
      server.on('exit', code => reject(new Error(`npm run web exited (${code}): ${out}`)))
    })
  }, 300_000)
  afterAll(() => server?.kill())

  it('smp.c: 4 harts on Web Workers update shared counters atomically', { timeout: 120_000 }, async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const errors: Error[] = []
      page.on('pageerror', error => errors.push(error))
      await page.goto(`${url}?image=examples/build/smp.bin&harts=4`)
      await page.waitForSelector('body[data-result]', { timeout: 60_000 })
      expect(errors).toEqual([])
      expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
      expect(await page.evaluate(() => document.body.dataset.result)).toBe('poweroff')
      expect(await page.evaluate(() => (window as unknown as { emulatorOutput: string }).emulatorOutput)).toBe(
        'harts 4\namoadd 80000\nlr/sc 80000\nlocked 80000\n',
      )
    } finally {
      await browser.close()
    }
  })
})

/**
 * npm run site's site/ (made into build/test-site/), from a plain web server,
 * as GitHub Pages serves it: no cross-origin isolation headers (the page's
 * service worker adds them), no Range requests, no network. Needs Alpine's
 * images (npm run alpine:build).
 */
describe.skipIf(!existsSync(chromium.executablePath()) || !existsSync(join(root, 'images/alpine/boot.json')))(
  'the static site (npm run site), in a browser (Chromium)',
  () => {
    let server: Server
    let url: string

    beforeAll(async () => {
      execFileSync(process.execPath, ['scripts/site.ts', '--out', 'build/test-site'], { cwd: root, stdio: 'ignore' })
      const site = join(root, 'build/test-site')
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }
      server = createServer((request, response) => {
        const path = join(site, decodeURIComponent(new URL(request.url!, 'http://localhost').pathname).replace(/\/$/, '/index.html'))
        if (!path.startsWith(site) || !existsSync(path)) return void response.writeHead(404).end()
        response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    }, 300_000)
    afterAll(() => server?.close())

    it('boots Alpine to its shell, on 4 harts, isolated by the service worker', { timeout: 120_000 }, async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(url)
        const output = () => page.evaluate(() => (window as unknown as { emulatorOutput?: string }).emulatorOutput ?? '').catch(() => '')
        const deadline = Date.now() + 90_000
        while (!(await output()).includes('alpine:~# ') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
        expect(await output()).toContain('Welcome to Alpine Linux, on risc-emulator')
        expect(await output()).toContain('alpine:~# ')
        expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
        expect(await page.evaluate(() => document.getElementById('status')!.textContent)).toBe('running on 4 harts')
      } finally {
        await browser.close()
      }
    })
  },
)
