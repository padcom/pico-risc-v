import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
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
 * service worker adds them), no Range requests (the disk in chunks), no
 * network but through a relay on this machine (npm run relay). Needs
 * Debian's images (npm run debian:build).
 */
describe.skipIf(!existsSync(chromium.executablePath()) || !existsSync(join(root, 'images/debian/pristine.raw')))(
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
    }, 600_000)
    afterAll(() => {
      server?.close()
      relay?.kill()
    })

    /** What the page's machine printed; waiting for `text` in it (after `from`). */
    const session = (page: Page) => {
      const output = () => page.evaluate(() => (window as unknown as { emulatorOutput?: string }).emulatorOutput ?? '').catch(() => '')
      const until = async (text: string, from = 0) => {
        const deadline = Date.now() + 400_000
        while (!(await output()).includes(text, from) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
        expect((await output()).slice(from)).toContain(text)
      }
      // root, on the console (hvc0: the serial port has none, its prompt
      // would be mixed up with this one); the keys go to the terminal once
      // it's shown.
      const login = async () => {
        await until('debian login: ')
        if (await page.isVisible('#show-terminal')) await page.click('#show-terminal')
        const from = (await output()).length
        await page.keyboard.type('root\n')
        await until('root@debian:~# ', from)
      }
      return { output, until, login }
    }

    it('boots Debian, from the disk in chunks, to its console and its desktop, which follows the size of the page, on 4 harts, isolated by the service worker, with a network through the relay', { timeout: 900_000 }, async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.goto(`${url}?relay=${relayUrl}`)
        const { output, until, login } = session(page)
        await until('debian login: ')
        expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
        expect(await page.evaluate(() => document.getElementById('status')!.textContent)).toBe('running on 4 harts')
        expect(await page.evaluate(() => document.getElementById('network')!.textContent)).toBe(`network: through ${relayUrl}`)

        // The page shows the screen first; the status bar's buttons switch.
        const shown = () =>
          page.evaluate(() => ({
            screen: !document.getElementById('screen-view')!.hidden,
            terminal: !document.getElementById('terminal')!.hidden,
            pressed: document.getElementById('show-screen')!.getAttribute('aria-pressed'),
          }))
        expect(await shown()).toEqual({ screen: true, terminal: false, pressed: 'true' })
        await login()
        expect(await shown()).toEqual({ screen: false, terminal: true, pressed: 'false' })
        // The address from the relay's NAT, by DHCP.
        const from = (await output()).length
        await page.keyboard.type('ip -4 addr show eth0 | grep -o "inet [0-9./]*"\n')
        await until('inet 10.0.2.15/24', from)
        await page.click('#show-screen')
        expect(await shown()).toEqual({ screen: true, terminal: false, pressed: 'true' })

        // The mouse lands where it's clicked, though the screen is scaled to the
        // page: a right-click on the desktop (2/5 of the way across, 1/4 down),
        // and Xfce's menu is right there, in the canvas (white, to the click's
        // lower right); Escape closes it.
        // (The screen's size: the page's room for it, once X is on the GPU.)
        const canvas = () => page.evaluate(() => [document.querySelector<HTMLCanvasElement>('#screen')!.width, document.querySelector<HTMLCanvasElement>('#screen')!.height])
        const where = async () => {
          const box = (await page.locator('#screen').boundingBox())!
          const [width, height] = await canvas()
          const area = fit(width!, height!, box.width, box.height)
          return { x: box.x + area.x + 0.4 * area.width, y: box.y + area.y + 0.25 * area.height }
        }
        const menu = () =>
          page.evaluate(() => {
            const screen = document.querySelector<HTMLCanvasElement>('#screen')!
            const [x, y] = [Math.round(0.4 * screen.width), Math.round(0.25 * screen.height)]
            // (Most of it: an item is highlighted, in blue.)
            const pixels = screen.getContext('2d')!.getImageData(x + 10, y + 10, 180, 110).data
            let white = 0
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 0xe0 && pixels[i + 1]! > 0xe0 && pixels[i + 2]! > 0xe0) white++
            return white > 180 * 110 * 0.5
          })
        let opened = false
        for (let i = 0, deadline = Date.now() + 400_000; !opened && Date.now() < deadline; i++) {
          // (Until X and Xfce are up: again and again, a pixel apart, as Linux
          // passes on a position only when it changes, and X only listens
          // once it's up.)
          const at = await where()
          await page.mouse.move(at.x + (i % 2), at.y + (i % 2))
          await page.mouse.click(at.x + (i % 2), at.y + (i % 2), { button: 'right' })
          await page.waitForTimeout(2000)
          opened = await menu()
        }
        expect(opened).toBe(true)
        await page.keyboard.press('Escape')
        for (const deadline = Date.now() + 60_000; (await menu()) && Date.now() < deadline; ) await page.waitForTimeout(500)
        expect(await menu()).toBe(false)

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
        for (const deadline = Date.now() + 120_000; !fitted && Date.now() < deadline; await page.waitForTimeout(500)) {
          const { screen, room } = await sizes()
          fitted = screen[0] === room[0] && screen[1] === room[1]
        }
        expect(await sizes()).toMatchObject({ screen: (await sizes()).room })
      } finally {
        await browser.close()
      }
    })

    it('keeps the disk across reloads (in IndexedDB), until asked to start over', { timeout: 900_000 }, async () => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        page.on('dialog', dialog => void dialog.accept()) // "Start over …?"
        const { output, until, login } = session(page)
        const type = async (text: string, expected: string) => {
          const from = (await output()).length
          await page.keyboard.type(text)
          await until(expected, from)
        }
        const disk = () => page.evaluate(() => document.getElementById('disk')!.textContent)
        // (No screen: no desktop to start, the terminal only. Reloads keep it so.)
        await page.goto(`${url}?display=0`)
        await login()
        expect(await disk()).toBe('disk: changes kept in this browser · start over')
        await type('echo "kept-$((6*7))" > /root/note.txt; sync; echo synced-$((0+1))\n', 'synced-1\r\n')
        await new Promise(resolve => setTimeout(resolve, 3000)) // (saved within 2 s)

        await page.reload()
        await login()
        await type('cat /root/note.txt\n', 'kept-42\r\n')

        // Start over: confirmed, it reloads.
        await Promise.all([page.waitForEvent('framenavigated'), page.click('#disk a')])
        await login()
        await type('ls /root/note.txt; echo listed-$((0+1))\n', 'listed-1\r\n')
        expect(await output()).toContain('No such file')
      } finally {
        await browser.close()
      }
    })
  },
)
