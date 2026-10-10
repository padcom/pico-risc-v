/** Control and status register addresses (privileged spec, machine level + user counters). */
export const enum Csr {
  // Unprivileged counters / timers (read-only shadows)
  cycle = 0xc00,
  time = 0xc01,
  instret = 0xc02,
  cycleh = 0xc80,
  timeh = 0xc81,
  instreth = 0xc82,

  // Machine information
  mvendorid = 0xf11,
  marchid = 0xf12,
  mimpid = 0xf13,
  mhartid = 0xf14,
  mconfigptr = 0xf15,

  // Machine trap setup
  mstatus = 0x300,
  misa = 0x301,
  mie = 0x304,
  mtvec = 0x305,
  mcounteren = 0x306,
  mstatush = 0x310,
  mcountinhibit = 0x320,

  // Machine trap handling
  mscratch = 0x340,
  mepc = 0x341,
  mcause = 0x342,
  mtval = 0x343,
  mip = 0x344,

  // Machine memory protection (no entries implemented: all read as zero)
  pmpcfg0 = 0x3a0,
  pmpcfg15 = 0x3af,
  pmpaddr0 = 0x3b0,
  pmpaddr63 = 0x3ef,

  // Machine counters
  mcycle = 0xb00,
  minstret = 0xb02,
  mcycleh = 0xb80,
  minstreth = 0xb82,
}

/** mstatus fields. */
export const MSTATUS_MIE = 1 << 3
export const MSTATUS_MPIE = 1 << 7
export const MSTATUS_MPP_SHIFT = 11
export const MSTATUS_MPP = 3 << MSTATUS_MPP_SHIFT

/** mip / mie bits. */
export const MIP_MSIP = 1 << 3
export const MIP_MTIP = 1 << 7
export const MIP_MEIP = 1 << 11

/** Privilege levels. */
export const enum Priv {
  User = 0,
  Machine = 3,
}
