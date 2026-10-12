//! RV64GC hart (IMAFDC, Zicsr, Zifencei) with machine, supervisor and user
//! privilege modes and virtual memory (Sv39). Floating point is in fpu.rs.
//!
//! Exceptions and interrupts are taken architecturally: into M-mode
//! (mepc/mcause/mtval, mtvec), or into S-mode when delegated through
//! medeleg/mideleg (sepc/scause/stval, stvec).

use crate::blocks::{Block, Code, FETCH_CACHE, NO_CODE, Op};
use crate::jit::{ChainEntry, JIT_TLB_EMPTY, Jit, JitTlbEntry};
use crate::csr::*;
use crate::memory::Access;
use crate::mmu::{DATA_LOAD_OK, DATA_STORE_OK, Paging, TLB_EMPTY, TLB_SIZE};
use crate::rvc;

/// A synchronous exception: aborts the instruction, then the hart enters the
/// trap handler. `tval` is the value the spec puts in mtval/stval.
#[derive(Clone, Copy, Debug)]
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
pub(crate) const STOP_AT_BREAKPOINT: u32 = u32::MAX;

/// Why `run()` returned (src/cpu.ts maps these to its StopReason names).
pub const LIMIT: u32 = 0;
pub const WFI_STALL: u32 = 1;
pub const STOPPED_AT_BREAKPOINT: u32 = 2;
pub const STOPPED: u32 = 3;

/// misa: MXL = 2 (64-bit), extensions A, C, D, F, I, M, S, U.
const MISA_VALUE: u64 = 2 << 62 | 1 << 0 | 1 << 2 | 1 << 3 | 1 << 5 | 1 << 8 | 1 << 12 | 1 << 18 | 1 << 20;

const MSTATUS_WRITABLE: u64 = MSTATUS_SIE | MSTATUS_MIE | MSTATUS_SPIE | MSTATUS_MPIE | MSTATUS_SPP
    | MSTATUS_MPP | MSTATUS_FS | MSTATUS_MPRV | MSTATUS_SUM | MSTATUS_MXR | MSTATUS_TVM | MSTATUS_TW
    | MSTATUS_TSR;
/// The part of mstatus writable through sstatus...
const SSTATUS_WRITABLE: u64 = MSTATUS_SIE | MSTATUS_SPIE | MSTATUS_SPP | MSTATUS_FS | MSTATUS_SUM | MSTATUS_MXR;
/// ...and visible through it (also UXL; SD is added when read).
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
// Floating point (fpu.rs)
const LOAD_FP: u32 = 0x07;
const STORE_FP: u32 = 0x27;
const FMADD: u32 = 0x43;
const FMSUB: u32 = 0x47;
const FNMSUB: u32 = 0x4b;
const FNMADD: u32 = 0x4f;
const OP_FP: u32 = 0x53;
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
    /// x0..x31; x0 is re-zeroed after every instruction. (The 33rd is where
    /// decoded instructions write x0: blocks::SINK.)
    pub x: [u64; 33],
    pub pc: u64,
    pub priv_: u32,
    /// mhartid.
    pub id: u64,
    /// f0..f31 (single-precision values NaN-boxed), and fcsr's two fields.
    pub f: [u64; 32],
    pub fflags: u32,
    pub frm: u32,

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
    /// Physical address reserved by LR, and the value it read (SC succeeds
    /// if memory still holds it).
    reservation: u64,
    reserved_value: u64,

    /// RAM: `ram_size` bytes at `ram`, at physical address `ram_base`.
    pub(crate) ram: *mut u8,
    pub(crate) ram_base: u64,
    pub(crate) ram_size: u64,

    pub(crate) tlb_vpn: [u64; TLB_SIZE],
    pub(crate) tlb_ppn: [u32; TLB_SIZE],
    pub(crate) tlb_flags: [u8; TLB_SIZE],
    /// Whether loads / stores may use the entry, as last checked (mmu.rs: translate_data).
    pub(crate) tlb_ok: [u8; TLB_SIZE],
    /// The context loads and stores are checked in: the data privilege, SUM
    /// and MXR, in tlb_ok's format.
    pub(crate) data_ok_tag: u8,
    /// Superpages that may be cached (in the TLBs and the fetch cache, a 4
    /// KiB page each) since the last full flush: bit (vaddr >> 30) % 512 for
    /// gigapages, (vaddr >> 21) % 4096 for megapages.
    pub(crate) gigapages: [u64; 8],
    pub(crate) megapages: [u64; 64],
    /// The JIT's TLB (jit.rs), and the context its entries are tagged with
    /// (the data translation context, and the TLB's epoch).
    pub(crate) jit_tlb: [JitTlbEntry; TLB_SIZE],
    pub(crate) jit_ctx: u64,
    pub(crate) jit: Jit,
    /// Where compiled code finds the compiled code for a pc it jumps to
    /// (jit.rs), and the context its entries are tagged with (an epoch
    /// bumped when compiled code changes).
    pub(crate) chain: Vec<ChainEntry>,
    pub(crate) chain_ctx: u64,

    // The decoded-instruction cache (blocks.rs), set up with the RAM.
    pub(crate) blocks: Vec<Block>,
    pub(crate) ops: Vec<Op>,
    pub(crate) ops_used: usize,
    /// Fetch translations for blocks (blocks.rs: FETCH_CACHE): virtual pages
    /// with the context (fetch_ctx: privilege, and an epoch bumped by TLB
    /// flushes) in the low bits, and their physical pages.
    pub(crate) fetch_tags: [u64; FETCH_CACHE],
    pub(crate) fetch_pages: [u32; FETCH_CACHE],
    pub(crate) fetch_ctx: u64,
    /// What's known about code in RAM (shared by all harts), and its epoch
    /// when this hart last looked.
    pub(crate) code: &'static Code,
    pub(crate) code_epoch: u32,
}

impl Hart {
    pub const fn new() -> Hart {
        Hart {
            x: [0; 33],
            pc: 0,
            priv_: PRIV_M,
            id: 0,
            f: [0; 32],
            fflags: 0,
            frm: 0,
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
            reservation: NO_RESERVATION,
            reserved_value: 0,
            ram: core::ptr::null_mut(),
            ram_base: 0,
            ram_size: 0,
            tlb_vpn: [TLB_EMPTY; TLB_SIZE],
            tlb_ppn: [0; TLB_SIZE],
            tlb_flags: [0; TLB_SIZE],
            tlb_ok: [0; TLB_SIZE],
            data_ok_tag: 0,
            jit_tlb: [JIT_TLB_EMPTY; TLB_SIZE],
            gigapages: [0; 8],
            megapages: [0; 64],
            jit_ctx: 0,
            jit: Jit::new(),
            chain: Vec::new(),
            chain_ctx: 1,
            blocks: Vec::new(),
            ops: Vec::new(),
            ops_used: 0,
            fetch_tags: [TLB_EMPTY; FETCH_CACHE],
            fetch_pages: [0; FETCH_CACHE],
            fetch_ctx: 0,
            code: &NO_CODE,
            code_epoch: 0,
        }
    }

    /// Return to the power-on state and start executing at `pc`.
    pub fn reset(&mut self, pc: u64) {
        self.x = [0; 33];
        self.f = [0; 32];
        self.fflags = 0;
        self.frm = 0;
        self.pc = pc;
        self.priv_ = PRIV_M;
        self.mstatus = MSTATUS_UXL_SXL_64;
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
        self.flush_blocks(); // RAM was (re)loaded without the hart seeing it
        self.code.clear();
        self.update_translation();
    }

    /// Execute up to `max_steps` steps (instructions or trap entries): whole
    /// decoded blocks where possible (blocks.rs), else one at a time.
    pub fn run(&mut self, max_steps: u32) -> u32 {
        self.stop_reason = 0;
        let mut remaining = max_steps;
        while remaining > 0 {
            if self.waiting && self.mip & self.mie == 0 {
                return WFI_STALL;
            }
            match self.run_block(remaining) {
                0 => {
                    self.step();
                    remaining -= 1;
                }
                steps => remaining -= steps,
            }
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
                match self.execute(inst, pc, pc.wrapping_add(length)) {
                    // An illegal compressed instruction reports its own 16 bits.
                    Err(trap) if trap.cause == ILLEGAL_INSTRUCTION && length == 2 => Err(illegal(word & 0xffff)),
                    result => result,
                }
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
            Err(trap) => self.enter_trap(trap.cause, false, pc, trap.tval),
        }
    }

    /// Take the highest-priority pending interrupt that is enabled at the current
    /// privilege: non-delegated ones trap to M-mode (enabled below M, or in M with
    /// MIE), delegated ones to S-mode (enabled in U, or in S with SIE; never in M).
    fn take_interrupt(&mut self, pending: u64) -> bool {
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

    pub(crate) fn enter_trap(&mut self, cause: u32, interrupt: bool, epc: u64, tval: u64) {
        let delegated = (if interrupt { self.mideleg } else { self.medeleg }) & (1 << cause) != 0;
        let cause_value = if interrupt { 1 << 63 | cause as u64 } else { cause as u64 };
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
        self.fetch_ctx = self.fetch_ctx & !3 | self.priv_ as u64;
        self.paging = if self.satp >> SATP_MODE_SHIFT == SATP_MODE_SV39 { Paging::Sv39 } else { Paging::Bare };
        let paging = self.paging != Paging::Bare;
        self.data_priv = if self.priv_ == PRIV_M && self.mstatus & MSTATUS_MPRV != 0 {
            ((self.mstatus & MSTATUS_MPP) >> MSTATUS_MPP_SHIFT) as u32
        } else {
            self.priv_
        };
        self.translate_fetch = paging && self.priv_ != PRIV_M;
        self.translate_data = paging && self.data_priv != PRIV_M;
        // Nonzero, and never with the ok bits set.
        let sum = if self.mstatus & MSTATUS_SUM != 0 { 4 } else { 0 };
        let mxr = if self.mstatus & MSTATUS_MXR != 0 { 8 } else { 0 };
        let context = self.data_priv as u8 | sum | mxr;
        self.data_ok_tag = (context | 0x10) << 2 & !(DATA_LOAD_OK | DATA_STORE_OK);
        self.update_jit_ctx();
    }

    /// Execute one instruction (a compressed one expanded); returns the next
    /// pc, `next_pc` unless it jumps.
    ///
    /// With the C extension, instructions only need 2-byte alignment, and no
    /// jump can produce an odd target (JALR clears bit 0, offsets are even),
    /// so there are no instruction-address-misaligned exceptions.
    #[inline(always)]
    fn execute(&mut self, inst: u32, pc: u64, mut next_pc: u64) -> Result<u64> {
        let opcode = inst & 0x7f;
        let rd = ((inst >> 7) & 0x1f) as usize;
        let funct3 = (inst >> 12) & 0x7;
        let rs1 = ((inst >> 15) & 0x1f) as usize;
        let rs2 = ((inst >> 20) & 0x1f) as usize;
        let funct7 = inst >> 25;

        match opcode {
            LUI => self.x[rd] = sext32((inst & 0xfffff000) as u64),

            AUIPC => self.x[rd] = pc.wrapping_add(sext32((inst & 0xfffff000) as u64)),

            JAL => {
                self.x[rd] = next_pc;
                next_pc = pc.wrapping_add(imm_j(inst));
            }

            JALR => {
                if funct3 != 0 {
                    return Err(illegal(inst));
                }
                let target = self.x[rs1].wrapping_add(imm_i(inst)) & !1;
                self.x[rd] = next_pc;
                next_pc = target;
            }

            BRANCH => {
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
                    next_pc = pc.wrapping_add(imm_b(inst));
                }
            }

            LOAD => {
                let addr = self.x[rs1].wrapping_add(imm_i(inst));
                let value = match funct3 {
                    0b000 => self.load(addr, 1)? as i8 as u64,  // LB
                    0b001 => self.load(addr, 2)? as i16 as u64, // LH
                    0b010 => self.load(addr, 4)? as i32 as u64, // LW
                    0b011 => self.load(addr, 8)?,               // LD
                    0b100 => self.load(addr, 1)?,               // LBU
                    0b101 => self.load(addr, 2)?,               // LHU
                    0b110 => self.load(addr, 4)?,               // LWU
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = value;
            }

            STORE => {
                let addr = self.x[rs1].wrapping_add(imm_s(inst));
                let width = match funct3 {
                    0b000 => 1,        // SB
                    0b001 => 2,        // SH
                    0b010 => 4,        // SW
                    0b011 => 8, // SD
                    _ => return Err(illegal(inst)),
                };
                self.store(addr, width, self.x[rs2])?;
            }

            OP_IMM => {
                let a = self.x[rs1];
                let imm = imm_i(inst);
                // Shifts: 6-bit amounts, and a 6-bit funct above them.
                let shamt = (inst >> 20) & 0x3f;
                let shift_funct = inst >> 26;
                let value = match funct3 {
                    0b000 => a.wrapping_add(imm),                               // ADDI
                    0b010 => ((a as i64) < (imm as i64)) as u64,                // SLTI
                    0b011 => (a < imm) as u64,                                  // SLTIU
                    0b100 => a ^ imm,                                           // XORI
                    0b110 => a | imm,                                           // ORI
                    0b111 => a & imm,                                           // ANDI
                    0b001 if shift_funct == 0 => a << shamt,                    // SLLI
                    0b101 if shift_funct == 0 => a >> shamt,                    // SRLI
                    0b101 if shift_funct == 0x10 => ((a as i64) >> shamt) as u64, // SRAI
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = value;
            }

            OP => {
                let a = self.x[rs1];
                let b = self.x[rs2];
                let shamt = b & 0x3f;
                let value = match funct7 << 3 | funct3 {
                    0x000 => a.wrapping_add(b),                // ADD
                    0x100 => a.wrapping_sub(b),                // SUB
                    0x001 => a << shamt,                       // SLL
                    0x002 => ((a as i64) < (b as i64)) as u64, // SLT
                    0x003 => (a < b) as u64,                   // SLTU
                    0x004 => a ^ b,                            // XOR
                    0x005 => a >> shamt,                       // SRL
                    0x105 => ((a as i64) >> shamt) as u64,     // SRA
                    0x006 => a | b,                            // OR
                    0x007 => a & b,                            // AND
                    // M extension
                    0x008 => a.wrapping_mul(b),                // MUL
                    0x009 => mulh(a, b),                       // MULH
                    0x00a => mulhsu(a, b),                     // MULHSU
                    0x00b => mulhu(a, b),                      // MULHU
                    0x00c => div(a, b),                        // DIV
                    0x00d => divu(a, b),                       // DIVU
                    0x00e => rem(a, b),                        // REM
                    0x00f => remu(a, b),                       // REMU
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = value;
            }

            // 32-bit operations (the *W instructions), results sign-extended.
            OP_IMM_32 => {
                let a = self.x[rs1] as u32;
                let shamt = (inst >> 20) & 0x1f;
                let value = match funct3 {
                    0b000 => a.wrapping_add(imm_i(inst) as u32),     // ADDIW
                    0b001 if funct7 == 0 => a << shamt,               // SLLIW
                    0b101 if funct7 == 0 => a >> shamt,               // SRLIW
                    0b101 if funct7 == 0x20 => ((a as i32) >> shamt) as u32, // SRAIW
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = value as i32 as u64;
            }

            OP_32 => {
                let a = self.x[rs1] as u32;
                let b = self.x[rs2] as u32;
                let shamt = b & 0x1f;
                let value = match funct7 << 3 | funct3 {
                    0x000 => a.wrapping_add(b),              // ADDW
                    0x100 => a.wrapping_sub(b),              // SUBW
                    0x001 => a << shamt,                     // SLLW
                    0x005 => a >> shamt,                     // SRLW
                    0x105 => ((a as i32) >> shamt) as u32,   // SRAW
                    0x008 => a.wrapping_mul(b),              // MULW
                    0x00c => div32(a, b),                    // DIVW
                    0x00d => divu32(a, b),                   // DIVUW
                    0x00e => rem32(a, b),                    // REMW
                    0x00f => remu32(a, b),                   // REMUW
                    _ => return Err(illegal(inst)),
                };
                self.x[rd] = value as i32 as u64;
            }

            AMO => {
                let width = match funct3 {
                    0b010 => 4,
                    0b011 => 8,
                    _ => return Err(illegal(inst)),
                };
                self.amo(inst, rd, self.x[rs1], self.x[rs2], width)?;
            }

            // FENCE / FENCE.I: a single in-order hart with no caches has nothing to do.
            MISC_MEM => {
                if funct3 > 0b001 {
                    return Err(illegal(inst));
                }
            }

            LOAD_FP | STORE_FP | FMADD | FMSUB | FNMSUB | FNMADD | OP_FP => self.execute_fp(inst)?,

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

    /// `execute`, not inlined: for the decoded blocks' less common instructions.
    #[inline(never)]
    pub(crate) fn execute_generic(&mut self, inst: u32, pc: u64, next_pc: u64) -> Result<u64> {
        self.execute(inst, pc, next_pc)
    }

    /// ECALL / EBREAK / MRET / SRET / WFI / SFENCE.VMA; returns the next pc.
    fn system(&mut self, inst: u32, pc: u64, next_pc: u64) -> Result<u64> {
        if inst & 0xfe007fff == SFENCE_VMA {
            if self.priv_ == PRIV_U || (self.priv_ == PRIV_S && self.mstatus & MSTATUS_TVM != 0) {
                return Err(illegal(inst));
            }
            // No ASIDs: rs2 doesn't matter.
            match (inst >> 15) & 0x1f {
                0 => self.flush_tlb(),
                rs1 => self.flush_tlb_page(self.x[rs1 as usize]),
            }
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

    fn csr_instruction(&mut self, inst: u32, rd: usize, funct3: u32, rs1: usize) -> Result<()> {
        let csr = inst >> 20;
        if self.priv_ < (csr >> 8) & 3 {
            return Err(illegal(inst));
        }

        let op = funct3 & 3; // 1 = write, 2 = set, 3 = clear
        if op == 0 {
            return Err(illegal(inst));
        }
        // CSRR*I take a 5-bit immediate.
        let src = if funct3 & 4 != 0 { rs1 as u64 } else { self.x[rs1] };
        let writes = op == 1 || rs1 != 0; // CSRRS/CSRRC with x0/0 only read
        if writes && csr >> 10 == 3 {
            return Err(illegal(inst)); // read-only CSR
        }

        let old = self.read_csr(csr, inst)?;
        if writes {
            self.write_csr(csr, match op { 1 => src, 2 => old | src, _ => old & !src });
        }
        self.x[rd] = old;
        Ok(())
    }

    fn read_csr(&mut self, csr: u32, inst: u32) -> Result<u64> {
        let value = match csr {
            FFLAGS | FRM | FCSR => self.read_fcsr(csr).ok_or(illegal(inst))?,
            MSTATUS => self.mstatus | self.state_dirty(),
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
            MHARTID => self.id,
            MCOUNTINHIBIT | MVENDORID | MARCHID | MIMPID | MCONFIGPTR => 0,

            SSTATUS => self.mstatus & SSTATUS_VISIBLE | self.state_dirty(),
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
            CYCLE | INSTRET => {
                self.check_counter_access(csr, inst)?;
                self.retired.wrapping_add(if csr == CYCLE { self.cycle_offset } else { self.instret_offset })
            }
            TIME => {
                self.check_time_access(csr, inst)?;
                self.time()
            }
            PMPCFG0..=PMPADDR63 => 0, // no PMP entries
            TSELECT..=TDATA3 => 0,    // no debug triggers
            _ => return Err(illegal(inst)),
        };
        Ok(value)
    }

    /// mstatus.SD (the top bit): some extension state (here only FP) is dirty.
    fn state_dirty(&self) -> u64 {
        if self.mstatus & MSTATUS_FS == MSTATUS_FS { 1 << 63 } else { 0 }
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

    fn write_csr(&mut self, csr: u32, value: u64) {
        match csr {
            FFLAGS | FRM | FCSR => self.write_fcsr(csr, value), // readable, so FP is on
            MSTATUS => {
                let mut v = value & MSTATUS_WRITABLE;
                if v & MSTATUS_MPP == 2 << MSTATUS_MPP_SHIFT {
                    v &= !MSTATUS_MPP; // no H-mode: 2 → U
                }
                self.mstatus = v | MSTATUS_UXL_SXL_64;
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
                // No ASIDs (ASIDLEN = 0, so those bits read as zero). A write
                // selecting an unsupported mode (Sv48, Sv57) has no effect at
                // all: that's how Linux finds out which it may use.
                let mode = value >> SATP_MODE_SHIFT;
                if mode != 0 && mode != SATP_MODE_SV39 {
                    return;
                }
                self.satp = value & (0xf << SATP_MODE_SHIFT | SATP_PPN);
                self.flush_tlb();
                self.update_translation();
            }

            // The counters count on from what software writes. The writing
            // instruction itself isn't counted (the next reads the value written).
            MCYCLE | MINSTRET => {
                let retired = self.retired;
                let offset = if csr == MINSTRET { &mut self.instret_offset } else { &mut self.cycle_offset };
                *offset = value.wrapping_sub(retired + 1);
            }
            // Everything else that reads successfully is WARL read-only here:
            // no PMP, no debug triggers, counters can't be inhibited.
            _ => {}
        }
    }

    /// LR / SC / AMO*, on 4 (.W) or 8 (.D) bytes. .W values are sign-extended.
    fn amo(&mut self, inst: u32, rd: usize, vaddr: u64, src: u64, width: u32) -> Result<()> {
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
            self.x[rd] = extend(value);
            self.reservation = pa;
            self.reserved_value = value;
            return Ok(());
        }
        if op == 0b00011 {
            // SC: in RAM, only if memory still holds what LR read (another
            // hart may have written it since; writing the same value back
            // goes unnoticed, which software can't tell from an SC that
            // came first).
            let reserved = self.reservation == pa;
            self.reservation = NO_RESERVATION;
            let ok = match self.ram_offset(pa, width) {
                Some(offset) if reserved => {
                    let done = self.ram_compare_exchange(offset, width, self.reserved_value, src);
                    if done {
                        self.code_written(offset as u64, width as u64);
                    }
                    done
                }
                _ if reserved => self.phys_write(pa, width, src) || return Err(fault),
                _ => false,
            };
            self.x[rd] = !ok as u64;
            return Ok(());
        }
        if let Some(offset) = self.ram_offset(pa, width) {
            let old = self.ram_amo(offset, width, op, src).ok_or_else(|| illegal(inst))?;
            self.code_written(offset as u64, width as u64);
            self.x[rd] = extend(old);
            return Ok(());
        }

        let old = self.phys_read(pa, width).ok_or(fault)?;
        // Compare as 64- or 32-bit values: sign-extend both to 64 bits.
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
        self.x[rd] = a;
        Ok(())
    }
}

/// Sign-extend from 32 bits.
#[inline(always)]
pub(crate) const fn sext32(v: u64) -> u64 {
    v as i32 as i64 as u64
}

// M extension: the upper half of a 128-bit product, and division (by zero
// and overflowing ones have defined results, no trap), 64-bit and, for the
// *W instructions, 32-bit.
#[inline(always)]
fn mulh(a: u64, b: u64) -> u64 {
    ((a as i64 as i128 * b as i64 as i128) >> 64) as u64
}
#[inline(always)]
fn mulhsu(a: u64, b: u64) -> u64 {
    ((a as i64 as i128 * b as i128) >> 64) as u64
}
#[inline(always)]
fn mulhu(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) >> 64) as u64
}
#[inline(always)]
fn div(a: u64, b: u64) -> u64 {
    if b == 0 { u64::MAX } else { (a as i64).wrapping_div(b as i64) as u64 }
}
#[inline(always)]
fn divu(a: u64, b: u64) -> u64 {
    a.checked_div(b).unwrap_or(u64::MAX)
}
#[inline(always)]
fn rem(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { (a as i64).wrapping_rem(b as i64) as u64 }
}
#[inline(always)]
fn remu(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { a % b }
}
#[inline(always)]
fn div32(a: u32, b: u32) -> u32 {
    if b == 0 { u32::MAX } else { (a as i32).wrapping_div(b as i32) as u32 }
}
#[inline(always)]
fn divu32(a: u32, b: u32) -> u32 {
    a.checked_div(b).unwrap_or(u32::MAX)
}
#[inline(always)]
fn rem32(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { (a as i32).wrapping_rem(b as i32) as u32 }
}
#[inline(always)]
fn remu32(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { a % b }
}

pub(crate) const fn illegal(inst: u32) -> Trap {
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
pub(crate) const fn imm_i(i: u32) -> u64 {
    (i as i32 >> 20) as u64
}
pub(crate) const fn imm_s(i: u32) -> u64 {
    ((i as i32 >> 25) << 5 | ((i >> 7) & 0x1f) as i32) as u64
}
const fn imm_b(i: u32) -> u64 {
    ((i as i32 >> 31) << 12 | (((i >> 7) & 1) << 11 | ((i >> 25) & 0x3f) << 5 | ((i >> 8) & 0xf) << 1) as i32) as u64
}
const fn imm_j(i: u32) -> u64 {
    ((i as i32 >> 31) << 20 | (((i >> 12) & 0xff) << 12 | ((i >> 20) & 1) << 11 | ((i >> 21) & 0x3ff) << 1) as i32) as u64
}
