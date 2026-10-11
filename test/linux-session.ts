import { Machine, type MachineOptions } from '../src/machine.js'

/**
 * Drives a Linux machine from a test: boot, wait for text on the terminal,
 * type. Uses the virtual clock, so runs are deterministic and idle time is free.
 */
export class LinuxSession {
  screen = ''
  readonly machine: Machine

  constructor(images: Parameters<Machine['boot']>, options: MachineOptions = {}) {
    this.machine = new Machine({ ...options, clock: 'virtual', output: b => (this.screen += String.fromCharCode(b)) })
    this.machine.boot(...images)
  }

  /** Run until `text` appears on the screen (after its current end). */
  waitFor(text: string, budget = 300_000_000): void {
    const from = this.screen.length
    const end = this.machine.cpu.instret + budget
    while (!this.screen.includes(text, from)) {
      const result = this.machine.run(100_000)
      if (result !== 'limit') throw new Error(`machine stopped (${result}) waiting for ${JSON.stringify(text)}`)
      if (this.machine.cpu.instret > end) {
        throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen ends with:\n${this.screen.slice(-2000)}`)
      }
    }
  }

  /**
   * Like waitFor, but yields to the event loop between slices so host-side
   * I/O (network sockets) can happen; when the guest idles waiting on it, waits
   * a millisecond of real time.
   */
  async waitForAsync(text: string, budget = 300_000_000, timeoutMs = 60_000): Promise<void> {
    const from = this.screen.length
    const end = this.machine.cpu.instret + budget
    const deadline = Date.now() + timeoutMs
    while (!this.screen.includes(text, from)) {
      const result = this.machine.run(100_000)
      if (result === 'idle') await new Promise(resolve => setTimeout(resolve, 1))
      else if (result !== 'limit') throw new Error(`machine stopped (${result}) waiting for ${JSON.stringify(text)}`)
      else await new Promise(resolve => setImmediate(resolve))
      if (this.machine.cpu.instret > end || Date.now() > deadline) {
        throw new Error(`timed out waiting for ${JSON.stringify(text)}; screen ends with:\n${this.screen.slice(-2000)}`)
      }
    }
  }

  type(text: string): void {
    this.machine.terminal.type(text)
  }

  /** Run until the machine powers off (or the budget runs out); returns why it stopped. */
  runToPowerOff(budget = 1_000_000_000) {
    const end = this.machine.cpu.instret + budget
    let result
    do result = this.machine.run(1_000_000)
    while (result === 'limit' && this.machine.cpu.instret < end)
    return result
  }
}
