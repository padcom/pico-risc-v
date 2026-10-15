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
  s.machine.output!.draw(rgba)
  return rgba
}

/** How many of the pixels in rows `top` to `bottom` (excluded) aren't black. */
function lit(rgba: Uint8Array, top: number, bottom: number): number {
  let count = 0
  for (let i = top * WIDTH; i < bottom * WIDTH; i++) if (rgba[4 * i] || rgba[4 * i + 1] || rgba[4 * i + 2]) count++
  return count
}

/** A square wave (16-bit stereo): 4 frames a cycle, ±0.5, 2^12 cycles. */
const WAVE_FRAMES = 4 << 12

/**
 * The sound card (heard: what the host got): what aplay plays, a square wave
 * at 22.05 kHz, made in the guest, the host gets as it is, at its pace (in
 * the guest's time). And Freedoom, on Chocolate Doom, plays (its demos,
 * with music): heard.
 */
async function playsSound(s: LinuxSession, heard: number[], done: number): Promise<void> {
  s.type(
    `printf '${'\\000\\100'.repeat(4)}${'\\000\\300'.repeat(4)}' >/tmp/wave; ` +
      `for i in $(seq 12); do cat /tmp/wave /tmp/wave >/tmp/twice; mv /tmp/twice /tmp/wave; done; ` +
      `time aplay -q -t raw -f S16_LE -c 2 -r 22050 /tmp/wave; echo "done-$((${done}+0))"\n`,
  )
  await s.waitForAsync(`done-${done}\r\n`, BUDGET, 600_000)
  // (The guest's shell's time: bash's "0m0.770s", BusyBox's "0m 0.77s".)
  const seconds = Number(/real\s+0m\s*([\d.]+)s/.exec(s.screen)?.[1])
  expect(seconds).toBeGreaterThanOrEqual(WAVE_FRAMES / 22_050)
  expect(seconds).toBeLessThan(WAVE_FRAMES / 22_050 + 0.5)
  const start = heard.findIndex(x => x !== 0)
  const wave = heard.slice(start, start + 2 * WAVE_FRAMES)
  expect(wave.length).toBe(2 * WAVE_FRAMES)
  expect(wave.every((x, i) => x === ((i >> 2) & 1 ? -0.5 : 0.5))).toBe(true)

  // Freedoom, as its menu entry starts it: freedoom1, the launcher (a bash
  // script) that finds the engine.
  heard.length = 0
  s.type('cd /tmp; DISPLAY=:0 XAUTHORITY=/root/.Xauthority PATH=$PATH:/usr/games freedoom1 >doom.log 2>&1 &\n')
  let checked = 0
  let peak = 0
  await until(s, "Freedoom's sound", () => {
    for (; checked < heard.length; checked++) peak = Math.max(peak, Math.abs(heard[checked]!))
    return peak > 0.1
  })
  s.type(`pkill chocolate-doom; grep Precaching doom.log; echo "done-$((${done + 1}+0))"\n`)
  await s.waitForAsync(`done-${done + 1}\r\n`, BUDGET, 600_000)
  expect(s.screen).toContain('I_SDL_PrecacheSounds: Precaching all sound effects')
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
    'has the screen (efifb), the keyboard and the mouse, and starts Xfce on them (on the GPU); a VNC viewer sees it and uses it; it takes another size; it plays sound, and Freedoom',
    { timeout: 3_600_000 },
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
            sound: true,
          },
        )
        const heard: number[] = []
        s.machine.sound!.output = samples => heard.push(...samples)
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
        // (Its handlers in the order Linux's input handlers took it, which varies.)
        expect(s.screen).toMatch(/N: Name="risc-emulator tablet"\r\nH: Handlers=mouse0 (js0 event\d|event\d js0)/)
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
        const vnc = new VncServer(s.machine)
        const viewer = await RfbClient.connect(await vnc.listen(0))
        try {
          const [all] = await viewer.update(false)
          const { pixels: screen } = s.machine.output!
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

        // Another size (a window's): the GPU tells Linux, udev X (xrandr), and
        // the screen shows the desktop that size.
        expect(s.machine.output).not.toBe(s.machine.screen) // (X is on the GPU)
        s.machine.setDisplaySize(1280, 720)
        await until(s, 'the new size', () => s.machine.output?.width === 1280 && s.machine.output.height === 720)

        await playsSound(s, heard, 10)

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
 * desktop (X, Fluxbox, xterm; linux/alpine/packages), started on the screen
 * (tty1) by itself.
 */
describe.skipIf(!existsSync(new URL('boot.json', ALPINE)))('Alpine with a screen', () => {
  it('starts X with Fluxbox and an xterm on it (on the GPU), with the keyboard and the mouse (evdev); it takes another size; it plays sound, and Freedoom, full screen too', { timeout: 1_800_000 }, async () => {
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
          sound: true,
        },
      )
      const heard: number[] = []
      s.machine.sound!.output = samples => heard.push(...samples)
      // The console (hvc0) logs in by itself.
      await s.waitForAsync(':~# ', 20_000_000_000, 600_000)

      s.type(
        'until pgrep -x fluxbox && pgrep -x xterm; do sleep 1; done >/dev/null; ' +
          `grep -oE "evdev: (keyboard|tablet): Configuring as [a-z]+" /var/log/Xorg.0.log; echo "done-$((0+1))"\n`,
      )
      await s.waitForAsync('done-1', BUDGET, 600_000)
      expect(s.screen).toContain('evdev: keyboard: Configuring as keyboard')
      // (An absolute pointer with buttons, as evdev sees it.)
      expect(s.screen).toContain('evdev: tablet: Configuring as touchscreen')

      // On the screen: the xterm (white), under Fluxbox's title bar, in its
      // color (~/.fluxbox/styles/emulator: #5f87af), which is where it should be (the colors
      // in the right order, all the way).
      const window = (rgba: Uint8Array) => {
        const at = (x: number, y: number) => [...rgba.subarray(4 * (y * WIDTH + x), 4 * (y * WIDTH + x) + 3)]
        const title = Array.from({ length: 40 }, (_, y) => at(100, 30 + y)).some(([r, g, b]) => r === 0x5f && g === 0x87 && b === 0xaf)
        const [r, g, b] = at(300, 200)
        return title && r === 255 && g === 255 && b === 255
      }
      await until(s, 'the xterm', () => window(pixels(s)))

      // Another size (a window's): X takes it (its session looks every 2 s).
      expect(s.machine.output).not.toBe(s.machine.screen) // (X is on the GPU)
      s.machine.setDisplaySize(1280, 720)
      await until(s, 'the new size', () => s.machine.output?.width === 1280 && s.machine.output.height === 720)

      await playsSound(s, heard, 10)

      // Doom full screen (Alt+Enter: Chocolate Doom asks the window manager,
      // which Fluxbox does and twm didn't): once its window is up, all of the
      // screen is Doom's, none of it the xterm's white or Fluxbox's blue.
      const colors = () => {
        const { width, height } = s.machine.output!
        const rgba = new Uint8Array(width * height * 4)
        s.machine.output!.draw(rgba)
        let desktop = 0
        let other = 0
        for (let i = 0; i < rgba.length; i += 4) {
          const [r, g, b] = [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!]
          if ((r === 255 && g === 255 && b === 255) || (r === 0x5f && g === 0x87 && b === 0xaf)) desktop++
          else if (r || g || b) other++
        }
        return { desktop: desktop / (width * height), other }
      }
      await until(s, "the last Doom's window gone", () => colors().other < (320 * 200) / 2)
      s.type('DISPLAY=:0 XAUTHORITY=/root/.Xauthority freedoom1 >/tmp/doom.log 2>&1 &\n')
      await until(s, "Doom's window", () => colors().other > (320 * 200) / 2)
      // (Its keys only once it's looking for them: a while after.)
      s.type('sleep 5; echo "done-$((12+0))"\n')
      await s.waitForAsync('done-12\r\n', BUDGET, 600_000)
      s.machine.keyboard!.send([Input.EV_KEY, 56, 1]) // KEY_LEFTALT
      s.machine.keyboard!.send([Input.EV_KEY, 28, 1]) // KEY_ENTER
      s.machine.keyboard!.send([Input.EV_KEY, 28, 0])
      s.machine.keyboard!.send([Input.EV_KEY, 56, 0])
      await until(s, 'Doom, full screen', () => colors().desktop < 0.01)
      s.type('pkill -f bin/chocolate-doom\n')

      s.type('poweroff\n')
      expect(s.runToPowerOff(5_000_000_000)).toBe('poweroff')
    } finally {
      file.close()
    }
  })
})
