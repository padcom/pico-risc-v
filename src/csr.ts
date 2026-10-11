/** Control and status register addresses (privileged spec: machine, supervisor, user counters). */
export const enum Csr {
  // Supervisor trap setup / handling, address translation
  sstatus = 0x100,
  sie = 0x104,
  stvec = 0x105,
  scounteren = 0x106,
  sscratch = 0x140,
  sepc = 0x141,
  scause = 0x142,
  stval = 0x143,
  sip = 0x144,
  satp = 0x180,

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
  medeleg = 0x302,
  mideleg = 0x303,
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

/** mstatus fields (sstatus is a restricted view of the same register). */
export const MSTATUS_SIE = 1 << 1
export const MSTATUS_MIE = 1 << 3
export const MSTATUS_SPIE = 1 << 5
export const MSTATUS_MPIE = 1 << 7
export const MSTATUS_SPP = 1 << 8
export const MSTATUS_MPP_SHIFT = 11
export const MSTATUS_MPP = 3 << MSTATUS_MPP_SHIFT
/** Floating-point unit state: 0 off, 1 initial, 2 clean, 3 dirty. */
export const MSTATUS_FS = 3 << 13
/** RV32: some extension state (FP) is dirty (on RV64 bit 63). */
export const MSTATUS_SD32 = 1 << 31
export const MSTATUS_MPRV = 1 << 17
export const MSTATUS_SUM = 1 << 18
export const MSTATUS_MXR = 1 << 19
export const MSTATUS_TVM = 1 << 20
export const MSTATUS_TW = 1 << 21
export const MSTATUS_TSR = 1 << 22

/** mip / mie bits (sip / sie show the supervisor ones). */
export const MIP_SSIP = 1 << 1
export const MIP_MSIP = 1 << 3
export const MIP_STIP = 1 << 5
export const MIP_MTIP = 1 << 7
export const MIP_SEIP = 1 << 9
export const MIP_MEIP = 1 << 11

/** satp (Sv32): MODE bit and physical page number of the root page table. */
export const SATP_MODE_SV32 = 1 << 31
export const SATP_PPN = 0x3fffff

/** Privilege levels. */
export const enum Priv {
  User = 0,
  Supervisor = 1,
  Machine = 3,
}
