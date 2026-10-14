import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fit } from './fit.js'

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
 * service worker adds them), no Range requests, no network but through a
 * relay on this machine (npm run relay). Needs Alpine's images (npm run
 * alpine:build).
 */
describe.skipIf(!existsSync(chromium.executablePath()) || !existsSync(join(root, 'images/alpine/boot.json')))(
  'the static site (npm run site), in a browser (Chromium)',
  () => {
    let server: Server
    let url: string
    let relay: ChildProcess
    let relayUrl: string

    beforeAll(async () => {
      execFileSync(process.execPath, ['scripts/site.ts', '--out', 'build/test-site'], { cwd: root, stdio: 'ignore' })
      relay = spawn(process.execPath, ['scripts/relay.ts', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
      relayUrl = await new Promise<string>((resolve, reject) => {
        let out = ''
        relay.stdout!.on('data', (chunk: Buffer) => {
          out += chunk
          const found = /ws:\/\/localhost:(\d+)/.exec(out)
          if (found) resolve(`ws://127.0.0.1:${found[1]}`)
        })
        relay.on('exit', code => reject(new Error(`npm run relay exited (${code}): ${out}`)))
      })
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
    afterAll(() => {
      server?.close()
      relay?.kill()
    })

    it('boots Alpine to its shell and its desktop, which follows the size of the page, on 4 harts, isolated by the service worker, with a network through the relay', { timeout: 240_000 }, async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${url}?relay=${relayUrl}`)
        const output = () => page.evaluate(() => (window as unknown as { emulatorOutput?: string }).emulatorOutput ?? '').catch(() => '')
        const until = async (text: string) => {
          const deadline = Date.now() + 90_000
          while (!(await output()).includes(text) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
        }
        await until('alpine:~# ')
        expect(await output()).toContain('Welcome to Alpine Linux, on risc-emulator')
        expect(await output()).toContain('alpine:~# ')
        expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
        expect(await page.evaluate(() => document.getElementById('status')!.textContent)).toBe('running on 4 harts')
        // The address from the relay's NAT, by DHCP.
        expect(await page.evaluate(() => document.getElementById('network')!.textContent)).toBe(`network: through ${relayUrl}`)

        // The page shows the screen first; the status bar's buttons switch.
        const shown = () =>
          page.evaluate(() => ({
            screen: !document.getElementById('screen-view')!.hidden,
            terminal: !document.getElementById('terminal')!.hidden,
            pressed: document.getElementById('show-screen')!.getAttribute('aria-pressed'),
          }))
        expect(await shown()).toEqual({ screen: true, terminal: false, pressed: 'true' })
        await page.click('#show-terminal')
        expect(await shown()).toEqual({ screen: false, terminal: true, pressed: 'false' })
        await page.click('#show-screen')
        expect(await shown()).toEqual({ screen: true, terminal: false, pressed: 'true' })

        // The mouse lands where it's clicked, though the screen is scaled to the
        // page: holding its button down on the desktop (3/4 of the way across
        // and down), twm's menu is right there, in the canvas (its title at the
        // pointer, its items below, on #eeeeee: ~/.twmrc).
        // (The screen's size: the page's room for it, once X is on the GPU.)
        const canvas = () => page.evaluate(() => [document.querySelector<HTMLCanvasElement>('#screen')!.width, document.querySelector<HTMLCanvasElement>('#screen')!.height])
        const where = async () => {
          const box = (await page.locator('#screen').boundingBox())!
          const [width, height] = await canvas()
          const area = fit(width!, height!, box.width, box.height)
          return { x: box.x + area.x + 0.75 * area.width, y: box.y + area.y + 0.75 * area.height }
        }
        const menu = () =>
          page.evaluate(() => {
            const screen = document.querySelector<HTMLCanvasElement>('#screen')!
            const [x, y] = [Math.round(0.75 * screen.width), Math.round(0.75 * screen.height)]
            const pixels = screen.getContext('2d')!.getImageData(x - 20, y + 30, 40, 60).data
            let items = 0
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 0xee && pixels[i + 1] === 0xee && pixels[i + 2] === 0xee) items++
            return items
          })
        let opened = false
        for (let i = 0, deadline = Date.now() + 90_000; !opened && Date.now() < deadline; i++) {
          // (Until X and twm are up: again and again, a pixel apart, as Linux
          // passes on a position only when it changes, and X only listens
          // once it's up.)
          const at = await where()
          await page.mouse.move(at.x + (i % 2), at.y + (i % 2))
          await page.mouse.down()
          await page.waitForTimeout(1500)
          opened = (await menu()) > 40 * 60 * 0.5
          await page.mouse.up()
        }
        expect(opened).toBe(true)

        // The screen follows the page's room for it: a smaller window, a smaller
        // screen (the width a multiple of 8, as Linux makes modes).
        const sizes = () =>
          page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('#screen')!
            const room = document.getElementById('screen-view')!
            return { screen: [canvas.width, canvas.height], room: [Math.floor(room.clientWidth / 8) * 8, room.clientHeight] }
          })
        await page.setViewportSize({ width: 900, height: 600 })
        let fitted = false
        for (const deadline = Date.now() + 60_000; !fitted && Date.now() < deadline; await page.waitForTimeout(500)) {
          const { screen, room } = await sizes()
          fitted = screen[0] === room[0] && screen[1] === room[1]
        }
        expect(await sizes()).toMatchObject({ screen: (await sizes()).room })

        // (The keys go to the terminal once it's shown.)
        await page.click('#show-terminal')
        await page.keyboard.type('ip -4 addr show eth0 | grep -o "inet [0-9./]*"\n')
        await until('inet 10.0.2.15/24')
        expect(await output()).toContain('inet 10.0.2.15/24')
      } finally {
        await browser.close()
      }
    })

    it('keeps the disk across reloads (in IndexedDB), until asked to start over', { timeout: 180_000 }, async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        page.on('dialog', dialog => void dialog.accept()) // "Start over …?"
        const output = () => page.evaluate(() => (window as unknown as { emulatorOutput?: string }).emulatorOutput ?? '').catch(() => '')
        const until = async (text: string) => {
          const deadline = Date.now() + 90_000
          while (!(await output()).includes(text) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
          expect(await output()).toContain(text)
        }
        const disk = () => page.evaluate(() => document.getElementById('disk')!.textContent)
        // (No screen: no desktop to start, the terminal only. Reloads keep it so.)
        await page.goto(`${url}?display=0`)
        await until('alpine:~# ')
        expect(await disk()).toBe('disk: changes kept in this browser · start over')
        await page.keyboard.type('echo "kept-$((6*7))" > /root/note.txt; sync; echo synced-$((0+1))\n')
        await until('synced-1\r\n')
        await new Promise(resolve => setTimeout(resolve, 3000)) // (saved within 2 s)

        await page.reload()
        await until('alpine:~# ')
        await page.keyboard.type('cat /root/note.txt\n')
        await until('kept-42\r\n')

        // Start over: confirmed, it reloads.
        await Promise.all([page.waitForEvent('framenavigated'), page.click('#disk a')])
        await until('alpine:~# ')
        await page.keyboard.type('ls /root/note.txt; echo listed-$((0+1))\n')
        await until('listed-1\r\n')
        expect(await output()).toContain('No such file')
      } finally {
        await browser.close()
      }
    })
  },
)
