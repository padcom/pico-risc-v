/**
 * A network card's other end (as Pico RISC-V's virtio network card has it):
 * Ethernet frames out and in. UserNetwork is one.
 */
export interface NetworkBackend {
  /** A frame the guest transmitted. */
  send(frame: Uint8Array): void
  /** Connect the card's receive side. */
  attach(receive: (frame: Uint8Array) => void): void
  /**
   * True while the guest is waiting on something happening in the real world
   * (a connection being set up, a reply on its way). The virtual clock then
   * doesn't skip ahead, so the guest's timeouts don't expire meanwhile.
   */
  readonly busy?: boolean
  close?(): void
}
