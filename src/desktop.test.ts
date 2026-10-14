import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LinuxSession } from '../test/linux-session.js'
import { RfbClient } from '../test/rfb-client.js'
import { SnapshotStorage } from './block-storage.js'
import { FileStorage } from './file-storage.js'
import { Input } from './virtio-input.js'
import { VncServer } from './vnc-server.js'

const WIDTH = 1024
const HEIGHT = 768
/** Instructions to wait for any one thing at the shell, at most. */
const BUDGET = 5_000_000_000

/**
 * Run the machine until `done()` (it's on the screen, say), in at most BUDGET
 * more instructions, or a minute (when it idles, waiting for something, it
 * runs none).
 */
async function until(s: LinuxSession, what: string, done: () => boolean): Promise<void> {
  const end = s.machine.cpu.instret + BUDGET
  const deadline = Date.now() + 60_000
  while (!done()) {
    const result = s.machine.run(1_000_000)
    if (result !== 'limit' && result !== 'idle') throw new Error(`machine stopped (${result}) waiting for ${what}`)
    if (s.machine.cpu.instret > end || Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    // (When it idles: a moment for the world to do something.)
    await new Promise(resolve => (result === 'idle' ? setTimeout(resolve, 1) : setImmediate(resolve)))
  }
}

/** What's on the screen: RGBA. */
function pixels(s: LinuxSession): Uint8Array {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4)
  s.machine.screen!.draw(rgba)
  return rgba
}

/** How many of the pixels in rows `top` to `bottom` (excluded) aren't black. */
function lit(rgba: Uint8Array, top: number, bottom: number): number {
  let count = 0
  for (let i = top * WIDTH; i < bottom * WIDTH; i++) if (rgba[4 * i] || rgba[4 * i + 1] || rgba[4 * i + 2]) count++
  return count
}

const DEBIAN = new URL('../images/debian/', import.meta.url)
const DEBIAN_DISK = fileURLToPath(new URL('pristine.raw', DEBIAN))

/**
 * Debian with a screen, as a ?display page boots it (its build installs
 * Xfce: linux/debian/packages): U-Boot hands the screen on to Linux, which
 * logs root in on it (tty1) by itself and starts the desktop there.
 */
describe.skipIf(!['fw_dynamic.bin', 'u-boot.bin', 'pristine.raw'].every(f => existsSync(new URL(f, DEBIAN))))('Debian with a screen', () => {
  it(
    'has the screen (efifb), the keyboard and the mouse, and starts Xfce on them; a VNC viewer sees it and uses it',
    { timeout: 1_800_000 },
    async () => {
      const file = new FileStorage(DEBIAN_DISK, { readOnly: true })
      try {
        const s = new LinuxSession(
          [
            readFileSync(new URL('fw_dynamic.bin', DEBIAN)),
            { load: [{ offset: 0x200000, data: readFileSync(new URL('u-boot.bin', DEBIAN)) }], next: { offset: 0x200000 } },
          ],
          {
            ramSize: 1024 * 1024 * 1024,
            harts: 4,
            disk: new SnapshotStorage(file),
            instructionsPerMicrosecond: 100, // (see debian.test.ts)
            display: { width: WIDTH, height: HEIGHT },
          },
        )
        // The console's login (hvc0), the one typing goes to.
        await s.waitForAsync('debian hvc0\r\n\r\ndebian login: ', 60_000_000_000, 900_000)
        s.type('root\n')
        await s.waitForAsync('# ', BUDGET, 600_000)

        // The screen: U-Boot hands it on (UEFI), Linux draws on it (efifb),
        // x8r8g8b8 (red from bit 16, as Framebuffer.draw has it).
        s.type('cat /proc/fb; dmesg | grep -o "efifb: Truecolor: .*"; echo "done-$((0+1))"\n')
        await s.waitForAsync('done-1', BUDGET, 600_000)
        expect(s.screen).toMatch(/^0 EFI VGA\r$/m)
        expect(s.screen).toContain('efifb: Truecolor: size=8:8:8:8, shift=24:16:8:0')

        // The keyboard and the mouse (a tablet): what we send them, Linux's
        // programs read, as events (struct input_event: 24 bytes, the last 8
        // type, code, value). od waits for a key's press and release, and a
        // move and a click (on the desktop: nothing there).
        const events = (name: string) => `$(grep -A5 '"risc-emulator ${name}"' /proc/bus/input/devices | grep -o 'event[0-9]*')`
        s.type(
          `grep -A5 '"risc-emulator' /proc/bus/input/devices | grep -E '^[NH]:'; ` +
            `od -An -tu2 -w24 -N96 /dev/input/${events('keyboard')} >/tmp/keyboard & ` +
            `od -An -tu2 -w24 -N144 /dev/input/${events('tablet')} >/tmp/tablet & sleep 1; echo "done-$((1+1))"\n`,
        )
        await s.waitForAsync('done-2', BUDGET, 600_000)
        expect(s.screen).toMatch(/N: Name="risc-emulator keyboard"\r\nH: Handlers=sysrq kbd event\d/)
        expect(s.screen).toMatch(/N: Name="risc-emulator tablet"\r\nH: Handlers=mouse0 js0 event\d/)
        s.machine.keyboard!.send([Input.EV_KEY, 42, 1]) // KEY_LEFTSHIFT
        s.machine.keyboard!.send([Input.EV_KEY, 42, 0])
        s.machine.tablet!.send([Input.EV_ABS, Input.ABS_X, 16384], [Input.EV_ABS, Input.ABS_Y, 16384], [Input.EV_KEY, Input.BTN_LEFT, 1])
        s.machine.tablet!.send([Input.EV_KEY, Input.BTN_LEFT, 0])
        s.type(`wait; awk '{ print "event", $9, $10, $11 }' /tmp/keyboard /tmp/tablet; echo "done-$((1+2))"\n`)
        await s.waitForAsync('done-3', BUDGET, 600_000)
        expect(s.screen.match(/^event .*(?=\r$)/gm)).toEqual([
          ...['event 1 42 1', 'event 0 0 0', 'event 1 42 0', 'event 0 0 0'],
          ...['event 3 0 16384', 'event 3 1 16384', 'event 1 272 1', 'event 0 0 0', 'event 1 272 0', 'event 0 0 0'],
        ])

        // Xfce, on tty1 (root, logged in by itself): its window manager,
        // panel and desktop run, X has the keyboard and the mouse (libinput),
        // and the panel is on the screen, across the top.
        s.type(
          'until pgrep -x xfwm4 && pgrep -x xfce4-panel && pgrep -x xfdesktop; do sleep 1; done >/dev/null; ' +
            `who | grep -o '^root *tty1'; grep -o "Using input driver 'libinput' for 'risc-emulator [a-z]*'" /var/log/Xorg.0.log; echo "done-$((2+2))"\n`,
        )
        await s.waitForAsync('done-4', BUDGET, 600_000)
        expect(s.screen).toMatch(/^root +tty1\r$/m)
        expect(s.screen).toContain("Using input driver 'libinput' for 'risc-emulator keyboard'")
        expect(s.screen).toContain("Using input driver 'libinput' for 'risc-emulator tablet'")
        await until(s, 'the panel', () => lit(pixels(s), 0, 20) > (WIDTH * 20) / 2)
        // The wallpaper (an SVG: librsvg2-common draws it), not black.
        await until(s, 'the wallpaper', () => lit(pixels(s), 300, 500) > (WIDTH * 200) / 2)

        // A VNC viewer (npm start --display) gets the screen as it is, and
        // what it does gets to X: a right-click on the desktop opens Xfce's
        // menu there (white, to the click's lower right), Escape closes it.
        const vnc = new VncServer({ screen: s.machine.screen!, keyboard: s.machine.keyboard!, tablet: s.machine.tablet! })
        const viewer = await RfbClient.connect(await vnc.listen(0))
        try {
          const [all] = await viewer.update(false)
          const { pixels: screen } = s.machine.screen!
          expect(all!.data.equals(new Uint8Array(screen.buffer, screen.byteOffset, screen.byteLength))).toBe(true)
          const seen = new Uint32Array(all!.data.buffer, all!.data.byteOffset, WIDTH * HEIGHT).slice()
          /** Run the machine until `done()` with what the viewer sees, asking for updates as it goes. */
          let asking: Promise<void> | undefined
          const watch = (what: string, done: () => boolean) =>
            until(s, what, () => {
              asking ??= viewer.update(true).then(rects => {
                for (const { x, y, w, h, data } of rects) {
                  for (let row = 0; row < h; row++) seen.set(new Uint32Array(data.buffer, data.byteOffset + row * w * 4, w), (y + row) * WIDTH + x)
                }
                asking = undefined
              })
              return done()
            })
          const menu = () => (seen[500 * WIDTH + 750]! & 0xffffff) > 0xe0e0e0
          expect(menu()).toBe(false)
          viewer.pointer(0, 600, 400)
          viewer.pointer(4, 600, 400) // right button
          viewer.pointer(0, 600, 400)
          await watch("Xfce's menu", menu)
          viewer.key(0xff1b, true) // Escape
          viewer.key(0xff1b, false)
          await watch("Xfce's menu closing", () => !menu())
          // (An update still asked for won't come: closing the viewer ends it.)
          asking?.catch(() => {})
        } finally {
          viewer.close()
          vnc.close()
        }

        s.type('poweroff\n')
        expect(s.runToPowerOff(20_000_000_000)).toBe('poweroff')
      } finally {
        file.close()
      }
    },
  )
})

const ALPINE = new URL('../images/alpine/', import.meta.url)

/**
 * Alpine with a screen, as the static site boots it with ?display: a light
 * desktop (X, twm, xterm; linux/alpine/packages), started on the screen
 * (tty1) by itself.
 */
describe.skipIf(!existsSync(new URL('boot.json', ALPINE)))('Alpine with a screen', () => {
  it('starts X with twm and an xterm on it, with the keyboard and the mouse (evdev)', { timeout: 600_000 }, async () => {
    const config = JSON.parse(readFileSync(new URL('boot.json', ALPINE), 'utf8')) as { bootargs: string; memory: number }
    const file = new FileStorage(fileURLToPath(new URL('pristine.raw', ALPINE)), { readOnly: true })
    try {
      const s = new LinuxSession(
        [
          readFileSync(new URL('fw_dynamic.bin', ALPINE)),
          {
            load: [{ offset: 0x200000, data: readFileSync(new URL('Image', ALPINE)) }],
            next: { offset: 0x200000 },
            initrd: readFileSync(new URL('initramfs', ALPINE)),
          },
        ],
        {
          ramSize: config.memory * 1024 * 1024,
          harts: 4,
          disk: new SnapshotStorage(file),
          bootargs: config.bootargs,
          instructionsPerMicrosecond: 100,
          display: { width: WIDTH, height: HEIGHT },
        },
      )
      // The console (hvc0) logs in by itself.
      await s.waitForAsync(':~# ', 20_000_000_000, 600_000)

      s.type(
        'until pgrep -x twm && pgrep -x xterm; do sleep 1; done >/dev/null; ' +
          `grep -oE "evdev: (keyboard|tablet): Configuring as [a-z]+" /var/log/Xorg.0.log; echo "done-$((0+1))"\n`,
      )
      await s.waitForAsync('done-1', BUDGET, 600_000)
      expect(s.screen).toContain('evdev: keyboard: Configuring as keyboard')
      // (An absolute pointer with buttons, as evdev sees it.)
      expect(s.screen).toContain('evdev: tablet: Configuring as touchscreen')

      // On the screen: the xterm (white), under twm's title bar, in its
      // color (~/.twmrc: #5f87af), which is where it should be (the colors
      // in the right order, all the way).
      const window = (rgba: Uint8Array) => {
        const at = (x: number, y: number) => [...rgba.subarray(4 * (y * WIDTH + x), 4 * (y * WIDTH + x) + 3)]
        const title = Array.from({ length: 40 }, (_, y) => at(100, 30 + y)).some(([r, g, b]) => r === 0x5f && g === 0x87 && b === 0xaf)
        const [r, g, b] = at(300, 200)
        return title && r === 255 && g === 255 && b === 255
      }
      await until(s, 'the xterm', () => window(pixels(s)))

      s.type('poweroff\n')
      expect(s.runToPowerOff(5_000_000_000)).toBe('poweroff')
    } finally {
      file.close()
    }
  })
})
