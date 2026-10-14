import { fit } from './fit.js'
import type { Framebuffer } from './framebuffer.js'
import { linuxKeyOfScancode } from './keymap.js'
import { Input, TABLET_MAX, type VirtioInput } from './virtio-input.js'

/** What a window shows and passes input to (a Machine with a screen). */
export interface Display {
  screen: Framebuffer
  keyboard: VirtioInput
  tablet: VirtioInput
}

/** How often to look for changes on the screen to show (ms). */
const FRAME = 16

/**
 * The machine's screen in a window of its own (SDL, through the optional
 * @kmamal/sdl package), with its keyboard and mouse: keys by their place on
 * the keyboard (the guest's layout says what they type), the mouse over the
 * screen as the tablet. The window can be resized; the screen keeps its
 * shape in it. `closed` is called when the window is closed (by close(),
 * too).
 *
 * Throws if the package isn't there (it's optional: a native one).
 */
export async function openWindow(display: Display, title: string, closed: () => void): Promise<{ close(): void }> {
  const { default: sdl } = await import('@kmamal/sdl')
  const { screen, keyboard, tablet } = display
  const window = sdl.video.createWindow({ title, width: screen.width, height: screen.height, resizable: true })
  const rgba = Buffer.alloc(screen.width * screen.height * 4)
  let dirty = true
  const timer = setInterval(() => {
    if (window.destroyed) return
    if (screen.draw(rgba) || dirty) {
      dirty = false
      window.render(screen.width, screen.height, screen.width * 4, 'rgba32', rgba, {
        scaling: 'linear',
        dstRect: fit(screen.width, screen.height, window.pixelWidth, window.pixelHeight),
      })
    }
  }, FRAME)
  window.on('resize', () => (dirty = true))
  window.on('expose', () => (dirty = true))
  window.on('close', () => {
    clearInterval(timer)
    closed()
  })

  // Keys held down: let go of when the window loses the focus (their keyUp goes elsewhere).
  const held = new Set<number>()
  window.on('keyDown', ({ scancode, repeat }) => {
    const key = scancode === null ? undefined : linuxKeyOfScancode(scancode)
    // (The guest repeats keys itself.)
    if (key === undefined || repeat || held.has(key)) return
    held.add(key)
    keyboard.send([Input.EV_KEY, key, 1])
  })
  window.on('keyUp', ({ scancode }) => {
    const key = scancode === null ? undefined : linuxKeyOfScancode(scancode)
    if (key === undefined || !held.delete(key)) return
    keyboard.send([Input.EV_KEY, key, 0])
  })
  window.on('blur', () => {
    for (const key of held) keyboard.send([Input.EV_KEY, key, 0])
    held.clear()
  })

  // The mouse: where it is over the screen (in window coordinates, not pixels).
  const at = (x: number, y: number): [number, number, number][] => {
    const area = fit(screen.width, screen.height, window.width, window.height)
    const scale = (value: number, size: number) => Math.round(Math.min(Math.max(value / size, 0), 1) * TABLET_MAX)
    return [
      [Input.EV_ABS, Input.ABS_X, scale(x - area.x, area.width)],
      [Input.EV_ABS, Input.ABS_Y, scale(y - area.y, area.height)],
    ]
  }
  const BUTTONS: Record<number, number> = {
    [sdl.mouse.BUTTON.LEFT]: Input.BTN_LEFT,
    [sdl.mouse.BUTTON.MIDDLE]: Input.BTN_MIDDLE,
    [sdl.mouse.BUTTON.RIGHT]: Input.BTN_RIGHT,
  }
  window.on('mouseMove', ({ x, y }) => tablet.send(...at(x, y)))
  window.on('mouseButtonDown', ({ x, y, button }) => {
    const code = BUTTONS[button]
    if (code !== undefined) tablet.send(...at(x, y), [Input.EV_KEY, code, 1])
  })
  window.on('mouseButtonUp', ({ x, y, button }) => {
    const code = BUTTONS[button]
    if (code !== undefined) tablet.send(...at(x, y), [Input.EV_KEY, code, 0])
  })
  window.on('mouseWheel', ({ dx, dy, flipped }) => {
    const sign = flipped ? -1 : 1
    const notches: [number, number, number][] = []
    if (dy) notches.push([Input.EV_REL, Input.REL_WHEEL, Math.sign(dy * sign)])
    if (dx) notches.push([Input.EV_REL, Input.REL_HWHEEL, Math.sign(dx * sign)])
    if (notches.length) tablet.send(...notches)
  })
  return { close: () => window.destroy() }
}
