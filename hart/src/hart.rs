//! RV32IMAC hart with machine, supervisor and user privilege modes (Zicsr,
//! Zifencei) and Sv32 virtual memory.
//!
//! Exceptions and interrupts are taken architecturally: into M-mode
//! (mepc/mcause/mtval, mtvec), or into S-mode when delegated through
//! medeleg/mideleg (sepc/scause/stval, stvec).

use crate::csr::*;
use crate::memory::Access;
use crate::mmu::{TLB_EMPTY, TLB_SIZE};
use crate::rvc;

/// A synchronous exception: aborts the instruction, then the hart enters the
/// trap handler. `tval` is the value the spec puts in mtval/stval.
#[derive(Clone, Copy)]
pub struct Trap {
    pub cause: u32,
    pub tval: u32,
}

impl Trap {
    pub const fn new(cause: u32, tval: u32) -> Trap {
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

/// misa: MXL=1 (32-bit), extensions A, C, I, M, S, U.
const MISA_VALUE: u32 = 1 << 30 | 1 << 0 | 1 << 2 | 1 << 8 | 1 << 12 | 1 << 18 | 1 << 20;

const MSTATUS_WRITABLE: u32 = MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE | MSTATUS_SPP
    | MSTATUS_MPP | MSTATUS_MPRV | MSTATUS_SUM | MSTATUS_MXR | MSTATUS_TVM | MSTATUS_TW | MSTATUS_TSR;
/// The part of mstatus visible (and writable) as sstatus.
const SSTATUS_MASK: u32 = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_SUM | MSTATUS_MXR;
const MIE_WRITABLE: u32 = MIP_SSIP | MIP_MSIP | MIP_STIP | MIP_MTIP | MIP_SEIP | MIP_MEIP;
/// mip bits software may write; the machine ones are driven by devices (CLINT).
const MIP_WRITABLE: u32 = MIP_SSIP | MIP_STIP | MIP_SEIP;
const MIDELEG_WRITABLE: u32 = MIP_SSIP | MIP_STIP | MIP_SEIP;
/// Delegatable exceptions: all but ECALL from M-mode (11) and the reserved causes 10 and 14.
const MEDELEG_WRITABLE: u32 = 0xb3ff;
const COUNTEREN_WRITABLE: u32 = 0x7; // cycle, time, instret

// Opcodes
const LOAD: u32 = 0x03;
const MISC_MEM: u32 = 0x0f;
const OP_IMM: u32 = 0x13;
const AUIPC: u32 = 0x17;
const STORE: u32 = 0x23;
const AMO: u32 = 0x2f;
const OP: u32 = 0x33;
const LUI: u32 = 0x37;
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
    /// x0..x31; x0 is re-zeroed after every instruction.
    pub x: [i32; 32],
    pub pc: u32,
    pub priv_: u32,

    // Machine-mode CSR state (sstatus, sie and sip are views of these)
    pub mstatus: u32,
    pub mie: u32,
    /// Pending interrupts. Machine bits are driven by devices.
    pub mip: u32,
    pub mtvec: u32,
    pub mscratch: u32,
    pub mepc: u32,
    pub mcause: u32,
    pub mtval: u32,
    pub medeleg: u32,
    pub mideleg: u32,
    pub mcounteren: u32,

    // Supervisor-mode CSR state
    pub stvec: u32,
    pub sscratch: u32,
    pub sepc: u32,
    pub scause: u32,
    pub stval: u32,
    pub satp: u32,
    pub scounteren: u32,

    /// Instructions retired (also serves as the cycle counter: 1 IPC).
    pub instret: u64,
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
    /// Physical address reserved by LR.W (never matches when u32::MAX: addresses are aligned).
    reservation: u32,

    /// RAM: `ram_size` bytes at `ram`, at physical address `ram_base`.
    pub(crate) ram: *mut u8,
    pub(crate) ram_base: u32,
    pub(crate) ram_size: u32,

    pub(crate) tlb_vpn: [u32; TLB_SIZE],
    pub(crate) tlb_ppn: [u32; TLB_SIZE],
    pub(crate) tlb_flags: [u8; TLB_SIZE],
}

impl Hart {
    pub const fn new() -> Hart {
        Hart {
            x: [0; 32],
            pc: 0,
            priv_: PRIV_M,
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
            instret: 0,
            waiting: false,
            break_on_ebreak: false,
            has_time: false,
            stop_reason: 0,
            translate_fetch: false,
            translate_data: false,
            data_priv: PRIV_M,
            reservation: u32::MAX,
            ram: core::ptr::null_mut(),
            ram_base: 0,
            ram_size: 0,
            tlb_vpn: [TLB_EMPTY; TLB_SIZE],
            tlb_ppn: [0; TLB_SIZE],
            tlb_flags: [0; TLB_SIZE],
        }
    }

    /// Return to the power-on state and start executing at `pc`.
    pub fn reset(&mut self, pc: u32) {
        self.x = [0; 32];
        self.pc = pc;
        self.priv_ = PRIV_M;
        self.mstatus = 0;
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
        self.instret = 0;
        self.waiting = false;
        self.reservation = u32::MAX;
        self.flush_tlb();
        self.update_translation();
    }

    /// Execute up to `max_steps` steps (instructions or trap entries).
    pub fn run(&mut self, max_steps: u32) -> u32 {
        self.stop_reason = 0;
        for _ in 0..max_steps {
            if self.waiting && self.mip & self.mie == 0 {
                return WFI_STALL;
            }
            self.step();
            if self.stop_reason != 0 {
                return self.stop_reason;
            }
        }
        LIMIT
    }

    /// Take a pending interrupt, or fetch, decode and execute one instruction.
    pub fn step(&mut self) {
        let pending = self.mip & self.mie;
        if self.waiting {
            if pending == 0 {
                return;
            }
            self.waiting = false;
        }
        if pending != 0 && self.take_interrupt(pending) {
            return;
        }

        let pc = self.pc;
        let result = match self.fetch(pc) {
            Ok(word) => 'run: {
                // A compressed instruction runs as its 32-bit equivalent (0: illegal).
                let (inst, length) = if word & 3 == 3 {
                    (word, 4)
                } else {
                    match rvc::expanded(word & 0xffff) {
                        0 => break 'run Err(illegal(word & 0xffff)),
                        inst => (inst, 2),
                    }
                };
                self.execute(inst, pc, pc.wrapping_add(length))
            }
            Err(trap) => Err(trap),
        };
        match result {
            Ok(next_pc) => {
                self.x[0] = 0;
                self.pc = next_pc;
                self.instret += 1;
            }
            Err(trap) if trap.cause == STOP_AT_BREAKPOINT => self.stop_reason = STOPPED_AT_BREAKPOINT,
            Err(trap) => self.enter_trap(trap.cause, false, pc, trap.tval),
        }
    }

    /// Take the highest-priority pending interrupt that is enabled at the current
    /// privilege: non-delegated ones trap to M-mode (enabled below M, or in M with
    /// MIE), delegated ones to S-mode (enabled in U, or in S with SIE; never in M).
    fn take_interrupt(&mut self, pending: u32) -> bool {
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
                self.enter_trap(cause, true, self.pc, 0);
                return true;
            }
        }
        false
    }

    fn enter_trap(&mut self, cause: u32, interrupt: bool, epc: u32, tval: u32) {
        let delegated = (if interrupt { self.mideleg } else { self.medeleg }) & (1 << cause) != 0;
        let cause_value = if interrupt { 0x8000_0000 | cause } else { cause };
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
                | self.priv_ << MSTATUS_MPP_SHIFT;
            self.priv_ = PRIV_M;
            self.pc = vector(self.mtvec, cause, interrupt);
        }
        self.reservation = u32::MAX;
        self.update_translation();
    }

    /// Recompute which accesses need translating; call after any change to priv, mstatus or satp.
    pub(crate) fn update_translation(&mut self) {
        let paging = self.satp & SATP_MODE_SV32 != 0;
        self.data_priv = if self.priv_ == PRIV_M && self.mstatus & MSTATUS_MPRV != 0 {
            (self.mstatus & MSTATUS_MPP) >> MSTATUS_MPP_SHIFT
        } else {
            self.priv_
        };
        self.translate_fetch = paging && self.priv_ != PRIV_M;
        self.translate_data = paging && self.data_priv != PRIV_M;
    }

    /// Execute one instruction (a compressed one expanded); returns the next
    /// pc, `next_pc` unless it jumps.
    ///
    /// With the C extension, instructions only need 2-byte alignment, and no
    /// jump can produce an odd target (JALR clears bit 0, offsets are even),
    /// so there are no instruction-address-misaligned exceptions.
    #[inline(always)]
    fn execute(&mut self, inst: u32, pc: u32, mut next_pc: u32) -> Result<u32> {
        let opcode = inst & 0x7f;
        let rd = ((inst >> 7) & 0x1f) as usize;
        let funct3 = (inst >> 12) & 0x7;
        let rs1 = ((inst >> 15) & 0x1f) as usize;
        let rs2 = ((inst >> 20) & 0x1f) as usize;
        let funct7 = inst >> 25;

        match opcode {
            LUI => self.x[rd] = (inst & 0xfffff000) as i32,

            AUIPC => self.x[rd] = pc.wrapping_add(inst & 0xfffff000) as i32,

            JAL => {
                self.x[rd] = next_pc as i32;
                next_pc = pc.wrapping_add(imm_j(inst) as u32);
            }

            JALR => {
                if funct3 != 0 {
                    return Err(illegal(inst));
                }
                let target = (self.x[rs1].wrapping_add(imm_i(inst)) & !1) as u32;
                self.x[rd] = next_pc as i32;
                next_pc = target;
            }

            BRANCH => {
                let a = self.x[rs1];
                let b = self.x[rs2];
                let taken = match funct3 {
                    0b000 => a == b,                     // BEQ
                    0b001 => a != b,                     // BNE
                    0b100 => a < b,                      // BLT
                    0b101 => a >= b,                     // BGE
                    0b110 => (a as u32) < (b as u32),    // BLTU
                    0b111 => (a as u32) >= (b as u32),   // BGEU
                    _ => return Err(illegal(inst)),
                };
                if taken {
                    next_pc = pc.wrapping_add(imm_b(inst) as u32);
                }
            }

            LOAD => {
                let addr = self.x[rs1].wrapping_add(imm_i(inst)) as u32;
                self.x[rd] = match funct3 {
                    0b000 => self.load8(addr)? as i8 as i32,   // LB
                    0b001 => self.load16(addr)? as i16 as i32, // LH
                    0b010 => self.load32(addr)? as i32,        // LW
                    0b100 => self.load8(addr)? as i32,         // LBU
                    0b101 => self.load16(addr)? as i32,        // LHU
                    _ => return Err(illegal(inst)),
                };
            }

            STORE => {
                let addr = self.x[rs1].wrapping_add(imm_s(inst)) as u32;
                let value = self.x[rs2] as u32;
                match funct3 {
                    0b000 => self.store8(addr, value)?,  // SB
                    0b001 => self.store16(addr, value)?, // SH
                    0b010 => self.store32(addr, value)?, // SW
                    _ => return Err(illegal(inst)),
                }
            }

            OP_IMM => {
                let a = self.x[rs1];
                let imm = imm_i(inst);
                let shamt = (imm & 0x1f) as u32;
                self.x[rd] = match funct3 {
                    0b000 => a.wrapping_add(imm),                           // ADDI
                    0b010 => (a < imm) as i32,                              // SLTI
                    0b011 => ((a as u32) < (imm as u32)) as i32,            // SLTIU
                    0b100 => a ^ imm,                                       // XORI
                    0b110 => a | imm,                                       // ORI
                    0b111 => a & imm,                                       // ANDI
                    0b001 if funct7 == 0 => a << shamt,                     // SLLI
                    0b101 if funct7 == 0x00 => ((a as u32) >> shamt) as i32, // SRLI
                    0b101 if funct7 == 0x20 => a >> shamt,                  // SRAI
                    _ => return Err(illegal(inst)),
                };
            }

            OP => {
                let a = self.x[rs1];
                let b = self.x[rs2];
                let shamt = (b & 0x1f) as u32;
                self.x[rd] = match funct7 << 3 | funct3 {
                    0x000 => a.wrapping_add(b),                          // ADD
                    0x100 => a.wrapping_sub(b),                          // SUB
                    0x001 => a << shamt,                                 // SLL
                    0x002 => (a < b) as i32,                             // SLT
                    0x003 => ((a as u32) < (b as u32)) as i32,           // SLTU
                    0x004 => a ^ b,                                      // XOR
                    0x005 => ((a as u32) >> shamt) as i32,               // SRL
                    0x105 => a >> shamt,                                 // SRA
                    0x006 => a | b,                                      // OR
                    0x007 => a & b,                                      // AND
                    // RV32M
                    0x008 => a.wrapping_mul(b),                                         // MUL
                    0x009 => ((a as i64 * b as i64) >> 32) as i32,                      // MULH
                    0x00a => ((a as i64 * b as u32 as i64) >> 32) as i32,               // MULHSU
                    0x00b => ((a as u32 as u64 * b as u32 as u64) >> 32) as i32,        // MULHU
                    // Division by zero and overflow have defined results, no trap.
                    0x00c => if b == 0 { -1 } else { a.wrapping_div(b) },               // DIV
                    0x00d => if b == 0 { -1 } else { (a as u32 / b as u32) as i32 },    // DIVU
                    0x00e => if b == 0 { a } else { a.wrapping_rem(b) },                // REM
                    0x00f => if b == 0 { a } else { (a as u32 % b as u32) as i32 },     // REMU
                    _ => return Err(illegal(inst)),
                };
            }

            AMO => {
                if funct3 != 0b010 {
                    return Err(illegal(inst));
                }
                self.amo(inst, rd, self.x[rs1] as u32, self.x[rs2] as u32)?;
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
                    self.csr_instruction(inst, rd, funct3, rs1)?;
                }
            }

            _ => return Err(illegal(inst)),
        }
        Ok(next_pc)
    }

    /// ECALL / EBREAK / MRET / SRET / WFI / SFENCE.VMA; returns the next pc.
    fn system(&mut self, inst: u32, pc: u32, next_pc: u32) -> Result<u32> {
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
                let mpp = (self.mstatus & MSTATUS_MPP) >> MSTATUS_MPP_SHIFT;
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

    fn csr_instruction(&mut self, inst: u32, rd: usize, funct3: u32, rs1: usize) -> Result<()> {
        let csr = inst >> 20;
        if self.priv_ < (csr >> 8) & 3 {
            return Err(illegal(inst));
        }

        let op = funct3 & 3; // 1 = write, 2 = set, 3 = clear
        if op == 0 {
            return Err(illegal(inst));
        }
        let src = if funct3 & 4 != 0 { rs1 as u32 } else { self.x[rs1] as u32 }; // CSRR*I take a 5-bit immediate
        let writes = op == 1 || rs1 != 0; // CSRRS/CSRRC with x0/0 only read
        if writes && csr >> 10 == 3 {
            return Err(illegal(inst)); // read-only CSR
        }

        let old = self.read_csr(csr, inst)?;
        if writes {
            self.write_csr(csr, match op { 1 => src, 2 => old | src, _ => old & !src });
        }
        self.x[rd] = old as i32;
        Ok(())
    }

    fn read_csr(&mut self, csr: u32, inst: u32) -> Result<u32> {
        Ok(match csr {
            MSTATUS => self.mstatus,
            MISA => MISA_VALUE,
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
            MSTATUSH | MCOUNTINHIBIT | MVENDORID | MARCHID | MIMPID | MHARTID | MCONFIGPTR => 0,

            SSTATUS => self.mstatus & SSTATUS_MASK,
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

            MCYCLE | MINSTRET => self.instret as u32,
            MCYCLEH | MINSTRETH => (self.instret >> 32) as u32,
            CYCLE | INSTRET | CYCLEH | INSTRETH => {
                self.check_counter_access(csr, inst)?;
                if csr & 0x80 != 0 { (self.instret >> 32) as u32 } else { self.instret as u32 }
            }
            TIME | TIMEH => {
                if !self.has_time {
                    return Err(illegal(inst));
                }
                self.check_counter_access(csr, inst)?;
                let time = self.time();
                if csr == TIME { time as u32 } else { (time >> 32) as u32 }
            }
            PMPCFG0..=PMPADDR63 => 0, // no PMP entries
            _ => return Err(illegal(inst)),
        })
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

    fn write_csr(&mut self, csr: u32, value: u32) {
        match csr {
            MSTATUS => {
                let mut v = value & MSTATUS_WRITABLE;
                if v & MSTATUS_MPP == 2 << MSTATUS_MPP_SHIFT {
                    v &= !MSTATUS_MPP; // no H-mode: 2 → U
                }
                self.mstatus = v;
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
                self.mstatus = (self.mstatus & !SSTATUS_MASK) | (value & SSTATUS_MASK);
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
                // Sv32 or bare; no ASIDs (ASIDLEN = 0, so those bits read as zero).
                self.satp = value & (SATP_MODE_SV32 | SATP_PPN);
                self.flush_tlb();
                self.update_translation();
            }
            // Everything else that reads successfully is WARL read-only here:
            // counters can't be rewritten, no PMP.
            _ => {}
        }
    }

    fn amo(&mut self, inst: u32, rd: usize, vaddr: u32, src: u32) -> Result<()> {
        let op = inst >> 27;
        let lr = op == 0b00010;
        if vaddr & 3 != 0 {
            return Err(Trap::new(if lr { LOAD_ADDRESS_MISALIGNED } else { STORE_ADDRESS_MISALIGNED }, vaddr));
        }
        let access = if lr { Access::Load } else { Access::Store };
        let addr = if self.translate_data { self.translate(vaddr, access, self.data_priv)? } else { vaddr };
        // AMOs (and SC) report store faults, even for their read half.
        let fault = Trap::new(access.access_fault(), addr);

        if lr {
            self.x[rd] = self.phys_read(addr, 4).ok_or(fault)? as i32;
            self.reservation = addr;
            return Ok(());
        }
        if op == 0b00011 {
            // SC.W
            let ok = self.reservation == addr;
            self.reservation = u32::MAX;
            if ok && !self.phys_write(addr, 4, src) {
                return Err(fault);
            }
            self.x[rd] = !ok as i32;
            return Ok(());
        }

        let old = self.phys_read(addr, 4).ok_or(fault)?;
        let value = match op {
            0b00001 => src,                                         // AMOSWAP.W
            0b00000 => old.wrapping_add(src),                       // AMOADD.W
            0b00100 => old ^ src,                                   // AMOXOR.W
            0b01100 => old & src,                                   // AMOAND.W
            0b01000 => old | src,                                   // AMOOR.W
            0b10000 => (old as i32).min(src as i32) as u32,         // AMOMIN.W
            0b10100 => (old as i32).max(src as i32) as u32,         // AMOMAX.W
            0b11000 => old.min(src),                                // AMOMINU.W
            0b11100 => old.max(src),                                // AMOMAXU.W
            _ => return Err(illegal(inst)),
        };
        if !self.phys_write(addr, 4, value) {
            return Err(fault);
        }
        self.x[rd] = old as i32;
        Ok(())
    }
}

const fn illegal(inst: u32) -> Trap {
    Trap::new(ILLEGAL_INSTRUCTION, inst)
}

/// xtvec is direct (mode 0) or vectored (mode 1).
const fn tvec(value: u32) -> u32 {
    if value & 3 != 0 { (value & !3) | 1 } else { value }
}

/// Trap target: vectored mode sends interrupts to base + 4 × cause.
const fn vector(tvec: u32, cause: u32, interrupt: bool) -> u32 {
    let base = tvec & !3;
    if interrupt && tvec & 3 == 1 { base.wrapping_add(4 * cause) } else { base }
}

// Immediate decoders. All return sign-extended values.
const fn imm_i(i: u32) -> i32 {
    i as i32 >> 20
}
const fn imm_s(i: u32) -> i32 {
    (i as i32 >> 25) << 5 | ((i >> 7) & 0x1f) as i32
}
const fn imm_b(i: u32) -> i32 {
    (i as i32 >> 31) << 12 | (((i >> 7) & 1) << 11 | ((i >> 25) & 0x3f) << 5 | ((i >> 8) & 0xf) << 1) as i32
}
const fn imm_j(i: u32) -> i32 {
    (i as i32 >> 31) << 20 | (((i >> 12) & 0xff) << 12 | ((i >> 20) & 1) << 11 | ((i >> 21) & 0x3ff) << 1) as i32
}
