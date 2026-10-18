import type { Display } from './display.js'
import { fit } from './fit.js'
import { linuxKeyOfScancode } from './keymap.js'
import { dropWindowMenu } from './macos-menus.js'
import { Input, TABLET_MAX } from './virtio-input.js'

/** How often to look for changes on the screen to show (ms). */
const FRAME = 16
/** How long the window's size stays the same before the guest is asked for it (ms). */
const SETTLE = 300

/**
 * The machine's screen in a window of its own (SDL, through the optional
 * @kmamal/sdl package), with its keyboard and mouse: keys by their place on
 * the keyboard (the guest's layout says what they type), the mouse over the
 * screen as the tablet. Resizing the window asks the guest for its size
 * (once it's settled: the GPU's display follows, the boot framebuffer
 * can't); meanwhile the screen keeps its shape in it. `closed` is called
 * when the window is closed (by close(), too).
 *
 * Throws if the package isn't there (it's optional: a native one).
 */
export async function openWindow(display: Display, title: string, closed: () => void): Promise<{ close(): void }> {
  const { default: sdl } = await import('@kmamal/sdl')
  const { keyboard, tablet } = display
  const first = display.output
  const window = sdl.video.createWindow({ title, width: first?.width ?? 1024, height: first?.height ?? 768, resizable: true })
  // (macOS: F11 and the like are the guest's, not the Window menu's.)
  await dropWindowMenu().catch(() => {})
  // What's shown, as big as the output is (now).
  let width = 0
  let height = 0
  let rgba = Buffer.alloc(0)
  let dirty = true
  // One pointer over the screen: the guest's, once it draws one (SDL hides
  // the host's over its windows only).
  let pointer = true
  const showPointer = (show: boolean) => {
    if (show !== pointer) sdl.mouse.showCursor((pointer = show))
  }
  const timer = setInterval(() => {
    const screen = display.output
    if (window.destroyed || !screen) return
    showPointer(!display.drawsPointer)
    if (screen.width !== width || screen.height !== height) {
      ;({ width, height } = screen)
      rgba = Buffer.alloc(width * height * 4)
      dirty = true
    }
    if (screen.draw(rgba) || dirty) {
      dirty = false
      window.render(width, height, width * 4, 'rgba32', rgba, {
        scaling: 'linear',
        dstRect: fit(width, height, window.pixelWidth, window.pixelHeight),
      })
    }
  }, FRAME)
  let settling: ReturnType<typeof setTimeout> | undefined
  window.on('resize', () => {
    dirty = true
    clearTimeout(settling)
    settling = setTimeout(() => !window.destroyed && display.setDisplaySize(window.width, window.height), SETTLE)
  })
  window.on('expose', () => (dirty = true))
  window.on('close', () => {
    clearInterval(timer)
    showPointer(true)
    clearTimeout(settling)
    closed()
  })

  // Keys held down: let go of when the window loses the focus (their keyUp goes elsewhere).
  const held = new Set<number>()
  window.on('keyDown', ({ scancode, repeat }) => {
    const key = scancode === null ? undefined : linuxKeyOfScancode(scancode)
    // (The guest repeats keys itself.)
    if (key === undefined || repeat || held.has(key)) return
    held.add(key)
    keyboard?.send([Input.EV_KEY, key, 1])
  })
  window.on('keyUp', ({ scancode }) => {
    const key = scancode === null ? undefined : linuxKeyOfScancode(scancode)
    if (key === undefined || !held.delete(key)) return
    keyboard?.send([Input.EV_KEY, key, 0])
  })
  window.on('blur', () => {
    for (const key of held) keyboard?.send([Input.EV_KEY, key, 0])
    held.clear()
  })

  // The mouse: where it is over the screen (in window coordinates, not pixels).
  const at = (x: number, y: number): [number, number, number][] => {
    const area = fit(width || 1, height || 1, window.width, window.height)
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
  window.on('mouseMove', ({ x, y }) => tablet?.send(...at(x, y)))
  window.on('mouseButtonDown', ({ x, y, button }) => {
    const code = BUTTONS[button]
    if (code !== undefined) tablet?.send(...at(x, y), [Input.EV_KEY, code, 1])
  })
  window.on('mouseButtonUp', ({ x, y, button }) => {
    const code = BUTTONS[button]
    if (code !== undefined) tablet?.send(...at(x, y), [Input.EV_KEY, code, 0])
  })
  window.on('mouseWheel', ({ dx, dy, flipped }) => {
    const sign = flipped ? -1 : 1
    const notches: [number, number, number][] = []
    if (dy) notches.push([Input.EV_REL, Input.REL_WHEEL, Math.sign(dy * sign)])
    if (dx) notches.push([Input.EV_REL, Input.REL_HWHEEL, Math.sign(dx * sign)])
    if (notches.length) tablet?.send(...notches)
  })
  return { close: () => window.destroy() }
}
