//! CSR addresses, register fields and trap causes (privileged spec).
//! The TypeScript side has the same values in src/csr.ts and src/trap.ts.

// Supervisor trap setup / handling, address translation
pub const SSTATUS: u32 = 0x100;
pub const SIE: u32 = 0x104;
pub const STVEC: u32 = 0x105;
pub const SCOUNTEREN: u32 = 0x106;
pub const SSCRATCH: u32 = 0x140;
pub const SEPC: u32 = 0x141;
pub const SCAUSE: u32 = 0x142;
pub const STVAL: u32 = 0x143;
pub const SIP: u32 = 0x144;
pub const SATP: u32 = 0x180;

// Unprivileged counters / timers (read-only shadows)
pub const CYCLE: u32 = 0xc00;
pub const TIME: u32 = 0xc01;
pub const INSTRET: u32 = 0xc02;
pub const CYCLEH: u32 = 0xc80;
pub const TIMEH: u32 = 0xc81;
pub const INSTRETH: u32 = 0xc82;

// Machine information
pub const MVENDORID: u32 = 0xf11;
pub const MARCHID: u32 = 0xf12;
pub const MIMPID: u32 = 0xf13;
pub const MHARTID: u32 = 0xf14;
pub const MCONFIGPTR: u32 = 0xf15;

// Machine trap setup
pub const MSTATUS: u32 = 0x300;
pub const MISA: u32 = 0x301;
pub const MEDELEG: u32 = 0x302;
pub const MIDELEG: u32 = 0x303;
pub const MIE: u32 = 0x304;
pub const MTVEC: u32 = 0x305;
pub const MCOUNTEREN: u32 = 0x306;
pub const MSTATUSH: u32 = 0x310;
pub const MCOUNTINHIBIT: u32 = 0x320;

// Machine trap handling
pub const MSCRATCH: u32 = 0x340;
pub const MEPC: u32 = 0x341;
pub const MCAUSE: u32 = 0x342;
pub const MTVAL: u32 = 0x343;
pub const MIP: u32 = 0x344;

// Machine memory protection (no entries implemented: all read as zero)
pub const PMPCFG0: u32 = 0x3a0;
pub const PMPADDR63: u32 = 0x3ef;

// Debug triggers (none: tselect and tdata* read as zero)
pub const TSELECT: u32 = 0x7a0;
pub const TDATA3: u32 = 0x7a3;

// Machine counters
pub const MCYCLE: u32 = 0xb00;
pub const MINSTRET: u32 = 0xb02;
pub const MCYCLEH: u32 = 0xb80;
pub const MINSTRETH: u32 = 0xb82;

/// mstatus fields (sstatus is a restricted view of the same register).
pub const MSTATUS_SIE: u64 = 1 << 1;
pub const MSTATUS_MIE: u64 = 1 << 3;
pub const MSTATUS_SPIE: u64 = 1 << 5;
pub const MSTATUS_MPIE: u64 = 1 << 7;
pub const MSTATUS_SPP: u64 = 1 << 8;
pub const MSTATUS_MPP_SHIFT: u32 = 11;
pub const MSTATUS_MPP: u64 = 3 << MSTATUS_MPP_SHIFT;
pub const MSTATUS_MPRV: u64 = 1 << 17;
pub const MSTATUS_SUM: u64 = 1 << 18;
pub const MSTATUS_MXR: u64 = 1 << 19;
pub const MSTATUS_TVM: u64 = 1 << 20;
pub const MSTATUS_TW: u64 = 1 << 21;
pub const MSTATUS_TSR: u64 = 1 << 22;

/// mip / mie bits (sip / sie show the supervisor ones).
pub const MIP_SSIP: u64 = 1 << 1;
pub const MIP_MSIP: u64 = 1 << 3;
pub const MIP_STIP: u64 = 1 << 5;
pub const MIP_MTIP: u64 = 1 << 7;
pub const MIP_SEIP: u64 = 1 << 9;
pub const MIP_MEIP: u64 = 1 << 11;

/// mstatus.UXL and SXL (RV64 only): U- and S-mode are 64-bit (2), read-only.
pub const MSTATUS_UXL_SXL_64: u64 = 2 << 32 | 2 << 34;

/// satp on RV32: MODE bit and physical page number of the root page table.
pub const SATP32_MODE_SV32: u64 = 1 << 31;
pub const SATP32_PPN: u64 = 0x3fffff;
/// satp on RV64: MODE in bits 63:60 (8 = Sv39), PPN in 43:0.
pub const SATP64_MODE_SHIFT: u32 = 60;
pub const SATP64_MODE_SV39: u64 = 8;
pub const SATP64_PPN: u64 = (1 << 44) - 1;

/// Privilege levels.
pub const PRIV_U: u32 = 0;
pub const PRIV_S: u32 = 1;
pub const PRIV_M: u32 = 3;

/// Exception causes.
pub const INSTRUCTION_ACCESS_FAULT: u32 = 1;
pub const ILLEGAL_INSTRUCTION: u32 = 2;
pub const BREAKPOINT: u32 = 3;
pub const LOAD_ADDRESS_MISALIGNED: u32 = 4;
pub const LOAD_ACCESS_FAULT: u32 = 5;
pub const STORE_ADDRESS_MISALIGNED: u32 = 6;
pub const STORE_ACCESS_FAULT: u32 = 7;
/// ECALL from U-mode; from S-mode and M-mode are 9 and 11 (8 + privilege).
pub const ECALL_FROM_U: u32 = 8;
pub const INSTRUCTION_PAGE_FAULT: u32 = 12;
pub const LOAD_PAGE_FAULT: u32 = 13;
pub const STORE_PAGE_FAULT: u32 = 15;

/// Interrupt causes, highest priority first.
pub const INTERRUPT_PRIORITY: [u32; 6] = [
    11, // machine external
    3,  // machine software
    7,  // machine timer
    9,  // supervisor external
    1,  // supervisor software
    5,  // supervisor timer
];
