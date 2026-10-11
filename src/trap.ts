/** Exception cause codes (mcause values, interrupt bit clear) from the privileged spec. */
export enum TrapCause {
  InstructionAddressMisaligned = 0,
  InstructionAccessFault = 1,
  IllegalInstruction = 2,
  Breakpoint = 3,
  LoadAddressMisaligned = 4,
  LoadAccessFault = 5,
  StoreAddressMisaligned = 6,
  StoreAccessFault = 7,
  EnvironmentCallFromUMode = 8,
  EnvironmentCallFromSMode = 9,
  EnvironmentCallFromMMode = 11,
  InstructionPageFault = 12,
  LoadPageFault = 13,
  StorePageFault = 15,
}

/** Interrupt cause codes (mcause values with the interrupt bit set). */
export enum InterruptCause {
  SupervisorSoftware = 1,
  MachineSoftware = 3,
  SupervisorTimer = 5,
  MachineTimer = 7,
  SupervisorExternal = 9,
  MachineExternal = 11,
}

/**
 * A synchronous exception raised while executing an instruction. Thrown inside
 * the CPU to abort the instruction; the CPU catches it and enters the trap
 * handler at mtvec. `tval` is the value the spec puts in mtval.
 */
export class Trap extends Error {
  constructor(
    readonly cause: TrapCause,
    readonly tval = 0,
  ) {
    super(`${TrapCause[cause]} (tval=0x${(tval >>> 0).toString(16).padStart(8, '0')})`)
  }
}
