import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
