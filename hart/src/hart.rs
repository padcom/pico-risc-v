//! RV32IMAC / RV64IMAC hart with machine, supervisor and user privilege modes
//! (Zicsr, Zifencei) and virtual memory (Sv32 / Sv39).
//!
//! The register width (XLEN) is chosen when the hart is set up. The code is
//! written once, generic over it (`X64`), and compiled for each, so neither
//! pays for the other at run time. Registers are 64 bits wide; on RV32 they
//! always hold sign-extended 32-bit values, which is how RV64 itself treats
//! 32-bit values, so most instructions need no special case.
//!
//! Exceptions and interrupts are taken architecturally: into M-mode
//! (mepc/mcause/mtval, mtvec), or into S-mode when delegated through
//! medeleg/mideleg (sepc/scause/stval, stvec).

use crate::csr::*;
use crate::memory::Access;
use crate::mmu::{Paging, TLB_EMPTY, TLB_SIZE};
use crate::rvc;

/// A synchronous exception: aborts the instruction, then the hart enters the
/// trap handler. `tval` is the value the spec puts in mtval/stval.
#[derive(Clone, Copy)]
pub struct Trap {
    pub cause: u32,
    pub tval: u64,
}

impl Trap {
    pub const fn new(cause: u32, tval: u64) -> Trap {
        Trap { cause, tval }
    }
}

pub type Result<T> = core::result::Result<T, Trap>;

/// Not an exception: EBREAK with `break_on_ebreak` set, which stops `run()`
/// with the pc left on the EBREAK.
const STOP_AT_BREAKPOINT: u32 = u32::MAX;

/// Why `run()` returned (src/cpu.ts maps these to its StopReason names).
pub const LIMIT: u32 = 0;
pub const WFI_STALL: u32 = 1;
pub const STOPPED_AT_BREAKPOINT: u32 = 2;
pub const STOPPED: u32 = 3;

/// misa extensions: A, C, I, M, S, U (MXL, the XLEN, goes on top).
const MISA_EXTENSIONS: u64 = 1 << 0 | 1 << 2 | 1 << 8 | 1 << 12 | 1 << 18 | 1 << 20;

const MSTATUS_WRITABLE: u64 = MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE | MSTATUS_SPP
    | MSTATUS_MPP | MSTATUS_MPRV | MSTATUS_SUM | MSTATUS_MXR | MSTATUS_TVM | MSTATUS_TW | MSTATUS_TSR;
/// The part of mstatus writable through sstatus...
const SSTATUS_WRITABLE: u64 = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR;
/// ...and visible through it (on RV64 also UXL).
const SSTATUS_VISIBLE: u64 = SSTATUS_WRITABLE | 3 << 32;
const MIE_WRITABLE: u64 = MIP_SSIP | MIP_MSIP | MIP_STIP | MIP_MTIP | MIP_SEIP | MIP_MEIP;
/// mip bits software may write; the machine ones are driven by devices (CLINT).
const MIP_WRITABLE: u64 = MIP_SSIP | MIP_STIP | MIP_SEIP;
const MIDELEG_WRITABLE: u64 = MIP_SSIP | MIP_STIP | MIP_SEIP;
/// Delegatable exceptions: all but ECALL from M-mode (11) and the reserved causes 10 and 14.
const MEDELEG_WRITABLE: u64 = 0xb3ff;
const COUNTEREN_WRITABLE: u64 = 0x7; // cycle, time, instret

/// No LR reservation (addresses are aligned, so this never matches).
const NO_RESERVATION: u64 = u64::MAX;

// Opcodes
const LOAD: u32 = 0x03;
const MISC_MEM: u32 = 0x0f;
const OP_IMM: u32 = 0x13;
const AUIPC: u32 = 0x17;
const OP_IMM_32: u32 = 0x1b;
const STORE: u32 = 0x23;
const AMO: u32 = 0x2f;
const OP: u32 = 0x33;
const LUI: u32 = 0x37;
const OP_32: u32 = 0x3b;
const BRANCH: u32 = 0x63;
const JALR: u32 = 0x67;
const JAL: u32 = 0x6f;
const SYSTEM: u32 = 0x73;

const ECALL: u32 = 0x00000073;
const EBREAK: u32 = 0x00100073;
const MRET: u32 = 0x30200073;
const SRET: u32 = 0x10200073;
const WFI: u32 = 0x10500073;
const SFENCE_VMA: u32 = 0x12000073; // funct7 0001001, rs2/rs1 vary

#[repr(C)]
pub struct Hart {
    /// x0..x31; x0 is re-zeroed after every instruction. On RV32 the values
    /// are sign-extended from 32 bits.
    pub x: [u64; 32],
    pub pc: u64,
    pub priv_: u32,
    /// RV64 (else RV32); set once, before running.
    pub xlen64: bool,

    // Machine-mode CSR state (sstatus, sie and sip are views of these)
    pub mstatus: u64,
    pub mie: u64,
    /// Pending interrupts. Machine bits are driven by devices.
    pub mip: u64,
    pub mtvec: u64,
    pub mscratch: u64,
    pub mepc: u64,
    pub mcause: u64,
    pub mtval: u64,
    pub medeleg: u64,
    pub mideleg: u64,
    pub mcounteren: u64,

    // Supervisor-mode CSR state
    pub stvec: u64,
    pub sscratch: u64,
    pub sepc: u64,
    pub scause: u64,
    pub stval: u64,
    pub satp: u64,
    pub scounteren: u64,

    /// Instructions retired since reset. The emulator's own count (it drives
    /// the virtual clock): software sees it through the cycle and instret
    /// counters, which it can set, so they are kept as offsets from it.
    pub retired: u64,
    cycle_offset: u64,
    instret_offset: u64,
    /// True while stalled in WFI.
    pub waiting: bool,
    pub break_on_ebreak: bool,
    /// Whether the `time` CSRs have a source (else they are illegal).
    pub has_time: bool,
    /// Set by `stop()` (or a breakpoint) to make `run()` return.
    pub stop_reason: u32,

    /// Whether fetches / loads and stores go through the MMU, and with which privilege.
    pub(crate) translate_fetch: bool,
    pub(crate) translate_data: bool,
    pub(crate) data_priv: u32,
    pub(crate) paging: Paging,
    /// Addresses are XLEN bits wide.
    pub(crate) address_mask: u64,
    /// Physical address reserved by LR.
    reservation: u64,

    /// RAM: `ram_size` bytes at `ram`, at physical address `ram_base`.
    pub(crate) ram: *mut u8,
    pub(crate) ram_base: u64,
    pub(crate) ram_size: u64,

    pub(crate) tlb_vpn: [u64; TLB_SIZE],
    pub(crate) tlb_ppn: [u32; TLB_SIZE],
    pub(crate) tlb_flags: [u8; TLB_SIZE],
}

impl Hart {
    pub const fn new() -> Hart {
        Hart {
            x: [0; 32],
            pc: 0,
            priv_: PRIV_M,
            xlen64: false,
            mstatus: 0,
            mie: 0,
            mip: 0,
            mtvec: 0,
            mscratch: 0,
            mepc: 0,
            mcause: 0,
            mtval: 0,
            medeleg: 0,
            mideleg: 0,
            mcounteren: COUNTEREN_WRITABLE,
            stvec: 0,
            sscratch: 0,
            sepc: 0,
            scause: 0,
            stval: 0,
            satp: 0,
            scounteren: COUNTEREN_WRITABLE,
            retired: 0,
            cycle_offset: 0,
            instret_offset: 0,
            waiting: false,
            break_on_ebreak: false,
            has_time: false,
            stop_reason: 0,
            translate_fetch: false,
            translate_data: false,
            data_priv: PRIV_M,
            paging: Paging::Bare,
            address_mask: 0xffff_ffff,
            reservation: NO_RESERVATION,
            ram: core::ptr::null_mut(),
            ram_base: 0,
            ram_size: 0,
            tlb_vpn: [TLB_EMPTY; TLB_SIZE],
            tlb_ppn: [0; TLB_SIZE],
            tlb_flags: [0; TLB_SIZE],
        }
    }

    /// Return to the power-on state and start executing at `pc`.
    pub fn reset(&mut self, pc: u64) {
        self.address_mask = if self.xlen64 { u64::MAX } else { 0xffff_ffff };
        self.x = [0; 32];
        self.pc = pc & self.address_mask;
        self.priv_ = PRIV_M;
        self.mstatus = if self.xlen64 { MSTATUS_UXL_SXL_64 } else { 0 };
        self.mie = 0;
        self.mip = 0;
        self.mtvec = 0;
        self.mscratch = 0;
        self.mepc = 0;
        self.mcause = 0;
        self.mtval = 0;
        self.medeleg = 0;
        self.mideleg = 0;
        self.stvec = 0;
        self.sscratch = 0;
        self.sepc = 0;
        self.scause = 0;
        self.stval = 0;
        self.satp = 0;
        self.mcounteren = COUNTEREN_WRITABLE;
        self.scounteren = COUNTEREN_WRITABLE;
        self.retired = 0;
        self.cycle_offset = 0;
        self.instret_offset = 0;
        self.waiting = false;
        self.reservation = NO_RESERVATION;
        self.flush_tlb();
        self.update_translation();
    }

    /// Execute up to `max_steps` steps (instructions or trap entries).
    pub fn run<const X64: bool>(&mut self, max_steps: u32) -> u32 {
        self.stop_reason = 0;
        for _ in 0..max_steps {
            if self.waiting && self.mip & self.mie == 0 {
                return WFI_STALL;
            }
            self.step::<X64>();
            if self.stop_reason != 0 {
                return self.stop_reason;
            }
        }
        LIMIT
    }

    /// Take a pending interrupt, or fetch, decode and execute one instruction.
    pub fn step<const X64: bool>(&mut self) {
        let pending = self.mip & self.mie;
        if self.waiting {
            if pending == 0 {
                return;
            }
            self.waiting = false;
        }
        if pending != 0 && self.take_interrupt::<X64>(pending) {
            return;
        }

        let pc = self.pc;
        let result = match self.fetch(pc) {
            Ok(word) => 'run: {
                // A compressed instruction runs as its 32-bit equivalent (0: illegal).
                let (inst, length) = if word & 3 == 3 {
                    (word, 4)
                } else {
                    match rvc::expanded::<X64>(word & 0xffff) {
                        0 => break 'run Err(illegal(word & 0xffff)),
                        inst => (inst, 2),
                    }
                };
                self.execute::<X64>(inst, pc, addr::<X64>(pc.wrapping_add(length)))
            }
            Err(trap) => Err(trap),
        };
        match result {
            Ok(next_pc) => {
                self.x[0] = 0;
                self.pc = next_pc;
                self.retired += 1;
            }
            Err(trap) if trap.cause == STOP_AT_BREAKPOINT => self.stop_reason = STOPPED_AT_BREAKPOINT,
            Err(trap) => self.enter_trap::<X64>(trap.cause, false, pc, trap.tval),
        }
    }

    /// Take the highest-priority pending interrupt that is enabled at the current
    /// privilege: non-delegated ones trap to M-mode (enabled below M, or in M with
    /// MIE), delegated ones to S-mode (enabled in U, or in S with SIE; never in M).
    fn take_interrupt<const X64: bool>(&mut self, pending: u64) -> bool {
        let machine = pending & !self.mideleg;
        let supervisor = pending & self.mideleg;
        let candidates = if machine != 0 && (self.priv_ < PRIV_M || self.mstatus & MSTATUS_MIE != 0) {
            machine
        } else if supervisor != 0
            && (self.priv_ < PRIV_S || (self.priv_ == PRIV_S && self.mstatus & MSTATUS_SIE != 0))
        {
            supervisor
        } else {
            return false;
        };
        for cause in INTERRUPT_PRIORITY {
            if candidates & (1 << cause) != 0 {
                self.enter_trap::<X64>(cause, true, self.pc, 0);
                return true;
            }
        }
        false
    }

    fn enter_trap<const X64: bool>(&mut self, cause: u32, interrupt: bool, epc: u64, tval: u64) {
        let delegated = (if interrupt { self.mideleg } else { self.medeleg }) & (1 << cause) != 0;
        let interrupt_bit = if X64 { 1 << 63 } else { 1 << 31 };
        let cause_value = if interrupt { interrupt_bit | cause as u64 } else { cause as u64 };
        if self.priv_ <= PRIV_S && delegated {
            self.sepc = epc;
            self.scause = cause_value;
            self.stval = tval;
            let sie = self.mstatus & MSTATUS_SIE != 0;
            self.mstatus = (self.mstatus & !(MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP))
                | if sie { MSTATUS_SPIE } else { 0 }
                | if self.priv_ == PRIV_S { MSTATUS_SPP } else { 0 };
            self.priv_ = PRIV_S;
            self.pc = vector(self.stvec, cause, interrupt);
        } else {
            self.mepc = epc;
            self.mcause = cause_value;
            self.mtval = tval;
            let mie = self.mstatus & MSTATUS_MIE != 0;
            self.mstatus = (self.mstatus & !(MSTATUS_MIE | MSTATUS_MPIE | MSTATUS_MPP))
                | if mie { MSTATUS_MPIE } else { 0 }
                | (self.priv_ as u64) << MSTATUS_MPP_SHIFT;
            self.priv_ = PRIV_M;
            self.pc = vector(self.mtvec, cause, interrupt);
        }
        self.reservation = NO_RESERVATION;
        self.update_translation();
    }

    /// Recompute which accesses need translating, and how; call after any
    /// change to priv, mstatus or satp.
    pub(crate) fn update_translation(&mut self) {
        self.paging = if self.xlen64 {
            if self.satp >> SATP64_MODE_SHIFT == SATP64_MODE_SV39 { Paging::Sv39 } else { Paging::Bare }
        } else if self.satp & SATP32_MODE_SV32 != 0 {
            Paging::Sv32
        } else {
            Paging::Bare
        };
        let paging = self.paging != Paging::Bare;
        self.data_priv = if self.priv_ == PRIV_M && self.mstatus & MSTATUS_MPRV != 0 {
            ((self.mstatus & MSTATUS_MPP) >> MSTATUS_MPP_SHIFT) as u32
        } else {
            self.priv_
        };
        self.translate_fetch = paging && self.priv_ != PRIV_M;
        self.translate_data = paging && self.data_priv != PRIV_M;
    }

    /// Write a destination register (RV32: sign-extended from 32 bits).
    #[inline(always)]
    fn set<const X64: bool>(&mut self, rd: usize, value: u64) {
        self.x[rd] = if X64 { value } else { sext32(value) };
    }

    /// Execute one instruction (a compressed one expanded); returns the next
    /// pc, `next_pc` unless it jumps.
    ///
    /// With the C extension, instructions only need 2-byte alignment, and no
    /// jump can produce an odd target (JALR clears bit 0, offsets are even),
    /// so there are no instruction-address-misaligned exceptions.
    #[inline(always)]
    fn execute<const X64: bool>(&mut self, inst: u32, pc: u64, mut next_pc: u64) -> Result<u64> {
        let opcode = inst & 0x7f;
        let rd = ((inst >> 7) & 0x1f) as usize;
        let funct3 = (inst >> 12) & 0x7;
        let rs1 = ((inst >> 15) & 0x1f) as usize;
        let rs2 = ((inst >> 20) & 0x1f) as usize;
        let funct7 = inst >> 25;

        match opcode {
            LUI => self.set::<X64>(rd, sext32((inst & 0xfffff000) as u64)),

            AUIPC => self.set::<X64>(rd, pc.wrapping_add(sext32((inst & 0xfffff000) as u64))),

            JAL => {
                self.set::<X64>(rd, next_pc);
                next_pc = addr::<X64>(pc.wrapping_add(imm_j(inst)));
            }

            JALR => {
                if funct3 != 0 {
                    return Err(illegal(inst));
                }
                let target = addr::<X64>(self.x[rs1].wrapping_add(imm_i(inst)) & !1);
                self.set::<X64>(rd, next_pc);
                next_pc = target;
            }

            BRANCH => {
                // On RV32 the values are sign-extended, which keeps both
                // signed and unsigned order: one comparison serves both XLENs.
                let a = self.x[rs1];
                let b = self.x[rs2];
                let taken = match funct3 {
                    0b000 => a == b,                   // BEQ
                    0b001 => a != b,                   // BNE
                    0b100 => (a as i64) < (b as i64),  // BLT
                    0b101 => (a as i64) >= (b as i64), // BGE
                    0b110 => a < b,                    // BLTU
                    0b111 => a >= b,                   // BGEU
                    _ => return Err(illegal(inst)),
                };
                if taken {
                    next_pc = addr::<X64>(pc.wrapping_add(imm_b(inst)));
                }
            }

            LOAD => {
                let addr = addr::<X64>(self.x[rs1].wrapping_add(imm_i(inst)));
                let value = match funct3 {
                    0b000 => self.load(addr, 1)? as i8 as u64,  // LB
                    0b001 => self.load(addr, 2)? as i16 as u64, // LH
                    0b010 => self.load(addr, 4)? as i32 as u64, // LW
                    0b011 if X64 => self.load(addr, 8)?,        // LD
                    0b100 => self.load(addr, 1)?,               // LBU
                    0b101 => self.load(addr, 2)?,               // LHU
                    0b110 if X64 => self.load(addr, 4)?,        // LWU
                    _ => return Err(illegal(inst)),
                };
                self.set::<X64>(rd, value);
            }

            STORE => {
                let addr = addr::<X64>(self.x[rs1].wrapping_add(imm_s(inst)));
                let width = match funct3 {
                    0b000 => 1,        // SB
                    0b001 => 2,        // SH
                    0b010 => 4,        // SW
                    0b011 if X64 => 8, // SD
                    _ => return Err(illegal(inst)),
                };
                self.store(addr, width, self.x[rs2])?;
            }

            OP_IMM => {
                let a = self.x[rs1];
                let imm = imm_i(inst);
                // Shifts: RV64 has 6-bit amounts (and a 6-bit funct above them).
                let shamt = (inst >> 20) & if X64 { 0x3f } else { 0x1f };
                let shift_funct = inst >> if X64 { 26 } else { 25 };
                let sra = if X64 { 0x10 } else { 0x20 };
                let value = match funct3 {
                    0b000 => a.wrapping_add(imm),                         // ADDI
                    0b010 => ((a as i64) < (imm as i64)) as u64,          // SLTI
                    0b011 => (a < imm) as u64,                            // SLTIU
                    0b100 => a ^ imm,                                     // XORI
                    0b110 => a | imm,                                     // ORI
                    0b111 => a & imm,                                     // ANDI
                    0b001 if shift_funct == 0 => shl::<X64>(a, shamt),    // SLLI
                    0b101 if shift_funct == 0 => shr::<X64>(a, shamt),    // SRLI
                    0b101 if shift_funct == sra => sra_::<X64>(a, shamt), // SRAI
                    _ => return Err(illegal(inst)),
                };
                self.set::<X64>(rd, value);
            }

            OP => {
                let a = self.x[rs1];
                let b = self.x[rs2];
                let shamt = (b & if X64 { 0x3f } else { 0x1f }) as u32;
                let value = match funct7 << 3 | funct3 {
                    0x000 => a.wrapping_add(b),                // ADD
                    0x100 => a.wrapping_sub(b),                // SUB
                    0x001 => shl::<X64>(a, shamt),             // SLL
                    0x002 => ((a as i64) < (b as i64)) as u64, // SLT
                    0x003 => (a < b) as u64,                   // SLTU
                    0x004 => a ^ b,                            // XOR
                    0x005 => shr::<X64>(a, shamt),             // SRL
                    0x105 => sra_::<X64>(a, shamt),            // SRA
                    0x006 => a | b,                            // OR
                    0x007 => a & b,                            // AND
                    // M extension
                    0x008 => a.wrapping_mul(b),                // MUL
                    0x009 => mulh::<X64>(a, b),                // MULH
                    0x00a => mulhsu::<X64>(a, b),              // MULHSU
                    0x00b => mulhu::<X64>(a, b),               // MULHU
                    0x00c => div::<X64>(a, b),                 // DIV
                    0x00d => divu::<X64>(a, b),                // DIVU
                    0x00e => rem::<X64>(a, b),                 // REM
                    0x00f => remu::<X64>(a, b),                // REMU
                    _ => return Err(illegal(inst)),
                };
                self.set::<X64>(rd, value);
            }

            // RV64: 32-bit operations, results sign-extended. They are RV32's
            // own operations, so they share its code.
            OP_IMM_32 if X64 => {
                let a = self.x[rs1];
                let shamt = (inst >> 20) & 0x1f;
                let value = match funct3 {
                    0b000 => a.wrapping_add(imm_i(inst)),                   // ADDIW
                    0b001 if funct7 == 0 => shl::<false>(a, shamt),         // SLLIW
                    0b101 if funct7 == 0 => shr::<false>(a, shamt),         // SRLIW
                    0b101 if funct7 == 0x20 => sra_::<false>(a, shamt),     // SRAIW
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = sext32(value);
            }

            OP_32 if X64 => {
                let a = self.x[rs1];
                let b = self.x[rs2];
                let shamt = (b & 0x1f) as u32;
                let value = match funct7 << 3 | funct3 {
                    0x000 => a.wrapping_add(b),         // ADDW
                    0x100 => a.wrapping_sub(b),         // SUBW
                    0x001 => shl::<false>(a, shamt),    // SLLW
                    0x005 => shr::<false>(a, shamt),    // SRLW
                    0x105 => sra_::<false>(a, shamt),   // SRAW
                    0x008 => a.wrapping_mul(b),         // MULW
                    0x00c => div::<false>(a, b),        // DIVW
                    0x00d => divu::<false>(a, b),       // DIVUW
                    0x00e => rem::<false>(a, b),        // REMW
                    0x00f => remu::<false>(a, b),       // REMUW
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = sext32(value);
            }

            AMO => {
                let width = match funct3 {
                    0b010 => 4,
                    0b011 if X64 => 8,
                    _ => return Err(illegal(inst)),
                };
                self.amo::<X64>(inst, rd, addr::<X64>(self.x[rs1]), self.x[rs2], width)?;
            }

            // FENCE / FENCE.I: a single in-order hart with no caches has nothing to do.
            MISC_MEM => {
                if funct3 > 0b001 {
                    return Err(illegal(inst));
                }
            }

            SYSTEM => {
                if funct3 == 0 {
                    next_pc = self.system(inst, pc, next_pc)?;
                } else {
                    self.csr_instruction::<X64>(inst, rd, funct3, rs1)?;
                }
            }

            _ => return Err(illegal(inst)),
        }
        Ok(next_pc)
    }

    /// ECALL / EBREAK / MRET / SRET / WFI / SFENCE.VMA; returns the next pc.
    fn system(&mut self, inst: u32, pc: u64, next_pc: u64) -> Result<u64> {
        if inst & 0xfe007fff == SFENCE_VMA {
            if self.priv_ == PRIV_U || (self.priv_ == PRIV_S && self.mstatus & MSTATUS_TVM != 0) {
                return Err(illegal(inst));
            }
            self.flush_tlb(); // no ASIDs, so flush everything regardless of rs1/rs2
            return Ok(next_pc);
        }

        match inst {
            ECALL => Err(Trap::new(ECALL_FROM_U + self.priv_, 0)),
            EBREAK if self.break_on_ebreak => Err(Trap::new(STOP_AT_BREAKPOINT, 0)),
            EBREAK => Err(Trap::new(BREAKPOINT, pc)),
            MRET => {
                if self.priv_ != PRIV_M {
                    return Err(illegal(inst));
                }
                let mpp = ((self.mstatus & MSTATUS_MPP) >> MSTATUS_MPP_SHIFT) as u32;
                self.mstatus = (self.mstatus
                    & !(MSTATUS_MIE | MSTATUS_MPP | if mpp != PRIV_M { MSTATUS_MPRV } else { 0 }))
                    | MSTATUS_MPIE
                    | if self.mstatus & MSTATUS_MPIE != 0 { MSTATUS_MIE } else { 0 };
                self.priv_ = mpp;
                self.update_translation();
                Ok(self.mepc)
            }
            SRET => {
                if self.priv_ == PRIV_U || (self.priv_ == PRIV_S && self.mstatus & MSTATUS_TSR != 0) {
                    return Err(illegal(inst));
                }
                let spp = if self.mstatus & MSTATUS_SPP != 0 { PRIV_S } else { PRIV_U };
                self.mstatus = (self.mstatus & !(MSTATUS_SIE | MSTATUS_SPP | MSTATUS_MPRV))
                    | MSTATUS_SPIE
                    | if self.mstatus & MSTATUS_SPIE != 0 { MSTATUS_SIE } else { 0 };
                self.priv_ = spp;
                self.update_translation();
                Ok(self.sepc)
            }
            WFI => {
                if self.priv_ < PRIV_M && self.mstatus & MSTATUS_TW != 0 {
                    return Err(illegal(inst));
                }
                // Resumes once an interrupt is pending and enabled in mie, even if
                // it is globally disabled (then execution simply continues past WFI).
                if self.mip & self.mie == 0 {
                    self.waiting = true;
                }
                Ok(next_pc)
            }
            _ => Err(illegal(inst)),
        }
    }

    fn csr_instruction<const X64: bool>(&mut self, inst: u32, rd: usize, funct3: u32, rs1: usize) -> Result<()> {
        let csr = inst >> 20;
        if self.priv_ < (csr >> 8) & 3 {
            return Err(illegal(inst));
        }

        let op = funct3 & 3; // 1 = write, 2 = set, 3 = clear
        if op == 0 {
            return Err(illegal(inst));
        }
        // CSRR*I take a 5-bit immediate; on RV32 CSRs are 32 bits wide.
        let src = addr::<X64>(if funct3 & 4 != 0 { rs1 as u64 } else { self.x[rs1] });
        let writes = op == 1 || rs1 != 0; // CSRRS/CSRRC with x0/0 only read
        if writes && csr >> 10 == 3 {
            return Err(illegal(inst)); // read-only CSR
        }

        let old = self.read_csr::<X64>(csr, inst)?;
        if writes {
            self.write_csr::<X64>(csr, match op { 1 => src, 2 => old | src, _ => old & !src });
        }
        self.set::<X64>(rd, old);
        Ok(())
    }

    fn read_csr<const X64: bool>(&mut self, csr: u32, inst: u32) -> Result<u64> {
        let value = match csr {
            MSTATUS => self.mstatus,
            MISA => MISA_EXTENSIONS | if X64 { 2 << 62 } else { 1 << 30 },
            MEDELEG => self.medeleg,
            MIDELEG => self.mideleg,
            MIE => self.mie,
            MTVEC => self.mtvec,
            MCOUNTEREN => self.mcounteren,
            MSCRATCH => self.mscratch,
            MEPC => self.mepc,
            MCAUSE => self.mcause,
            MTVAL => self.mtval,
            MIP => self.mip,
            MSTATUSH if !X64 => 0,
            MCOUNTINHIBIT | MVENDORID | MARCHID | MIMPID | MHARTID | MCONFIGPTR => 0,

            SSTATUS => self.mstatus & SSTATUS_VISIBLE,
            SIE => self.mie & self.mideleg,
            SIP => self.mip & self.mideleg,
            STVEC => self.stvec,
            SCOUNTEREN => self.scounteren,
            SSCRATCH => self.sscratch,
            SEPC => self.sepc,
            SCAUSE => self.scause,
            STVAL => self.stval,
            SATP => {
                if self.priv_ == PRIV_S && self.mstatus & MSTATUS_TVM != 0 {
                    return Err(illegal(inst));
                }
                self.satp
            }

            MCYCLE => self.retired.wrapping_add(self.cycle_offset),
            MINSTRET => self.retired.wrapping_add(self.instret_offset),
            MCYCLEH if !X64 => self.retired.wrapping_add(self.cycle_offset) >> 32,
            MINSTRETH if !X64 => self.retired.wrapping_add(self.instret_offset) >> 32,
            CYCLE | INSTRET => {
                self.check_counter_access(csr, inst)?;
                self.retired.wrapping_add(if csr == CYCLE { self.cycle_offset } else { self.instret_offset })
            }
            CYCLEH | INSTRETH if !X64 => {
                self.check_counter_access(csr, inst)?;
                self.retired.wrapping_add(if csr == CYCLEH { self.cycle_offset } else { self.instret_offset }) >> 32
            }
            TIME => {
                self.check_time_access(csr, inst)?;
                self.time()
            }
            TIMEH if !X64 => {
                self.check_time_access(csr, inst)?;
                self.time() >> 32
            }
            PMPCFG0..=PMPADDR63 => 0, // no PMP entries
            TSELECT..=TDATA3 => 0,    // no debug triggers
            _ => return Err(illegal(inst)),
        };
        Ok(addr::<X64>(value))
    }

    fn check_time_access(&self, csr: u32, inst: u32) -> Result<()> {
        if !self.has_time {
            return Err(illegal(inst));
        }
        self.check_counter_access(csr, inst)
    }

    /// User counters are readable below M-mode only if enabled in mcounteren (and scounteren for U).
    fn check_counter_access(&self, csr: u32, inst: u32) -> Result<()> {
        let bit = 1 << (csr & 0x1f);
        if self.priv_ < PRIV_M && self.mcounteren & bit == 0 {
            return Err(illegal(inst));
        }
        if self.priv_ == PRIV_U && self.scounteren & bit == 0 {
            return Err(illegal(inst));
        }
        Ok(())
    }

    fn write_csr<const X64: bool>(&mut self, csr: u32, value: u64) {
        match csr {
            MSTATUS => {
                let mut v = value & MSTATUS_WRITABLE;
                if v & MSTATUS_MPP == 2 << MSTATUS_MPP_SHIFT {
                    v &= !MSTATUS_MPP; // no H-mode: 2 → U
                }
                self.mstatus = v | if X64 { MSTATUS_UXL_SXL_64 } else { 0 };
                self.update_translation();
            }
            MEDELEG => self.medeleg = value & MEDELEG_WRITABLE,
            MIDELEG => self.mideleg = value & MIDELEG_WRITABLE,
            MIE => self.mie = value & MIE_WRITABLE,
            MIP => self.mip = (self.mip & !MIP_WRITABLE) | (value & MIP_WRITABLE),
            MTVEC => self.mtvec = tvec(value),
            MCOUNTEREN => self.mcounteren = value & COUNTEREN_WRITABLE,
            MSCRATCH => self.mscratch = value,
            MEPC => self.mepc = value & !1,
            MCAUSE => self.mcause = value,
            MTVAL => self.mtval = value,

            SSTATUS => {
                self.mstatus = (self.mstatus & !SSTATUS_WRITABLE) | (value & SSTATUS_WRITABLE);
                self.update_translation();
            }
            SIE => self.mie = (self.mie & !self.mideleg) | (value & self.mideleg),
            SIP => {
                let writable = MIP_SSIP & self.mideleg;
                self.mip = (self.mip & !writable) | (value & writable);
            }
            STVEC => self.stvec = tvec(value),
            SCOUNTEREN => self.scounteren = value & COUNTEREN_WRITABLE,
            SSCRATCH => self.sscratch = value,
            SEPC => self.sepc = value & !1,
            SCAUSE => self.scause = value,
            STVAL => self.stval = value,
            SATP => {
                // No ASIDs (ASIDLEN = 0, so those bits read as zero). On RV64,
                // a write selecting an unsupported mode (Sv48, Sv57) has no
                // effect at all: that's how Linux finds out which it may use.
                if X64 {
                    let mode = value >> SATP64_MODE_SHIFT;
                    if mode != 0 && mode != SATP64_MODE_SV39 {
                        return;
                    }
                    self.satp = value & (0xf << SATP64_MODE_SHIFT | SATP64_PPN);
                } else {
                    self.satp = value & (SATP32_MODE_SV32 | SATP32_PPN);
                }
                self.flush_tlb();
                self.update_translation();
            }

            // The counters count on from what software writes. The writing
            // instruction itself isn't counted (the next reads the value written).
            MCYCLE | MINSTRET | MCYCLEH | MINSTRETH => {
                let retired = self.retired;
                let offset = if csr & 2 != 0 { &mut self.instret_offset } else { &mut self.cycle_offset };
                let current = retired.wrapping_add(*offset);
                let new = if csr & 0x80 != 0 {
                    value << 32 | (current & 0xffff_ffff) // RV32 upper half
                } else if X64 {
                    value
                } else {
                    (current & !0xffff_ffff) | value // RV32 lower half
                };
                *offset = new.wrapping_sub(retired + 1);
            }
            // Everything else that reads successfully is WARL read-only here:
            // no PMP, no debug triggers, counters can't be inhibited.
            _ => {}
        }
    }

    /// LR / SC / AMO*, on 4 (.W) or 8 (.D) bytes. .W values are sign-extended.
    fn amo<const X64: bool>(&mut self, inst: u32, rd: usize, vaddr: u64, src: u64, width: u32) -> Result<()> {
        let op = inst >> 27;
        let lr = op == 0b00010;
        if vaddr & (width as u64 - 1) != 0 {
            return Err(Trap::new(if lr { LOAD_ADDRESS_MISALIGNED } else { STORE_ADDRESS_MISALIGNED }, vaddr));
        }
        let access = if lr { Access::Load } else { Access::Store };
        let pa = if self.translate_data { self.translate(vaddr, access, self.data_priv)? } else { vaddr };
        // AMOs (and SC) report store faults, even for their read half.
        let fault = Trap::new(access.access_fault(), vaddr);
        let extend = |v: u64| if width == 4 { sext32(v) } else { v };

        if lr {
            let value = self.phys_read(pa, width).ok_or(fault)?;
            self.set::<X64>(rd, extend(value));
            self.reservation = pa;
            return Ok(());
        }
        if op == 0b00011 {
            // SC
            let ok = self.reservation == pa;
            self.reservation = NO_RESERVATION;
            if ok && !self.phys_write(pa, width, src) {
                return Err(fault);
            }
            self.set::<X64>(rd, !ok as u64);
            return Ok(());
        }

        let old = self.phys_read(pa, width).ok_or(fault)?;
        // Compare as XLEN- or 32-bit values: sign-extend both to 64 bits.
        let (a, b) = (extend(old), extend(src));
        let value = match op {
            0b00001 => b,                               // AMOSWAP
            0b00000 => a.wrapping_add(b),               // AMOADD
            0b00100 => a ^ b,                           // AMOXOR
            0b01100 => a & b,                           // AMOAND
            0b01000 => a | b,                           // AMOOR
            0b10000 => (a as i64).min(b as i64) as u64, // AMOMIN
            0b10100 => (a as i64).max(b as i64) as u64, // AMOMAX
            0b11000 => a.min(b),                        // AMOMINU
            0b11100 => a.max(b),                        // AMOMAXU
            _ => return Err(illegal(inst)),
        };
        if !self.phys_write(pa, width, value) {
            return Err(fault);
        }
        self.set::<X64>(rd, a);
        Ok(())
    }
}

/// Sign-extend from 32 bits.
#[inline(always)]
const fn sext32(v: u64) -> u64 {
    v as i32 as i64 as u64
}

/// An address: on RV32, 32 bits.
#[inline(always)]
const fn addr<const X64: bool>(v: u64) -> u64 {
    if X64 { v } else { v & 0xffff_ffff }
}

// Shifts by an amount already masked to XLEN. On RV32 (and for RV64's *W
// instructions) they work on the low 32 bits; callers sign-extend the result.
#[inline(always)]
fn shl<const X64: bool>(a: u64, shamt: u32) -> u64 {
    if X64 { a << shamt } else { ((a as u32) << shamt) as u64 }
}
#[inline(always)]
fn shr<const X64: bool>(a: u64, shamt: u32) -> u64 {
    if X64 { a >> shamt } else { ((a as u32) >> shamt) as u64 }
}
#[inline(always)]
fn sra_<const X64: bool>(a: u64, shamt: u32) -> u64 {
    if X64 { ((a as i64) >> shamt) as u64 } else { ((a as i32) >> shamt) as u64 }
}

// M extension: the upper half of a 2·XLEN-bit product, and division (by zero
// and overflowing ones have defined results, no trap). The 32-bit versions
// also serve RV64's *W instructions.
#[inline(always)]
fn mulh<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        ((a as i64 as i128 * b as i64 as i128) >> 64) as u64
    } else {
        ((a as i32 as i64 * b as i32 as i64) >> 32) as u64
    }
}
#[inline(always)]
fn mulhsu<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        ((a as i64 as i128 * b as i128) >> 64) as u64
    } else {
        ((a as i32 as i64 * b as u32 as i64) >> 32) as u64
    }
}
#[inline(always)]
fn mulhu<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 { ((a as u128 * b as u128) >> 64) as u64 } else { (a as u32 as u64 * b as u32 as u64) >> 32 }
}
#[inline(always)]
fn div<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        if b == 0 { u64::MAX } else { (a as i64).wrapping_div(b as i64) as u64 }
    } else if b as u32 == 0 {
        u64::MAX
    } else {
        (a as i32).wrapping_div(b as i32) as u64
    }
}
#[inline(always)]
fn divu<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        if b == 0 { u64::MAX } else { a / b }
    } else if b as u32 == 0 {
        u64::MAX
    } else {
        (a as u32 / b as u32) as u64
    }
}
#[inline(always)]
fn rem<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        if b == 0 { a } else { (a as i64).wrapping_rem(b as i64) as u64 }
    } else if b as u32 == 0 {
        a
    } else {
        (a as i32).wrapping_rem(b as i32) as u64
    }
}
#[inline(always)]
fn remu<const X64: bool>(a: u64, b: u64) -> u64 {
    if X64 {
        if b == 0 { a } else { a % b }
    } else if b as u32 == 0 {
        a
    } else {
        (a as u32 % b as u32) as u64
    }
}

const fn illegal(inst: u32) -> Trap {
    Trap::new(ILLEGAL_INSTRUCTION, inst as u64)
}

/// xtvec is direct (mode 0) or vectored (mode 1).
const fn tvec(value: u64) -> u64 {
    if value & 3 != 0 { (value & !3) | 1 } else { value }
}

/// Trap target: vectored mode sends interrupts to base + 4 × cause.
const fn vector(tvec: u64, cause: u32, interrupt: bool) -> u64 {
    let base = tvec & !3;
    if interrupt && tvec & 3 == 1 { base.wrapping_add(4 * cause as u64) } else { base }
}

// Immediate decoders. All sign-extended to 64 bits.
const fn imm_i(i: u32) -> u64 {
    (i as i32 >> 20) as u64
}
const fn imm_s(i: u32) -> u64 {
    ((i as i32 >> 25) << 5 | ((i >> 7) & 0x1f) as i32) as u64
}
const fn imm_b(i: u32) -> u64 {
    ((i as i32 >> 31) << 12 | (((i >> 7) & 1) << 11 | ((i >> 25) & 0x3f) << 5 | ((i >> 8) & 0xf) << 1) as i32) as u64
}
const fn imm_j(i: u32) -> u64 {
    ((i as i32 >> 31) << 20 | (((i >> 12) & 0xff) << 12 | ((i >> 20) & 1) << 11 | ((i >> 21) & 0x3ff) << 1) as i32) as u64
}
