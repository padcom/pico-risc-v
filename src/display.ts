import type { Framebuffer } from './framebuffer.js'
import type { VirtioInput } from './virtio-input.js'

/**
 * What front ends (the page, a window, VNC) show and pass input to: a
 * Machine with a screen. `output` is what the screen shows now (its size can
 * change: compare); setDisplaySize() asks the guest for another size (the
 * front end's).
 */
export interface Display {
  readonly output: Framebuffer | undefined
  readonly keyboard: VirtioInput | undefined
  readonly tablet: VirtioInput | undefined
  setDisplaySize(width: number, height: number): void
}
