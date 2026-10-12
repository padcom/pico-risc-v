//! The decoded-instruction cache: basic blocks of pre-decoded instructions.
//!
//! A block is the instructions from some address up to the next jump or
//! system instruction, within one page (at most `MAX_BLOCK` of them); a
//! conditional branch leaves it when taken. It's
//! decoded once, keyed by its physical address, then run as a tight loop: one
//! address translation and one interrupt check per block instead of per
//! instruction, no fetching, and decoding reduced to a lookup. Common integer
//! instructions run from their decoded form; everything else (floating
//! point, atomics, CSRs, ...) through the regular `execute`.
//!
//! The cache is coherent with memory, so correct software never sees stale
//! code, with or without FENCE.I: every page has a bit per 64-byte line that
//! holds cached code, and a write to such a line (by any hart, or by a device
//! through `code_written`) bumps the page's version, which retires all of its
//! blocks. Those are shared by all harts (`Code`); each has its own cache.
//!
//! `step()` doesn't use the cache: it's the reference interpreter, and `run()`
//! falls back to it for whatever a block can't do (a pending interrupt, a
//! fetch fault, code outside RAM, an instruction across a page boundary, the
//! last few steps of a budget).

use crate::csr::ILLEGAL_INSTRUCTION;
use crate::hart::{Hart, Result, STOPPED_AT_BREAKPOINT, STOP_AT_BREAKPOINT, Trap, illegal, imm_i, imm_s};
use crate::jit::COMPILED;
use crate::memory::Access;
use crate::rvc;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering::Relaxed};

/// Translations for fetches cached for blocks (direct mapped by virtual
/// page, tagged with the privilege), so jumps between pages mostly needn't
/// translate.
pub const FETCH_CACHE: usize = 256;

/// Blocks in the cache: sets of `WAYS` blocks, a set chosen by a hash of the
/// address.
pub const BLOCKS: usize = 1 << 20;
const WAYS: usize = 4;
const SET_BITS: u32 = (BLOCKS / WAYS).trailing_zeros();
/// Room for decoded instructions; when it's used up, the cache starts over.
pub const OPS: usize = 1 << 22;
/// The longest block.
const MAX_BLOCK: usize = 64;

#[derive(Clone, Copy)]
pub struct Block {
    /// Physical address of the first instruction (0: empty; RAM isn't at 0).
    pub(crate) pa: u64,
    /// The version of its page it was decoded from.
    pub(crate) version: u32,
    /// Its instructions: ops[start..start + count].
    pub(crate) start: u32,
    pub(crate) count: u32,
    /// How often it ran (up to 65535), or jit::COMPILED: then it's case
    /// `entry` of its page's function.
    pub(crate) jit: u32,
    pub(crate) entry: u32,
}

/// What's known about code in RAM, shared by all harts: per page, which of
/// its 64-byte lines hold code that some hart decoded (a bit each), and a
/// version, bumped when one of those is written (then the bits start over);
/// and an epoch, bumped with any version.
pub struct Code {
    pub(crate) lines: Vec<AtomicU64>,
    pub(crate) versions: Vec<AtomicU32>,
    pub(crate) epoch: AtomicU32,
}

/// For harts without RAM of their own (no cache).
pub static NO_CODE: Code = Code { lines: Vec::new(), versions: Vec::new(), epoch: AtomicU32::new(0) };

impl Code {
    pub fn new(pages: usize) -> Code {
        Code {
            lines: (0..pages).map(|_| AtomicU64::new(0)).collect(),
            versions: (0..pages).map(|_| AtomicU32::new(0)).collect(),
            epoch: AtomicU32::new(0),
        }
    }

    /// RAM at `offset..offset + len` (offsets into RAM) has been written:
    /// retire the blocks of every page where that hits a line with code.
    #[inline(always)]
    pub fn written(&self, offset: u64, len: u64) {
        if self.lines.is_empty() || len == 0 {
            return;
        }
        let (first, last) = (offset >> 6, (offset + len - 1) >> 6);
        for line in first..=last {
            let page = (line >> 6) as usize;
            if self.lines[page].load(Relaxed) & (1 << (line & 63)) != 0 {
                self.retire(page);
            }
        }
    }

    #[inline(never)]
    fn retire(&self, page: usize) {
        self.versions[page].fetch_add(1, Relaxed);
        self.lines[page].store(0, Relaxed);
        self.epoch.fetch_add(1, Relaxed);
    }

    /// Forget all code (RAM was reloaded).
    pub fn clear(&self) {
        for line in &self.lines {
            line.store(0, Relaxed);
        }
        self.epoch.fetch_add(1, Relaxed);
    }
}

pub const EMPTY_BLOCK: Block = Block { pa: 0, version: 0, start: 0, count: 0, jit: 0, entry: 0 };

/// A decoded instruction.
#[derive(Clone, Copy)]
pub struct Op {
    pub(crate) kind: Kind,
    /// The destination register; for x0, `SINK` (fast kinds only).
    pub(crate) rd: u8,
    pub(crate) rs1: u8,
    pub(crate) rs2: u8,
    /// 2 (compressed) or 4.
    pub(crate) len: u8,
    /// Loads, stores and `Execute*`: they may reach devices (which can read
    /// the instruction count and stop the CPU) or read the counters.
    pub(crate) sync: bool,
    /// The immediate, sign-extended from 32 bits when used (shift amounts for
    /// shifts). For `Execute` / `ExecuteEnd`: a compressed instruction's own
    /// 16 bits (an illegal-instruction trap reports those).
    pub(crate) imm: i32,
    /// The 32-bit instruction (expanded, if compressed), for `Execute`.
    inst: u32,
}

pub const NO_OP: Op = Op { kind: Kind::Execute, rd: 0, rs1: 0, rs2: 0, len: 0, sync: true, imm: 0, inst: 0 };

/// Where decoded instructions write x0: a spare register after x31, so x0
/// stays 0 without being cleared after each.
pub const SINK: u8 = 32;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Kind {
    Addi, Slti, Sltiu, Xori, Ori, Andi, Slli, Srli, Srai,
    Lui, Auipc,
    Add, Sub, Sll, Slt, Sltu, Xor, Srl, Sra, Or, And,
    Mul, Mulh, Mulhsu, Mulhu, Div, Divu, Rem, Remu,
    Addiw, Slliw, Srliw, Sraiw, Addw, Subw, Sllw, Srlw, Sraw,
    Mulw, Divw, Divuw, Remw, Remuw,
    Lb, Lh, Lw, Ld, Lbu, Lhu, Lwu, Sb, Sh, Sw, Sd,
    // Branches leave the block when taken; it continues after them.
    Beq, Bne, Blt, Bge, Bltu, Bgeu,
    // The rest end a block.
    Jal, Jalr,
    /// Through `execute` (floating point, atomics, fences), continuing the block.
    Execute,
    /// Through `execute`, ending the block: system instructions (CSRs, traps,
    /// returns, WFI, SFENCE.VMA), which can change privilege, translation or
    /// interrupts, and everything not recognised (which traps).
    ExecuteEnd,
    /// A compressed encoding that is illegal (`imm`: its bits).
    Illegal,
}

impl Kind {
    fn ends_block(self) -> bool {
        self as u8 >= Kind::Jal as u8 && self != Kind::Execute
    }

    pub(crate) fn is_load(self) -> bool {
        (Kind::Lb as u8..=Kind::Lwu as u8).contains(&(self as u8))
    }

    pub(crate) fn is_store(self) -> bool {
        (Kind::Sb as u8..=Kind::Sd as u8).contains(&(self as u8))
    }

    fn sync(self) -> bool {
        (Kind::Lb as u8..=Kind::Sd as u8).contains(&(self as u8)) || self as u8 >= Kind::Execute as u8
    }
}

/// Decode a 32-bit instruction (`len` 4) or a compressed one's expansion (`len` 2, `raw` its bits).
fn decode(inst: u32, len: u8, raw: u32) -> Op {
    let rd = ((inst >> 7) & 0x1f) as u8;
    let rs1 = ((inst >> 15) & 0x1f) as u8;
    let rs2 = ((inst >> 20) & 0x1f) as u8;
    let funct3 = (inst >> 12) & 7;
    let funct7 = inst >> 25;
    let fast_rd = if rd == 0 { SINK } else { rd };
    let op = |kind: Kind, imm: u64| Op { kind, rd: fast_rd, rs1, rs2, len, sync: kind.sync(), imm: imm as i32, inst };
    let generic = |kind: Kind| Op { kind, rd, rs1, rs2, len, sync: true, imm: raw as i32, inst };
    use Kind::*;
    match inst & 0x7f {
        0x13 => {
            let imm = imm_i(inst);
            let shamt = ((inst >> 20) & 0x3f) as u64;
            match (funct3, inst >> 26) {
                (0, _) => op(Addi, imm),
                (2, _) => op(Slti, imm),
                (3, _) => op(Sltiu, imm),
                (4, _) => op(Xori, imm),
                (6, _) => op(Ori, imm),
                (7, _) => op(Andi, imm),
                (1, 0) => op(Slli, shamt),
                (5, 0) => op(Srli, shamt),
                (5, 0x10) => op(Srai, shamt),
                _ => generic(ExecuteEnd), // illegal
            }
        }
        0x37 => op(Lui, (inst & 0xfffff000) as i32 as u64),
        0x17 => op(Auipc, (inst & 0xfffff000) as i32 as u64),
        0x33 => match funct7 << 3 | funct3 {
            0x000 => op(Add, 0),
            0x100 => op(Sub, 0),
            0x001 => op(Sll, 0),
            0x002 => op(Slt, 0),
            0x003 => op(Sltu, 0),
            0x004 => op(Xor, 0),
            0x005 => op(Srl, 0),
            0x105 => op(Sra, 0),
            0x006 => op(Or, 0),
            0x007 => op(And, 0),
            0x008 => op(Mul, 0),
            0x009 => op(Mulh, 0),
            0x00a => op(Mulhsu, 0),
            0x00b => op(Mulhu, 0),
            0x00c => op(Div, 0),
            0x00d => op(Divu, 0),
            0x00e => op(Rem, 0),
            0x00f => op(Remu, 0),
            _ => generic(ExecuteEnd),
        },
        0x1b => {
            let shamt = ((inst >> 20) & 0x1f) as u64;
            match (funct3, funct7) {
                (0, _) => op(Addiw, imm_i(inst)),
                (1, 0) => op(Slliw, shamt),
                (5, 0) => op(Srliw, shamt),
                (5, 0x20) => op(Sraiw, shamt),
                _ => generic(ExecuteEnd),
            }
        }
        0x3b => match funct7 << 3 | funct3 {
            0x000 => op(Addw, 0),
            0x100 => op(Subw, 0),
            0x001 => op(Sllw, 0),
            0x005 => op(Srlw, 0),
            0x105 => op(Sraw, 0),
            0x008 => op(Mulw, 0),
            0x00c => op(Divw, 0),
            0x00d => op(Divuw, 0),
            0x00e => op(Remw, 0),
            0x00f => op(Remuw, 0),
            _ => generic(ExecuteEnd),
        },
        0x03 => {
            let kind = [Lb, Lh, Lw, Ld, Lbu, Lhu, Lwu, ExecuteEnd][funct3 as usize];
            if kind == ExecuteEnd { generic(ExecuteEnd) } else { op(kind, imm_i(inst)) }
        }
        0x23 => match funct3 {
            0 => op(Sb, imm_s(inst)),
            1 => op(Sh, imm_s(inst)),
            2 => op(Sw, imm_s(inst)),
            3 => op(Sd, imm_s(inst)),
            _ => generic(ExecuteEnd),
        },
        0x63 => {
            let imm = ((inst as i32 >> 31) << 12
                | (((inst >> 7) & 1) << 11 | ((inst >> 25) & 0x3f) << 5 | ((inst >> 8) & 0xf) << 1) as i32)
                as u64;
            match funct3 {
                0 => op(Beq, imm),
                1 => op(Bne, imm),
                4 => op(Blt, imm),
                5 => op(Bge, imm),
                6 => op(Bltu, imm),
                7 => op(Bgeu, imm),
                _ => generic(ExecuteEnd),
            }
        }
        0x6f => {
            let imm = ((inst as i32 >> 31) << 20
                | (((inst >> 12) & 0xff) << 12 | ((inst >> 20) & 1) << 11 | ((inst >> 21) & 0x3ff) << 1) as i32)
                as u64;
            op(Jal, imm)
        }
        0x67 if funct3 == 0 => op(Jalr, imm_i(inst)),
        // Floating point, atomics, fences: no effect on control flow.
        0x07 | 0x27 | 0x43 | 0x47 | 0x4b | 0x4f | 0x53 | 0x2f | 0x0f => generic(Execute),
        _ => generic(ExecuteEnd),
    }
}

impl Hart {
    /// Forget all blocks.
    pub(crate) fn flush_blocks(&mut self) {
        self.blocks.fill(EMPTY_BLOCK);
        self.ops_used = 0;
        self.forget_chains(); // (compiled code refers to ops)
    }

    /// RAM at `offset..offset + len` (offsets into RAM) has been written: retire
    /// the blocks of every page where that hits a line with cached code.
    #[inline(always)]
    pub(crate) fn code_written(&mut self, offset: u64, len: u64) {
        self.code.written(offset, len);
    }

    /// Run instructions from the decoded block at pc, if there's one to run
    /// (and it fits in `budget` steps); returns the steps taken, 0 if none
    /// (then the caller steps one instruction the regular way).
    #[inline(always)]
    pub(crate) fn run_block(&mut self, budget: u32) -> u32 {
        if self.blocks.is_empty() || self.waiting || self.pending() != 0 {
            return 0; // no cache, or an interrupt to look at first
        }
        let pc = self.pc;
        let pa = if !self.translate_fetch {
            pc
        } else {
            let i = (pc >> 12) as usize & (FETCH_CACHE - 1);
            let tag = pc & !0xfff | self.fetch_ctx;
            if self.fetch_tags[i] == tag {
                (self.fetch_pages[i] as u64) << 12 | (pc & 0xfff)
            } else {
                match self.translate(pc, Access::Fetch, self.priv_) {
                    Ok(pa) => {
                        self.fetch_tags[i] = tag;
                        self.fetch_pages[i] = (pa >> 12) as u32;
                        pa
                    }
                    Err(_) => return 0, // the regular path raises the fault
                }
            }
        };
        let offset = pa.wrapping_sub(self.ram_base);
        if offset >= self.ram_size {
            return 0;
        }
        let page = (offset >> 12) as usize;
        let epoch = self.code.epoch.load(Relaxed);
        if epoch != self.code_epoch {
            // Code changed somewhere: compiled code may have gone stale.
            self.code_epoch = epoch;
            self.forget_chains();
        }
        let version = self.code.versions[page].load(Relaxed);
        let set = Self::block_set(pa);
        let mut index = set;
        while index < set + WAYS && self.blocks[index].pa != pa {
            index += 1;
        }
        if index == set + WAYS || self.blocks[index].version != version {
            if index == set + WAYS {
                index = self.victim(set);
            }
            match self.decode_block(pa, offset) {
                Some(b) => self.blocks[index] = b,
                None => return 0,
            }
        }
        let block = self.blocks[index];
        if block.count > budget {
            return 0;
        }
        if block.jit == COMPILED {
            self.chain_to(pc, pa, page, block.entry);
            return self.run_compiled(page, block.entry, pc, budget);
        }
        // (How often it ran: which block of a set to replace, see victim().)
        self.blocks[index].jit = (block.jit + 1).min(u16::MAX as u32);
        let n = self.execute_block(block);
        if self.jit.enabled {
            self.jit_account(page, n);
        }
        n
    }

    /// The first of the blocks (`WAYS` of them) where the block at `pa` may be.
    #[inline(always)]
    fn block_set(pa: u64) -> usize {
        (((pa >> 1) as u32).wrapping_mul(0x9e37_79b1) >> (32 - SET_BITS)) as usize * WAYS
    }

    /// Where the block at `pa` is in the cache, if it is.
    pub(crate) fn find_block(&self, pa: u64) -> Option<usize> {
        let set = Self::block_set(pa);
        (set..set + WAYS).find(|&i| self.blocks[i].pa == pa)
    }

    /// The block in the set from `set` to replace: the one that has run the
    /// least (an empty one, or one not run since decoded; compiled ones last).
    #[inline(always)]
    fn victim(&self, set: usize) -> usize {
        (set..set + WAYS).min_by_key(|&i| self.blocks[i].jit).unwrap_or(set)
    }

    /// Decode the block at physical `pa` (`offset` into RAM).
    #[inline(never)]
    fn decode_block(&mut self, pa: u64, offset: u64) -> Option<Block> {
        if self.ops_used + MAX_BLOCK > self.ops.len() {
            self.flush_blocks();
        }
        let start = self.ops_used;
        let page = (offset >> 12) as usize;
        let page_end = (offset | 0xfff) + 1;
        // The version first, then each instruction's lines marked before
        // reading it: a write by another hart either comes before the read,
        // or sees the mark and retires the block.
        let version = self.code.versions[page].load(Relaxed);
        let mut at = offset;
        while at + 2 <= page_end && self.ops_used - start < MAX_BLOCK {
            let last = (at + 3).min(page_end - 1);
            self.code.lines[page].fetch_or(1 << ((at >> 6) & 63) | 1 << ((last >> 6) & 63), Relaxed);
            // SAFETY: at + 2 <= page_end <= ram_size (RAM is whole pages).
            let low = unsafe { self.ram.add(at as usize).cast::<u16>().read_unaligned() } as u32;
            let op = if low & 3 == 3 {
                if at + 4 > page_end {
                    break; // continues on the next page: the regular path does it
                }
                // SAFETY: as above, at + 4 <= page_end.
                let inst = unsafe { self.ram.add(at as usize).cast::<u32>().read_unaligned() };
                decode(inst, 4, 0)
            } else {
                match rvc::expanded(low) {
                    0 => Op { kind: Kind::Illegal, rd: 0, rs1: 0, rs2: 0, len: 2, sync: true, imm: low as i32, inst: 0 },
                    inst => decode(inst, 2, low),
                }
            };
            self.ops[self.ops_used] = op;
            self.ops_used += 1;
            at += op.len as u64;
            if op.kind.ends_block() {
                break;
            }
        }
        let count = self.ops_used - start;
        if count == 0 {
            return None;
        }
        Some(Block { pa, version, start: start as u32, count: count as u32, jit: 0, entry: 0 })
    }

    /// Run a block: like `step()` for each instruction, minus fetching,
    /// decoding and interrupt checks. Returns the steps taken.
    ///
    /// The instruction count is brought up to date where something can see it
    /// (before instructions marked `sync`, and on the way out), not after
    /// every instruction.
    #[inline(always)]
    fn execute_block(&mut self, block: Block) -> u32 {
        let mut pc = self.pc;
        let retired = self.retired;
        for k in 0..block.count {
            // SAFETY: decode_block put block.count ops from block.start into ops,
            // and nothing removes them while the block is valid.
            let op = unsafe { *self.ops.get_unchecked((block.start + k) as usize) };
            let next = pc.wrapping_add(op.len as u64);
            if op.sync {
                self.retired = retired + k as u64;
            }
            match self.execute_op(&op, pc, next) {
                Ok(target) => {
                    if target != next || (op.sync && self.stop_reason != 0) {
                        self.retired = retired + k as u64 + 1;
                        self.pc = target;
                        return k + 1; // a jump, or a device stopped the CPU
                    }
                    pc = next;
                }
                Err(trap) => {
                    self.retired = retired + k as u64;
                    self.pc = pc;
                    self.block_trap(&op, pc, trap);
                    return k + 1;
                }
            }
        }
        self.retired = retired + block.count as u64;
        self.pc = pc;
        block.count
    }

    /// Instruction `op` at `pc` of a block trapped (pc and retired are as before it).
    #[inline(always)]
    pub(crate) fn block_trap(&mut self, op: &Op, pc: u64, trap: Trap) {
        if trap.cause == STOP_AT_BREAKPOINT {
            self.stop_reason = STOPPED_AT_BREAKPOINT;
        } else {
            // An illegal compressed instruction reports its own 16 bits.
            let tval = if trap.cause == ILLEGAL_INSTRUCTION && op.len == 2 { op.imm as u32 as u64 } else { trap.tval };
            self.enter_trap(trap.cause, false, pc, tval);
        }
    }

    /// One decoded instruction; returns the next pc (as `execute`).
    #[inline(always)]
    pub(crate) fn execute_op(&mut self, op: &Op, pc: u64, next: u64) -> Result<u64> {
        use Kind::*;
        let a = self.x[op.rs1 as usize];
        let b = self.x[op.rs2 as usize];
        let imm = op.imm as i64 as u64;
        let rd = op.rd as usize;
        let (a32, b32) = (a as u32, b as u32);
        let w = |v: u32| v as i32 as u64; // sign-extend a 32-bit result
        self.x[rd] = match op.kind {
            Addi => a.wrapping_add(imm),
            Slti => ((a as i64) < (imm as i64)) as u64,
            Sltiu => (a < imm) as u64,
            Xori => a ^ imm,
            Ori => a | imm,
            Andi => a & imm,
            Slli => a << imm,
            Srli => a >> imm,
            Srai => ((a as i64) >> imm) as u64,
            Lui => imm,
            Auipc => pc.wrapping_add(imm),
            Add => a.wrapping_add(b),
            Sub => a.wrapping_sub(b),
            Sll => a << (b & 0x3f),
            Slt => ((a as i64) < (b as i64)) as u64,
            Sltu => (a < b) as u64,
            Xor => a ^ b,
            Srl => a >> (b & 0x3f),
            Sra => ((a as i64) >> (b & 0x3f)) as u64,
            Or => a | b,
            And => a & b,
            Mul => a.wrapping_mul(b),
            Mulh => ((a as i64 as i128 * b as i64 as i128) >> 64) as u64,
            Mulhsu => ((a as i64 as i128 * b as i128) >> 64) as u64,
            Mulhu => ((a as u128 * b as u128) >> 64) as u64,
            Div => if b == 0 { u64::MAX } else { (a as i64).wrapping_div(b as i64) as u64 },
            Divu => a.checked_div(b).unwrap_or(u64::MAX),
            Rem => if b == 0 { a } else { (a as i64).wrapping_rem(b as i64) as u64 },
            Remu => if b == 0 { a } else { a % b },
            Addiw => w(a32.wrapping_add(imm as u32)),
            Slliw => w(a32 << imm),
            Srliw => w(a32 >> imm),
            Sraiw => w(((a32 as i32) >> imm) as u32),
            Addw => w(a32.wrapping_add(b32)),
            Subw => w(a32.wrapping_sub(b32)),
            Sllw => w(a32 << (b32 & 0x1f)),
            Srlw => w(a32 >> (b32 & 0x1f)),
            Sraw => w(((a32 as i32) >> (b32 & 0x1f)) as u32),
            Mulw => w(a32.wrapping_mul(b32)),
            Divw => w(if b32 == 0 { u32::MAX } else { (a32 as i32).wrapping_div(b32 as i32) as u32 }),
            Divuw => w(a32.checked_div(b32).unwrap_or(u32::MAX)),
            Remw => w(if b32 == 0 { a32 } else { (a32 as i32).wrapping_rem(b32 as i32) as u32 }),
            Remuw => w(if b32 == 0 { a32 } else { a32 % b32 }),
            Lb => self.load(a.wrapping_add(imm), 1)? as i8 as u64,
            Lh => self.load(a.wrapping_add(imm), 2)? as i16 as u64,
            Lw => self.load(a.wrapping_add(imm), 4)? as i32 as u64,
            Ld => self.load(a.wrapping_add(imm), 8)?,
            Lbu => self.load(a.wrapping_add(imm), 1)?,
            Lhu => self.load(a.wrapping_add(imm), 2)?,
            Lwu => self.load(a.wrapping_add(imm), 4)?,
            Sb | Sh | Sw | Sd => {
                let width = 1 << (op.kind as u8 - Sb as u8);
                self.store(a.wrapping_add(imm), width, b)?;
                return Ok(next);
            }
            Beq => return Ok(if a == b { pc.wrapping_add(imm) } else { next }),
            Bne => return Ok(if a != b { pc.wrapping_add(imm) } else { next }),
            Blt => return Ok(if (a as i64) < (b as i64) { pc.wrapping_add(imm) } else { next }),
            Bge => return Ok(if (a as i64) >= (b as i64) { pc.wrapping_add(imm) } else { next }),
            Bltu => return Ok(if a < b { pc.wrapping_add(imm) } else { next }),
            Bgeu => return Ok(if a >= b { pc.wrapping_add(imm) } else { next }),
            Jal => {
                self.x[rd] = next;
                return Ok(pc.wrapping_add(imm));
            }
            Jalr => {
                let target = a.wrapping_add(imm) & !1;
                self.x[rd] = next;
                return Ok(target);
            }
            Execute | ExecuteEnd => {
                // (It writes x0 like any register, then x0 is cleared.)
                let result = self.execute_generic(op.inst, pc, next);
                self.x[0] = 0;
                return result;
            }
            Illegal => return Err(illegal(op.imm as u32)),
        };
        Ok(next)
    }
}
