import { WordDevice } from './bus.js'

/**
 * System controller: a single register that powers the machine off or reboots
 * it. Linux drives it through its generic "syscon-poweroff" / "syscon-reboot"
 * drivers, so the values are whatever the device tree says (we use the same as
 * mini-rv32ima).
 */
export class Syscon extends WordDevice {
  static readonly SIZE = 0x1000
  static readonly POWEROFF = 0x5555
  static readonly REBOOT = 0x7777

  constructor(private readonly onCommand: (command: 'poweroff' | 'reboot') => void) {
    super()
  }

  protected readWord(): number {
    return 0
  }

  protected writeWord(offset: number, value: number): void {
    if (offset !== 0) return
    if (value === Syscon.POWEROFF) this.onCommand('poweroff')
    else if (value === Syscon.REBOOT) this.onCommand('reboot')
  }
}
