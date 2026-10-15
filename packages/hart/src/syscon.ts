import { WordDevice } from './bus.js'

/**
 * System controller: a single register that powers the machine off or reboots
 * it. Linux drives it through its generic "syscon-poweroff" / "syscon-reboot"
 * drivers, so the values are whatever the device tree says. Bare-metal
 * programs end with an exit code, as with QEMU's test device: POWEROFF is
 * exit code 0, FAIL with the code in the upper 16 bits any other.
 */
export class Syscon extends WordDevice {
  static readonly SIZE = 0x1000
  static readonly POWEROFF = 0x5555
  static readonly FAIL = 0x3333
  static readonly REBOOT = 0x7777

  constructor(private readonly onCommand: (command: 'poweroff' | 'reboot', exitCode: number) => void) {
    super()
  }

  protected readWord(): number {
    return 0
  }

  protected writeWord(offset: number, value: number): void {
    if (offset !== 0) return
    if (value === Syscon.POWEROFF) this.onCommand('poweroff', 0)
    else if ((value & 0xffff) === Syscon.FAIL) this.onCommand('poweroff', value >>> 16)
    else if (value === Syscon.REBOOT) this.onCommand('reboot', 0)
  }
}
