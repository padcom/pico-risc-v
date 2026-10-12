//! The JIT: hot code compiled to WebAssembly, which the host (V8) compiles to
//! machine code.
//!
//! The unit is a page of RAM: its hot blocks (blocks.rs) become one
//! function, a loop around a switch over them, so jumps between them (loops,
//! branches, calls within the page) stay inside the function. When the code
//! leaves the page, or jumps through a register (JALR), the function looks
//! the target up in the chain cache (`Hart::chain`) and, if it's compiled,
//! goes on there with a tail call: so compiled code mostly runs from one
//! page to the next without returning to `run()`. It does return when the
//! target isn't (known to be) compiled, at system instructions (which can
//! change privilege, translation or interrupts), and once the step budget is
//! used up (at the start of a block: a block started runs to its end). Code
//! that runs off the end of a block into the next goes straight on (cases are
//! in address order), without going through the switch.
//!
//! A page that has run `threshold` instructions the regular way (since it
//! was last compiled, or its code changed) is queued; once `batch` pages are
//! queued (or they've waited long enough), each is compiled (again, if it
//! was before) with all its blocks in the cache, together into one module,
//! which src/cpu.ts instantiates
//! against this module's memory, putting the functions into its function
//! table. RAM page `p` owns table slot `table_base + p`, so a page's code is
//! called with a plain indirect call, never leaving WebAssembly.
//!
//! What compiled code does is what `execute_block` does, without decoding:
//! - Within a block, registers live in WebAssembly locals, loaded on first
//!   use, written back when leaving it (or before anything that reads them
//!   from memory).
//! - Loads and stores to RAM go straight to memory, through the JIT's own
//!   TLB (`jit_tlb`), which maps virtual pages to where they are in linear
//!   memory, per access type and translation context. A miss, a device, an
//!   access across a page, or a store to a page holding code that some hart
//!   decoded (compiled code checks: that can change any time) goes through
//!   `jit_op` (the interpreter), which then refills the TLB.
//! - Whatever isn't compiled (floating point, atomics, CSRs, system
//!   instructions, MULH*) also runs through `jit_op`. Only `jit_op` can
//!   reach devices, so it also ends the function when one raised an
//!   interrupt or stopped the CPU, or when code was written (which may be
//!   the function's own).
//!
//! Functions take the page's virtual address as a parameter: the same
//! physical code may run at several (shared libraries).

use crate::blocks::{FETCH_CACHE, Kind, Op, SINK};
use crate::hart::Hart;
use crate::mmu::TLB_SIZE;
use core::sync::atomic::Ordering::Relaxed;

// Implemented by src/cpu.ts: compile `code` (a module), instantiate it and
// put its exported functions "0", "1", ... into the table at `slots`.
// Returns 1 on success.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn jit_install(code: *const u8, len: u32, slots: *const u32, count: u32) -> u32;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn jit_install(_: *const u8, _: u32, _: *const u32, _: u32) -> u32 {
    0
}

/// A compiled page: (hart, the page's virtual address, the block to start
/// with, the step budget, the steps taken so far, the instruction count
/// when they started) → steps taken. (The hart pointer tells the compiler
/// the call reads and writes it; the code knows where it is.)
type Compiled = extern "C" fn(*mut Hart, u64, u32, u32, u32, u64) -> u32;

/// Block::jit for a block in its page's function, as case `Block::entry`
/// (otherwise, how often it has run).
pub const COMPILED: u32 = u32::MAX;

/// A JIT TLB entry: for loads and for stores, the virtual page (its address)
/// with the context it was checked in (`Hart::jit_ctx`) in the low bits; and
/// what to add to a virtual address on that page to get where it is in
/// linear memory.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct JitTlbEntry {
    pub(crate) load: u64,
    pub(crate) store: u64,
    host: u32,
    _pad: [u32; 3],
}

/// Matches nothing (tags have bits 12+ from the page, 0..11 from the context).
pub const JIT_TLB_EMPTY: JitTlbEntry = JitTlbEntry { load: u64::MAX, store: u64::MAX, host: 0, _pad: [0; 3] };

/// A chain cache entry: a virtual pc with the epoch it was found in
/// (`Hart::chain_ctx`), and the compiled code there: the table slot of its
/// page's function and the case, valid while the pc's page is the physical
/// page `ppn`: compiled code checks that in the fetch cache.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ChainEntry {
    pc: u64,
    ctx: u64,
    slot: u32,
    case: u32,
    ppn: u32,
    _pad: u32,
}

/// Entries, direct mapped by pc.
pub const CHAIN_SIZE: usize = 1 << 16;
/// Of no epoch (they start at 1).
pub const CHAIN_EMPTY: ChainEntry = ChainEntry { pc: 0, ctx: 0, slot: 0, case: 0, ppn: 0, _pad: 0 };

/// `jit_ctx` for loads and stores without translation (identity-mapped);
/// with translation it's `data_ok_tag` (0x40..0x7c).
pub const JIT_CTX_BARE: u64 = 1;
/// `jit_ctx` bits 7..11: the TLB's epoch, bumped by every flush (so a flush
/// only clears the table every 32nd time).
const EPOCH_SHIFT: u32 = 7;
const EPOCHS: u64 = 32;

/// A page's function covers at most this many instructions (the rest of its
/// blocks are left out)...
const MAX_FUNCTION_OPS: usize = 4096;
/// ...which takes at most this much code (`Emitter::op` emits under 200
/// bytes for any instruction; checked as it goes).
const MAX_FUNCTION: usize = 1 << 20;
/// A batch stops taking pages at this much code...
const MAX_MODULE: usize = 4 << 20;
/// ...or this many compiled blocks.
const MAX_PENDING: usize = 1 << 16;
/// Pages queued at most.
const MAX_QUEUE: usize = 4096;
/// Queued pages are compiled after this many instructions have run the
/// regular way, even if there aren't `batch` of them yet.
const WAIT: u32 = 200_000;
/// A page compiled n times (with the same code) needs 2^n times the
/// threshold to be compiled again (up to this n): it may be hot only in
/// part, or keep running new code (each time, all of it is compiled).
const MAX_BACKOFF: u8 = 6;

pub struct Jit {
    pub enabled: bool,
    /// The table slot of RAM page 0.
    pub table_base: u32,
    /// Instructions run the regular way before a page is compiled, and how
    /// many pages are compiled together.
    pub threshold: u32,
    pub batch: usize,
    /// Pages waiting to be compiled, and whether a page is (per RAM page).
    queue: Vec<u32>,
    /// Instructions run the regular way since the queue's first page was queued.
    waited: u32,
    queued: Vec<bool>,
    /// The module being built, a function's code, the code section, the slots.
    module: Vec<u8>,
    function: Vec<u8>,
    bodies: Vec<u8>,
    slots: Vec<u32>,
    /// The blocks compiled in this batch (cache index, case), marked
    /// compiled once installed.
    pending: Vec<(u32, u32)>,
    /// The page being compiled: its blocks (cache indexes, by address), and
    /// for each 2-byte offset in the page, the case of the block starting
    /// there, plus 1 (0: none).
    cases: Vec<u32>,
    case_at: Vec<u16>,
    lengths: Vec<u16>,
    /// Per RAM page: instructions run the regular way since it was last
    /// compiled; how often it's been compiled, and the version of its code
    /// it was last compiled from.
    steps: Vec<u32>,
    compiles: Vec<u8>,
    compiled_version: Vec<u32>,
}

impl Jit {
    pub const fn new() -> Jit {
        Jit {
            enabled: false,
            table_base: 0,
            threshold: 0,
            batch: 0,
            queue: Vec::new(),
            waited: 0,
            queued: Vec::new(),
            module: Vec::new(),
            function: Vec::new(),
            bodies: Vec::new(),
            slots: Vec::new(),
            pending: Vec::new(),
            cases: Vec::new(),
            case_at: Vec::new(),
            lengths: Vec::new(),
            steps: Vec::new(),
            compiles: Vec::new(),
            compiled_version: Vec::new(),
        }
    }

    /// Allocate the buffers, once, for `pages` of RAM (nothing may allocate
    /// later: see lib.rs).
    pub fn allocate(&mut self, pages: usize) {
        self.queue = Vec::with_capacity(MAX_QUEUE);
        self.queued = vec![false; pages];
        // (The module: its sections, exports, and the code section: up to
        // MAX_MODULE, plus one more function, of up to MAX_FUNCTION plus an
        // instruction's and the end's code.)
        self.function = Vec::with_capacity(MAX_FUNCTION + 4096);
        self.bodies = Vec::with_capacity(MAX_MODULE + 2 * MAX_FUNCTION);
        self.module = Vec::with_capacity(MAX_MODULE + 2 * MAX_FUNCTION + 16 * MAX_QUEUE + 4096);
        self.slots = Vec::with_capacity(MAX_QUEUE);
        self.pending = Vec::with_capacity(MAX_PENDING);
        self.cases = Vec::with_capacity(2048);
        self.case_at = vec![0; 2048];
        self.lengths = Vec::with_capacity(2048);
        self.steps = vec![0; pages];
        self.compiles = vec![0; pages];
        self.compiled_version = vec![0; pages];
    }
}

impl Hart {
    /// `steps` instructions of RAM `page` have run the regular way: queue
    /// the page when that's enough, and compile the queue when it's time.
    #[inline(always)]
    pub(crate) fn jit_account(&mut self, page: usize, steps: u32) {
        let jit = &mut self.jit;
        jit.steps[page] += steps;
        let version = self.code.versions[page].load(Relaxed);
        let backoff = if jit.compiled_version[page] == version { jit.compiles[page].min(MAX_BACKOFF) } else { 0 };
        if jit.steps[page] >= jit.threshold << backoff && !jit.queued[page] && jit.queue.len() < MAX_QUEUE {
            jit.queued[page] = true;
            jit.queue.push(page as u32);
        }
        if !jit.queue.is_empty() {
            jit.waited += steps;
            if jit.waited >= WAIT || jit.queue.len() >= jit.batch.min(MAX_QUEUE) {
                self.jit_compile();
            }
        }
    }

    /// Run RAM `page`'s compiled code from virtual `pc`, the start of its
    /// block `entry`, for up to `budget` steps.
    #[inline(always)]
    pub(crate) fn run_compiled(&mut self, page: usize, entry: u32, pc: u64, budget: u32) -> u32 {
        let slot = self.jit.table_base as usize + page;
        // SAFETY: a WebAssembly function pointer is its table index, and the
        // slot holds this page's function, of this type (jit_compile).
        let f: Compiled = unsafe { core::mem::transmute::<usize, Compiled>(slot) };
        f(self, pc & !0xfff, entry, budget, 0, self.retired)
    }

    /// The block at virtual `pc` (physical `pa`) is case `case` of RAM
    /// `page`'s function: put it in the chain cache.
    #[inline(always)]
    pub(crate) fn chain_to(&mut self, pc: u64, pa: u64, page: usize, case: u32) {
        if !self.translate_fetch {
            // Compiled code checks the translation in the fetch cache, which
            // run_block doesn't use without translation: put it there. (Only
            // a TLB flush, which starts a new epoch, turns translation on
            // at the same privilege.)
            let i = (pc >> 12) as usize & (FETCH_CACHE - 1);
            self.fetch_tags[i] = pc & !0xfff | self.fetch_ctx;
            self.fetch_pages[i] = (pa >> 12) as u32;
        }
        let e = &mut self.chain[(pc >> 1) as usize & (CHAIN_SIZE - 1)];
        e.pc = pc;
        e.ctx = self.chain_ctx;
        e.slot = self.jit.table_base + page as u32;
        e.case = case;
        e.ppn = (pa >> 12) as u32;
    }

    /// Compiled code changed (or its blocks' ops went): forget the chain
    /// cache's entries, by starting a new epoch.
    pub(crate) fn forget_chains(&mut self) {
        self.chain_ctx = self.chain_ctx.wrapping_add(1);
    }

    /// Compile the queued pages.
    #[inline(never)]
    fn jit_compile(&mut self) {
        let mut queue = core::mem::take(&mut self.jit.queue);
        let mut bodies = core::mem::take(&mut self.jit.bodies);
        let mut function = core::mem::take(&mut self.jit.function);
        bodies.clear();
        self.jit.slots.clear();
        self.jit.pending.clear();
        let mut taken = 0;
        for &page in &queue {
            if bodies.len() > MAX_MODULE || self.jit.pending.len() + 2048 > MAX_PENDING {
                break; // the rest next time
            }
            taken += 1;
            self.jit.queued[page as usize] = false;
            self.jit.steps[page as usize] = 0;
            if !self.collect_cases(page as usize) {
                continue;
            }
            function.clear();
            let emitter = Emitter::new(self, &mut function);
            if !emitter.page(self) {
                continue; // too big after all: (not expected)
            }
            uleb(&mut bodies, function.len() as u64);
            bodies.extend_from_slice(&function);
            self.jit.slots.push(self.jit.table_base + page);
            let page = page as usize;
            let version = self.code.versions[page].load(Relaxed);
            if self.jit.compiled_version[page] != version {
                self.jit.compiles[page] = 0; // new code
            }
            self.jit.compiles[page] = self.jit.compiles[page].saturating_add(1);
            self.jit.compiled_version[page] = version;
            for (case, &index) in self.jit.cases.iter().enumerate() {
                self.jit.pending.push((index, case as u32));
            }
        }
        queue.drain(..taken);
        self.jit.queue = queue;
        self.jit.waited = 0;
        self.jit.function = function;

        let count = self.jit.slots.len();
        if count > 0 {
            let mut module = core::mem::take(&mut self.jit.module);
            build_module(&mut module, &bodies, count);
            // SAFETY: an import implemented in JavaScript; it only reads the buffers.
            let ok = unsafe { jit_install(module.as_ptr(), module.len() as u32, self.jit.slots.as_ptr(), count as u32) } != 0;
            self.jit.module = module;
            if ok {
                for &(index, case) in &self.jit.pending {
                    let block = &mut self.blocks[index as usize];
                    block.jit = COMPILED;
                    block.entry = case;
                }
                self.forget_chains(); // (pages compiled again have new cases)
            } else {
                self.jit.enabled = false;
            }
        }
        self.jit.bodies = bodies;
    }

    /// The blocks of RAM `page` (those still current; hot or not) into
    /// `jit.cases`, by address, with `jit.case_at`, and how much of each
    /// to compile into `jit.lengths`: up to where another one starts (which
    /// then goes on), so each instruction is compiled once. Those beyond the
    /// limit are left out. Returns whether there are any.
    fn collect_cases(&mut self, page: usize) -> bool {
        self.jit.cases.clear();
        self.jit.case_at.fill(0);
        let version = self.code.versions[page].load(Relaxed);
        let lines = self.code.lines[page].load(Relaxed);
        let page_pa = self.ram_base + ((page as u64) << 12);
        for line in 0..64 {
            if lines & 1 << line == 0 {
                continue;
            }
            for offset in (line * 64..line * 64 + 64).step_by(2) {
                let Some(index) = self.find_block(page_pa + offset) else { continue };
                if self.blocks[index].version == version {
                    self.jit.cases.push(index as u32);
                    self.jit.case_at[offset as usize / 2] = self.jit.cases.len() as u16;
                }
            }
        }
        if self.case_lengths() > MAX_FUNCTION_OPS {
            // Leave out those past the limit (not in the new function, even
            // if they were in the old one).
            let mut ops = 0;
            let mut keep = 0;
            while keep < self.jit.cases.len() && ops + self.jit.lengths[keep] as usize <= MAX_FUNCTION_OPS {
                ops += self.jit.lengths[keep] as usize;
                keep += 1;
            }
            for &index in &self.jit.cases[keep..] {
                let block = &mut self.blocks[index as usize];
                block.jit = block.jit.min(u16::MAX as u32);
                self.jit.case_at[(block.pa & 0xfff) as usize / 2] = 0;
            }
            self.jit.cases.truncate(keep);
            self.case_lengths();
        }
        !self.jit.cases.is_empty()
    }

    /// `jit.lengths` for `jit.cases`; returns their sum.
    fn case_lengths(&mut self) -> usize {
        self.jit.lengths.clear();
        let mut total = 0;
        for &index in &self.jit.cases {
            let block = self.blocks[index as usize];
            let mut offset = block.pa & 0xfff;
            let mut length = 0;
            while length < block.count {
                if length > 0 && offset < 4096 && self.jit.case_at[offset as usize / 2] != 0 {
                    break;
                }
                offset += self.ops[(block.start + length) as usize].len as u64;
                length += 1;
            }
            self.jit.lengths.push(length as u16);
            total += length as usize;
        }
        total
    }

    /// An instruction that compiled code hands to the interpreter:
    /// `ops[index]` at `pc`, with `retired` already counting the
    /// instructions before it. Returns 0 to go on with the next instruction;
    /// otherwise pc and retired are updated, and it's 2 to go on at pc
    /// (after a jump or a trap), 1 to return to `run()`: a device stopped
    /// the CPU or raised an interrupt, the hart waits for one, or code was
    /// written.
    pub(crate) fn jit_op(&mut self, index: u32, pc: u64) -> u32 {
        let op = self.ops[index as usize];
        let next = pc.wrapping_add(op.len as u64);
        let addr = self.x[op.rs1 as usize].wrapping_add(op.imm as i64 as u64);
        let result = self.execute_op(&op, pc, next);
        // Code was written, by this instruction or another hart since this
        // one last looked (run_block then forgets chains, which may lead to
        // stale code; FENCE.I, after another hart wrote code, comes here).
        let code_changed = self.code.epoch.load(Relaxed) != self.code_epoch;
        match result {
            Ok(target) => {
                let leave = self.stop_reason != 0 || self.pending() != 0 || self.waiting || code_changed;
                if target != next || leave {
                    self.retired += 1;
                    self.pc = target;
                    return if leave { 1 } else { 2 };
                }
                if op.kind.is_load() {
                    self.jit_fill(addr, false);
                } else if op.kind.is_store() {
                    self.jit_fill(addr, true);
                }
                0
            }
            Err(trap) => {
                self.pc = pc;
                self.block_trap(&op, pc, trap);
                if self.stop_reason != 0 || self.pending() != 0 || code_changed { 1 } else { 2 }
            }
        }
    }

    /// After a load or store at `vaddr` went through the regular path: put
    /// its page in the JIT TLB, if the access was allowed and it's RAM.
    fn jit_fill(&mut self, vaddr: u64, store: bool) {
        use crate::mmu::{DATA_LOAD_OK, DATA_STORE_OK};
        let vpn = vaddr >> 12;
        let i = vpn as usize & (TLB_SIZE - 1);
        let page = if !self.translate_data {
            vaddr & !0xfff
        } else {
            let ok = self.tlb_ok[i];
            let bit = if store { DATA_STORE_OK } else { DATA_LOAD_OK };
            if self.tlb_vpn[i] != vpn || ok & !(DATA_LOAD_OK | DATA_STORE_OK) != self.data_ok_tag || ok & bit == 0 {
                return;
            }
            (self.tlb_ppn[i] as u64) << 12
        };
        let offset = page.wrapping_sub(self.ram_base);
        if offset >= self.ram_size {
            return;
        }
        let tag = vaddr & !0xfff | self.jit_ctx;
        let host = (self.ram as u32).wrapping_add(offset as u32).wrapping_sub(vaddr as u32 & !0xfff);
        let e = &mut self.jit_tlb[i];
        // The entry's other tag stays only if it's the same page in the same context (same `host`).
        if store {
            if e.load != tag {
                e.load = u64::MAX;
            }
            e.store = tag;
        } else {
            if e.store != tag {
                e.store = u64::MAX;
            }
            e.load = tag;
        }
        e.host = host;
    }

    /// Forget the JIT TLB (with the TLB): start a new epoch, which no entry
    /// matches; every 32nd time actually clear it.
    pub(crate) fn flush_jit_tlb(&mut self) {
        let epoch = ((self.jit_ctx >> EPOCH_SHIFT) + 1) % EPOCHS;
        if epoch == 0 {
            self.jit_tlb.fill(JIT_TLB_EMPTY);
        }
        self.jit_ctx = self.jit_ctx & ((1 << EPOCH_SHIFT) - 1) | epoch << EPOCH_SHIFT;
    }

    /// `jit_ctx` after a change of translation (the epoch stays).
    pub(crate) fn update_jit_ctx(&mut self) {
        let context = if self.translate_data { self.data_ok_tag as u64 } else { JIT_CTX_BARE };
        self.jit_ctx = self.jit_ctx & !((1 << EPOCH_SHIFT) - 1) | context;
    }
}

// --- WebAssembly encoding ---

fn uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        let done = (v == 0 && byte & 0x40 == 0) || (v == -1 && byte & 0x40 != 0);
        out.push(if done { byte } else { byte | 0x80 });
        if done {
            return;
        }
    }
}

/// Start a section: its id, and room for its size (`end_section` fills it in).
fn begin_section(out: &mut Vec<u8>, id: u8) -> usize {
    out.push(id);
    out.extend_from_slice(&[0x80, 0x80, 0x80, 0x80, 0]);
    out.len()
}

/// Fill in the size of the section begun at `start` (a 5-byte LEB128, padded).
fn end_section(out: &mut Vec<u8>, start: usize) {
    let size = (out.len() - start) as u32;
    for i in 0..5 {
        out[start - 5 + i] = (size >> (7 * i)) as u8 & 0x7f | if i < 4 { 0x80 } else { 0 };
    }
}

/// A module of `count` compiled pages (`bodies`: the code section's
/// entries), importing the memory, the function table and `jit_op` as
/// "env" "memory" / "table" / "op", exporting the functions as "0", "1", ...
fn build_module(out: &mut Vec<u8>, bodies: &[u8], count: usize) {
    out.clear();
    out.extend_from_slice(b"\0asm\x01\0\0\0");
    // Types: 0 = (i32 hart, i64 page, i32 entry, i32 budget, i32 steps,
    // i64 base) -> i32 steps, the pages (Compiled); 1 = (i32 hart, i32
    // index, i64 pc) -> i32, jit_op.
    let s = begin_section(out, 1);
    out.extend_from_slice(&[2, 0x60, 6, I32, I64, I32, I32, I32, I64, 1, I32, 0x60, 3, I32, I32, I64, 1, I32]);
    end_section(out, s);
    let s = begin_section(out, 2);
    // (The memory is shared: limits 0 to 4 GiB, 65536 pages.)
    out.extend_from_slice(&[3, 3, b'e', b'n', b'v', 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 3, 0, 0x80, 0x80, 0x04]);
    out.extend_from_slice(&[3, b'e', b'n', b'v', 5, b't', b'a', b'b', b'l', b'e', 1, FUNCREF, 0, 0]);
    out.extend_from_slice(&[3, b'e', b'n', b'v', 2, b'o', b'p', 0, 1]);
    end_section(out, s);
    let s = begin_section(out, 3);
    uleb(out, count as u64);
    out.resize(out.len() + count, 0); // all of type 0
    end_section(out, s);
    let s = begin_section(out, 7);
    uleb(out, count as u64);
    let mut name = [0u8; 8];
    for i in 0..count {
        let digits = decimal(i, &mut name);
        uleb(out, digits.len() as u64);
        out.extend_from_slice(digits);
        out.push(0); // a function,
        uleb(out, i as u64 + 1); // after the import
    }
    end_section(out, s);
    let s = begin_section(out, 10);
    uleb(out, count as u64);
    out.extend_from_slice(bodies);
    end_section(out, s);
}

fn decimal(mut i: usize, buf: &mut [u8; 8]) -> &[u8] {
    let mut at = buf.len();
    loop {
        at -= 1;
        buf[at] = b'0' + (i % 10) as u8;
        i /= 10;
        if i == 0 {
            return &buf[at..];
        }
    }
}

const I32: u8 = 0x7f;
const I64: u8 = 0x7e;
const EMPTY: u8 = 0x40;
const FUNCREF: u8 = 0x70;

// Opcodes
const UNREACHABLE: u8 = 0x00;
const BLOCK: u8 = 0x02;
const LOOP: u8 = 0x03;
const IF: u8 = 0x04;
const ELSE: u8 = 0x05;
const END: u8 = 0x0b;
const BR: u8 = 0x0c;
const BR_TABLE: u8 = 0x0e;
const RETURN: u8 = 0x0f;
const CALL: u8 = 0x10;
const RETURN_CALL_INDIRECT: u8 = 0x13;
const DROP: u8 = 0x1a;
const LOCAL_GET: u8 = 0x20;
const LOCAL_SET: u8 = 0x21;
const LOCAL_TEE: u8 = 0x22;
const I32_LOAD: u8 = 0x28;
const I64_LOAD: u8 = 0x29;
const I64_STORE: u8 = 0x37;
const I32_CONST: u8 = 0x41;
const I64_CONST: u8 = 0x42;
const I32_EQZ: u8 = 0x45;
const I32_EQ: u8 = 0x46;
const I32_GE_U: u8 = 0x4f;
const I64_EQZ: u8 = 0x50;
const I64_EQ: u8 = 0x51;
const I64_NE: u8 = 0x52;
const I64_LT_S: u8 = 0x53;
const I64_LT_U: u8 = 0x54;
const I64_GE_S: u8 = 0x59;
const I64_GE_U: u8 = 0x5a;
const I32_ADD: u8 = 0x6a;
const I32_SUB: u8 = 0x6b;
const I32_MUL: u8 = 0x6c;
const I32_DIV_S: u8 = 0x6d;
const I32_DIV_U: u8 = 0x6e;
const I32_REM_S: u8 = 0x6f;
const I32_REM_U: u8 = 0x70;
const I32_AND: u8 = 0x71;
const I32_SHL: u8 = 0x74;
const I32_SHR_S: u8 = 0x75;
const I32_SHR_U: u8 = 0x76;
const I64_ADD: u8 = 0x7c;
const I64_SUB: u8 = 0x7d;
const I64_MUL: u8 = 0x7e;
const I64_DIV_S: u8 = 0x7f;
const I64_DIV_U: u8 = 0x80;
const I64_REM_S: u8 = 0x81;
const I64_REM_U: u8 = 0x82;
const I64_AND: u8 = 0x83;
const I64_OR: u8 = 0x84;
const I64_XOR: u8 = 0x85;
const I64_SHL: u8 = 0x86;
const I64_SHR_S: u8 = 0x87;
const I64_SHR_U: u8 = 0x88;
const I32_WRAP_I64: u8 = 0xa7;
const I64_EXTEND_I32_S: u8 = 0xac;
const I64_EXTEND_I32_U: u8 = 0xad;

// A compiled page's locals: the parameters (Compiled), then x1..x31 (x[r]
// in local X + r), then scratch.
const HART: u32 = 0;
const PAGE: u32 = 1;
const NEXT: u32 = 2; // the case to run next (the parameter `entry`, to start with)
const BUDGET: u32 = 3;
const STEPS: u32 = 4; // i32
const BASE: u32 = 5; // retired = BASE + STEPS
const X: u32 = 5;
const ADDR: u32 = 37;
const A: u32 = 38;
const B: u32 = 39;
const CTX: u32 = 40;
const PC_OUT: u32 = 41;
const ENTRY: u32 = 42; // i32
const FETCH: u32 = 43; // i32
const HOST: u32 = 44; // i32

/// Whether the instructions `ops`, from `start` (in the page), jump to `start`.
fn loops_to(ops: &[Op], start: i64) -> bool {
    use Kind::*;
    let mut offset = start;
    ops.iter().any(|op| {
        let to_start = matches!(op.kind, Beq | Bne | Blt | Bge | Bltu | Bgeu | Jal) && offset.wrapping_add(op.imm as i64) == start;
        offset += op.len as i64;
        to_start
    })
}

/// The registers an instruction reads and writes (bit r: x[r]).
fn registers(op: &Op) -> (u32, u32) {
    use Kind::*;
    let bit = |r: u8| if r == 0 || r >= 32 { 0 } else { 1u32 << r };
    let rs2 = matches!(
        op.kind,
        Add | Sub | Sll | Slt | Sltu | Xor | Srl | Sra | Or | And
            | Mul | Mulh | Mulhsu | Mulhu | Div | Divu | Rem | Remu
            | Addw | Subw | Sllw | Srlw | Sraw | Mulw | Divw | Divuw | Remw | Remuw
            | Sb | Sh | Sw | Sd | Beq | Bne | Blt | Bge | Bltu | Bgeu | Execute | ExecuteEnd
    );
    let rs1 = !matches!(op.kind, Lui | Auipc | Jal | Illegal);
    // (Stores' and branches' rd bits are part of the immediate.)
    let rd = !matches!(op.kind, Sb | Sh | Sw | Sd | Beq | Bne | Blt | Bge | Bltu | Bgeu | Illegal);
    let reads = if rs1 { bit(op.rs1) } else { 0 } | if rs2 { bit(op.rs2) } else { 0 };
    (reads, if rd { bit(op.rd) } else { 0 })
}

/// A case that jumps back to its own start (a loop of one block), compiled as
/// a WebAssembly loop: `regs`, the registers it uses, are in their locals all
/// along, and its jumps back go straight to `label`, not through the switch.
#[derive(Clone, Copy)]
struct SelfLoop {
    label: u32,
    /// Its start, from the page's.
    offset: i64,
    regs: u32,
}

/// Compiles a page into a function body.
struct Emitter<'a> {
    out: &'a mut Vec<u8>,
    /// Bit r: x[r] is in its local...
    loaded: u32,
    /// ...and the local is newer than memory.
    dirty: u32,
    /// Open blocks, and the depths of the ones jumps go to.
    depth: u32,
    top: u32,
    self_loop: Option<SelfLoop>,
    chain: u32,
    exit: u32,
    helper_exit: u32,
    // Where things are in linear memory.
    x: u32,
    pc: u32,
    retired: u32,
    ctx: u32,
    tlb: u32,
    chains: u32,
    chain_ctx: u32,
    fetch_tags: u32,
    fetch_pages: u32,
    fetch_ctx: u32,
    ram: u32,
    code_lines: u32,
}

impl<'a> Emitter<'a> {
    fn new(hart: &Hart, out: &'a mut Vec<u8>) -> Emitter<'a> {
        Emitter {
            out,
            loaded: 0,
            dirty: 0,
            depth: 0,
            top: 0,
            self_loop: None,
            chain: 0,
            exit: 0,
            helper_exit: 0,
            x: hart.x.as_ptr() as u32,
            pc: &hart.pc as *const u64 as u32,
            retired: &hart.retired as *const u64 as u32,
            ctx: &hart.jit_ctx as *const u64 as u32,
            tlb: hart.jit_tlb.as_ptr() as u32,
            chains: hart.chain.as_ptr() as u32,
            chain_ctx: &hart.chain_ctx as *const u64 as u32,
            fetch_tags: hart.fetch_tags.as_ptr() as u32,
            fetch_pages: hart.fetch_pages.as_ptr() as u32,
            fetch_ctx: &hart.fetch_ctx as *const u64 as u32,
            ram: hart.ram as u32,
            code_lines: hart.code.lines.as_ptr() as u32,
        }
    }

    fn o(&mut self, opcode: u8) {
        self.out.push(opcode);
    }

    fn i32c(&mut self, v: i32) {
        self.o(I32_CONST);
        sleb(self.out, v as i64);
    }

    fn i64c(&mut self, v: i64) {
        self.o(I64_CONST);
        sleb(self.out, v);
    }

    fn local(&mut self, opcode: u8, local: u32) {
        self.o(opcode);
        uleb(self.out, local as u64);
    }

    /// A load or store at a fixed address (or that plus the address on the stack).
    fn mem(&mut self, opcode: u8, offset: u32) {
        self.o(opcode);
        self.o(0); // alignment: none promised
        uleb(self.out, offset as u64);
    }

    /// Open a block, loop or if (of type `ty`); returns its depth, for `br`.
    fn open(&mut self, opcode: u8, ty: u8) -> u32 {
        self.o(opcode);
        self.o(ty);
        self.depth += 1;
        self.depth
    }

    fn close(&mut self) {
        self.o(END);
        self.depth -= 1;
    }

    /// Jump to the block (or loop) opened at `depth`.
    fn br(&mut self, depth: u32) {
        self.o(BR);
        uleb(self.out, (self.depth - depth) as u64);
    }

    /// Push x[r].
    fn reg(&mut self, r: u32) {
        if r == 0 {
            self.i64c(0);
        } else if self.loaded & 1 << r != 0 {
            self.local(LOCAL_GET, X + r);
        } else {
            self.i32c(0);
            self.mem(I64_LOAD, self.x + 8 * r);
            self.local(LOCAL_TEE, X + r);
            self.loaded |= 1 << r;
        }
    }

    /// Load x[r] into its local.
    fn preload(&mut self, r: u32) {
        self.i32c(0);
        self.mem(I64_LOAD, self.x + 8 * r);
        self.local(LOCAL_SET, X + r);
        self.loaded |= 1 << r;
    }

    /// Pop into x[rd] (x0: `SINK`, discarded).
    fn set_reg(&mut self, rd: u32) {
        if rd == 0 || rd == SINK as u32 {
            self.o(DROP);
        } else {
            self.local(LOCAL_SET, X + rd);
            self.loaded |= 1 << rd;
            self.dirty |= 1 << rd;
        }
    }

    /// Write the dirty registers back to memory (still dirty as far as the
    /// code after this, on the other path, is concerned).
    fn flush(&mut self) {
        for r in 1..32 {
            if self.dirty & 1 << r != 0 {
                self.i32c(0);
                self.local(LOCAL_GET, X + r);
                self.mem(I64_STORE, self.x + 8 * r);
            }
        }
    }

    /// Push the virtual address `offset` bytes from the page's start.
    fn pc_at(&mut self, offset: i64) {
        self.local(LOCAL_GET, PAGE);
        if offset != 0 {
            self.i64c(offset);
            self.o(I64_ADD);
        }
    }

    fn add_steps(&mut self, steps: u32) {
        self.local(LOCAL_GET, STEPS);
        self.i32c(steps as i32);
        self.o(I32_ADD);
        self.local(LOCAL_SET, STEPS);
    }

    /// retired = the count on entry + steps so far + `more`.
    fn set_retired(&mut self, more: u32) {
        self.i32c(0);
        self.local(LOCAL_GET, BASE);
        self.local(LOCAL_GET, STEPS);
        self.o(I64_EXTEND_I32_U);
        self.o(I64_ADD);
        if more != 0 {
            self.i64c(more as i64);
            self.o(I64_ADD);
        }
        self.mem(I64_STORE, self.retired);
    }

    /// Leave the function for the pc on the stack: go on in the compiled
    /// code there (if `chain`, and the chain cache knows it), or return.
    fn exit_to_stack(&mut self, chain: bool) {
        self.local(LOCAL_SET, PC_OUT);
        self.flush();
        self.br(if chain { self.chain } else { self.exit });
    }

    /// After `steps` more instructions, go on at `offset` from the page's
    /// start: the block there if it's compiled, else leave the function.
    fn goto(&mut self, steps: u32, offset: i64, case_at: &[u16]) {
        self.add_steps(steps);
        if let Some(self_loop) = self.self_loop.filter(|l| l.offset == offset) {
            // Back to the start of this case's loop, if there's budget left,
            // with its registers in their locals.
            let (loaded, dirty) = (self.loaded, self.dirty);
            self.local(LOCAL_GET, STEPS);
            self.local(LOCAL_GET, BUDGET);
            self.o(I32_GE_U);
            self.open(IF, EMPTY);
            self.pc_at(offset);
            self.exit_to_stack(false);
            self.close();
            for r in 1..32 {
                if self_loop.regs & !self.loaded & 1 << r != 0 {
                    self.preload(r); // (left in memory by jit_op)
                }
            }
            self.br(self_loop.label);
            (self.loaded, self.dirty) = (loaded, dirty);
            return;
        }
        let case = if (0..4096).contains(&offset) && offset & 1 == 0 { case_at[offset as usize / 2] } else { 0 };
        if case != 0 {
            self.i32c(case as i32 - 1);
            self.local(LOCAL_SET, NEXT);
            self.flush();
            self.br(self.top);
        } else {
            self.pc_at(offset);
            self.exit_to_stack(true);
        }
    }

    /// Run instruction `k` of a block (`ops[index]`, at `offset` in the
    /// page) through jit_op; leave the function if that says so (ENTRY:
    /// what it said).
    fn interpret(&mut self, k: u32, index: u32, offset: i64, op: &Op) {
        // jit_op works on the registers in memory, and the function may end
        // there: write them all back.
        let (_, writes) = registers(op);
        self.flush();
        self.dirty = 0;
        self.set_retired(k);
        self.local(LOCAL_GET, HART);
        self.i32c(index as i32);
        self.pc_at(offset);
        self.o(CALL);
        self.o(0); // the import
        self.local(LOCAL_TEE, ENTRY);
        self.open(IF, EMPTY);
        self.add_steps(k + 1);
        self.br(self.helper_exit);
        self.close();
        self.loaded &= !writes;
    }

    /// The slow path of a load or store: like `interpret`, but inside one
    /// arm of an `if`, so the registers' state after it is the other arm's.
    fn slow_path(&mut self, k: u32, index: u32, offset: i64, op: &Op) {
        let (loaded, dirty) = (self.loaded, self.dirty);
        self.interpret(k, index, offset, op);
        (self.loaded, self.dirty) = (loaded, dirty);
    }

    /// Compute a load's or store's address into ADDR, look its page up in
    /// the JIT TLB (ENTRY: the entry's offset), and push whether it hit.
    fn tlb_lookup(&mut self, op: &Op, width: i64, store: bool) {
        self.reg(op.rs1 as u32);
        if op.imm != 0 {
            self.i64c(op.imm as i64);
            self.o(I64_ADD);
        }
        self.local(LOCAL_TEE, ADDR);
        // Entry (addr >> 12) % TLB_SIZE, 32 bytes each.
        self.i64c(7);
        self.o(I64_SHR_U);
        self.o(I32_WRAP_I64);
        self.i32c(((TLB_SIZE - 1) << 5) as i32);
        self.o(I32_AND);
        self.local(LOCAL_TEE, ENTRY);
        self.mem(I64_LOAD, self.tlb + if store { 8 } else { 0 });
        // The tag: the page of the access's last byte (so one that crosses
        // into the next page misses), with the context.
        self.local(LOCAL_GET, ADDR);
        if width > 1 {
            self.i64c(width - 1);
            self.o(I64_ADD);
        }
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.local(LOCAL_GET, CTX);
        self.o(I64_OR);
        self.o(I64_EQ);
    }

    /// Push the access's address in linear memory.
    fn host_address(&mut self) {
        self.local(LOCAL_GET, ADDR);
        self.o(I32_WRAP_I64);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, self.tlb + 16);
        self.o(I32_ADD);
    }

    fn load(&mut self, k: u32, index: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
        self.tlb_lookup(op, width, false);
        self.open(IF, I64);
        self.host_address();
        self.mem(opcode, 0);
        self.o(ELSE);
        self.slow_path(k, index, offset, op);
        let rd = op.rd as u32;
        if rd == SINK as u32 {
            self.i64c(0);
        } else {
            self.i32c(0);
            self.mem(I64_LOAD, self.x + 8 * rd);
        }
        self.close();
        self.set_reg(rd);
    }

    fn store(&mut self, k: u32, index: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
        self.reg(op.rs2 as u32);
        self.local(LOCAL_SET, B);
        self.tlb_lookup(op, width, true);
        // A hit, on a page without code (Code::lines of its RAM page is 0).
        self.open(IF, I32);
        self.host_address();
        self.local(LOCAL_TEE, HOST);
        self.i32c(self.ram as i32);
        self.o(I32_SUB);
        self.i32c(12);
        self.o(I32_SHR_U);
        self.i32c(3);
        self.o(I32_SHL);
        self.mem(I64_LOAD, self.code_lines);
        self.o(I64_EQZ);
        self.o(ELSE);
        self.i32c(0);
        self.close();
        self.open(IF, EMPTY);
        self.local(LOCAL_GET, HOST);
        self.local(LOCAL_GET, B);
        self.mem(opcode, 0);
        self.o(ELSE);
        self.slow_path(k, index, offset, op);
        self.close();
    }

    /// x[rd] = x[rs1] op x[rs2] (64 bits).
    fn binary(&mut self, op: &Op, opcode: u8) {
        self.reg(op.rs1 as u32);
        self.reg(op.rs2 as u32);
        self.o(opcode);
        self.set_reg(op.rd as u32);
    }

    /// x[rd] = x[rs1] op imm (64 bits).
    fn binary_imm(&mut self, op: &Op, opcode: u8) {
        self.reg(op.rs1 as u32);
        self.i64c(op.imm as i64);
        self.o(opcode);
        self.set_reg(op.rd as u32);
    }

    /// x[rd] = sign-extended (x[rs1] op x[rs2]) on the low 32 bits.
    fn binary_w(&mut self, op: &Op, opcode: u8) {
        self.reg(op.rs1 as u32);
        self.o(I32_WRAP_I64);
        self.reg(op.rs2 as u32);
        self.o(I32_WRAP_I64);
        self.o(opcode);
        self.o(I64_EXTEND_I32_S);
        self.set_reg(op.rd as u32);
    }

    fn binary_imm_w(&mut self, op: &Op, opcode: u8) {
        self.reg(op.rs1 as u32);
        self.o(I32_WRAP_I64);
        self.i32c(op.imm);
        self.o(opcode);
        self.o(I64_EXTEND_I32_S);
        self.set_reg(op.rd as u32);
    }

    /// x[rd] = x[rs1] < x[rs2] / imm (`opcode` compares).
    fn set_less(&mut self, op: &Op, opcode: u8, imm: bool) {
        self.reg(op.rs1 as u32);
        if imm {
            self.i64c(op.imm as i64);
        } else {
            self.reg(op.rs2 as u32);
        }
        self.o(opcode);
        self.o(I64_EXTEND_I32_U);
        self.set_reg(op.rd as u32);
    }

    /// Division and remainder as RISC-V has them: no traps. A and B hold
    /// the operands (for 32-bit ones, `w`, their low halves are used).
    /// `by_zero`: what x / 0 gives (None: x); `by_minus_one`: whether x / -1
    /// is special (signed division, which overflows for the most negative x).
    fn divide(&mut self, op: &Op, opcode: u8, w: bool, by_zero: Option<i64>, by_minus_one: bool) {
        let ty = if w { I32 } else { I64 };
        let operand = |e: &mut Self, local| {
            e.local(LOCAL_GET, local);
            if w {
                e.o(I32_WRAP_I64);
            }
        };
        self.reg(op.rs1 as u32);
        self.local(LOCAL_SET, A);
        self.reg(op.rs2 as u32);
        self.local(LOCAL_SET, B);
        operand(self, B);
        self.o(if w { I32_EQZ } else { I64_EQZ });
        self.open(IF, ty);
        match by_zero {
            Some(v) if w => self.i32c(v as i32),
            Some(v) => self.i64c(v),
            None => operand(self, A),
        }
        self.o(ELSE);
        if by_minus_one {
            // x / -1 = -x (wrapping); x % -1 = 0.
            operand(self, B);
            if w {
                self.i32c(-1);
                self.o(I32_EQ);
            } else {
                self.i64c(-1);
                self.o(I64_EQ);
            }
            self.open(IF, ty);
            if w {
                self.i32c(0);
            } else {
                self.i64c(0);
            }
            if opcode == I32_DIV_S || opcode == I64_DIV_S {
                operand(self, A);
                self.o(if w { I32_SUB } else { I64_SUB });
            }
            self.o(ELSE);
        }
        operand(self, A);
        operand(self, B);
        self.o(opcode);
        if by_minus_one {
            self.close();
        }
        self.close();
        if w {
            self.o(I64_EXTEND_I32_S);
        }
        self.set_reg(op.rd as u32);
    }

    /// A conditional branch: if taken, go to its target.
    fn branch(&mut self, k: u32, offset: i64, op: &Op, opcode: u8, case_at: &[u16]) {
        self.reg(op.rs1 as u32);
        self.reg(op.rs2 as u32);
        self.o(opcode);
        self.open(IF, EMPTY);
        self.goto(k + 1, offset.wrapping_add(op.imm as i64), case_at);
        self.close();
    }

    /// The function body for the page's blocks (`jit.cases`). Returns false
    /// if it got too big.
    fn page(mut self, hart: &Hart) -> bool {
        let cases = &hart.jit.cases;
        let case_at = &hart.jit.case_at[..];
        let n = cases.len() as u32;
        // Locals: 36 i64 (x1..x31, ADDR, A, B, CTX, PC_OUT), 3 i32 (ENTRY, FETCH, HOST).
        self.out.extend_from_slice(&[2, 36, I64, 3, I32]);
        self.i32c(0);
        self.mem(I64_LOAD, self.ctx);
        self.local(LOCAL_SET, CTX);

        self.exit = self.open(BLOCK, EMPTY);
        self.chain = self.open(BLOCK, EMPTY);
        self.helper_exit = self.open(BLOCK, EMPTY);
        self.top = self.open(LOOP, EMPTY);
        // The switch: case i's code follows the end of the i-th innermost block.
        for _ in 0..=n {
            self.open(BLOCK, EMPTY);
        }
        self.local(LOCAL_GET, NEXT);
        self.o(BR_TABLE);
        uleb(self.out, n as u64);
        for i in 0..=n {
            uleb(self.out, i as u64);
        }
        for (case, &index) in cases.iter().enumerate() {
            self.close();
            (self.loaded, self.dirty) = (0, 0);
            let block = hart.blocks[index as usize];
            let length = hart.jit.lengths[case] as u32;
            let start_offset = (block.pa & 0xfff) as i64;
            // The budget used up: leave. (Once started, a case runs to its end:
            // see Hart::run.)
            self.local(LOCAL_GET, STEPS);
            self.local(LOCAL_GET, BUDGET);
            self.o(I32_GE_U);
            self.open(IF, EMPTY);
            self.pc_at(start_offset);
            self.exit_to_stack(false);
            self.close();

            // A loop of this block alone: its registers loaded first, and
            // (written back at every way out of it, as if all it writes were
            // changed: they're all in their locals) kept there.
            let ops = &hart.ops[block.start as usize..(block.start + length) as usize];
            if loops_to(ops, start_offset) {
                let (reads, writes) = ops.iter().fold((0, 0), |(r, w), op| {
                    let (reads, writes) = registers(op);
                    (r | reads, w | writes)
                });
                for r in 1..32 {
                    if (reads | writes) & 1 << r != 0 {
                        self.preload(r);
                    }
                }
                self.dirty = writes;
                let label = self.open(LOOP, EMPTY);
                self.self_loop = Some(SelfLoop { label, offset: start_offset, regs: reads | writes });
            }

            let mut offset = start_offset;
            let mut ended = false;
            for k in 0..length {
                if self.out.capacity() - self.out.len() < 4096 {
                    return false;
                }
                let op = hart.ops[(block.start + k) as usize];
                ended = self.op(k, block.start + k, offset, &op, case_at);
                offset += op.len as i64;
                if ended {
                    break;
                }
            }
            if !ended {
                let next = (0..4096).contains(&offset).then(|| case_at[offset as usize / 2]);
                if next == Some(case as u16 + 2) {
                    // Into the next case, whose code comes right after this one's
                    // (cases are in address order): no need for the switch.
                    self.add_steps(length);
                    self.flush();
                } else {
                    self.goto(length, offset, case_at);
                }
            }
            if self.self_loop.take().is_some() {
                self.close();
            }
        }
        self.close();
        self.o(UNREACHABLE);
        self.close(); // the loop
        self.close(); // helper_exit: jit_op set pc and retired; ENTRY is 1 or 2
        self.local(LOCAL_GET, ENTRY);
        self.i32c(1);
        self.o(I32_EQ);
        self.open(IF, EMPTY);
        self.local(LOCAL_GET, STEPS);
        self.o(RETURN);
        self.close();
        // Go on at pc (counting from the retired count jit_op left: a trap
        // isn't an instruction retired, but it's a step).
        self.i32c(0);
        self.mem(I64_LOAD, self.pc);
        self.local(LOCAL_SET, PC_OUT);
        self.i32c(0);
        self.mem(I64_LOAD, self.retired);
        self.local(LOCAL_GET, STEPS);
        self.o(I64_EXTEND_I32_U);
        self.o(I64_SUB);
        self.local(LOCAL_SET, BASE);
        self.close(); // chain: (registers written back)
        self.chain_lookup();
        self.close(); // exit: (registers written back)
        self.i32c(0);
        self.local(LOCAL_GET, PC_OUT);
        self.mem(I64_STORE, self.pc);
        self.set_retired(0);
        self.local(LOCAL_GET, STEPS);
        self.o(END);
        true
    }

    /// If the chain cache has compiled code for PC_OUT (of this epoch, and
    /// the fetch cache maps its page to the same physical page): go on
    /// there (a tail call, with the steps so far).
    fn chain_lookup(&mut self) {
        // The entry: (pc >> 1) % CHAIN_SIZE, 32 bytes each.
        self.local(LOCAL_GET, PC_OUT);
        self.o(I32_WRAP_I64);
        self.i32c(4);
        self.o(I32_SHL);
        self.i32c(((CHAIN_SIZE - 1) << 5) as i32);
        self.o(I32_AND);
        self.local(LOCAL_TEE, ENTRY);
        self.mem(I64_LOAD, self.chains);
        self.local(LOCAL_GET, PC_OUT);
        self.o(I64_EQ);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I64_LOAD, self.chains + 8);
        self.i32c(0);
        self.mem(I64_LOAD, self.chain_ctx);
        self.o(I64_EQ);
        self.o(I32_AND);
        // The fetch cache entry: (pc >> 12) % FETCH_CACHE.
        self.local(LOCAL_GET, PC_OUT);
        self.o(I32_WRAP_I64);
        self.i32c(9);
        self.o(I32_SHR_U);
        self.i32c(((FETCH_CACHE - 1) << 3) as i32);
        self.o(I32_AND);
        self.local(LOCAL_TEE, FETCH);
        self.mem(I64_LOAD, self.fetch_tags);
        self.local(LOCAL_GET, PC_OUT);
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.i32c(0);
        self.mem(I64_LOAD, self.fetch_ctx);
        self.o(I64_OR);
        self.o(I64_EQ);
        self.o(I32_AND);
        self.local(LOCAL_GET, FETCH);
        self.i32c(1);
        self.o(I32_SHR_U);
        self.mem(I32_LOAD, self.fetch_pages);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, self.chains + 24);
        self.o(I32_EQ);
        self.o(I32_AND);
        self.open(IF, EMPTY);
        self.local(LOCAL_GET, HART);
        self.local(LOCAL_GET, PC_OUT);
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, self.chains + 20);
        self.local(LOCAL_GET, BUDGET);
        self.local(LOCAL_GET, STEPS);
        self.local(LOCAL_GET, BASE);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, self.chains + 16);
        self.o(RETURN_CALL_INDIRECT);
        self.o(0); // the type: Compiled
        self.o(0); // the table
        self.close();
    }

    /// Instruction `k` of a block; returns whether it ends the block.
    fn op(&mut self, k: u32, index: u32, offset: i64, op: &Op, case_at: &[u16]) -> bool {
        use Kind::*;
        let next = offset + op.len as i64;
        match op.kind {
            Addi => self.binary_imm(op, I64_ADD),
            Slti => self.set_less(op, I64_LT_S, true),
            Sltiu => self.set_less(op, I64_LT_U, true),
            Xori => self.binary_imm(op, I64_XOR),
            Ori => self.binary_imm(op, I64_OR),
            Andi => self.binary_imm(op, I64_AND),
            Slli => self.binary_imm(op, I64_SHL),
            Srli => self.binary_imm(op, I64_SHR_U),
            Srai => self.binary_imm(op, I64_SHR_S),
            Lui => {
                self.i64c(op.imm as i64);
                self.set_reg(op.rd as u32);
            }
            Auipc => {
                self.pc_at(offset.wrapping_add(op.imm as i64));
                self.set_reg(op.rd as u32);
            }
            // (WebAssembly's shifts take the amount modulo the width, as RISC-V's.)
            Add => self.binary(op, I64_ADD),
            Sub => self.binary(op, I64_SUB),
            Sll => self.binary(op, I64_SHL),
            Slt => self.set_less(op, I64_LT_S, false),
            Sltu => self.set_less(op, I64_LT_U, false),
            Xor => self.binary(op, I64_XOR),
            Srl => self.binary(op, I64_SHR_U),
            Sra => self.binary(op, I64_SHR_S),
            Or => self.binary(op, I64_OR),
            And => self.binary(op, I64_AND),
            Mul => self.binary(op, I64_MUL),
            Div => self.divide(op, I64_DIV_S, false, Some(-1), true),
            Divu => self.divide(op, I64_DIV_U, false, Some(-1), false),
            Rem => self.divide(op, I64_REM_S, false, None, true),
            Remu => self.divide(op, I64_REM_U, false, None, false),
            Addiw => self.binary_imm_w(op, I32_ADD),
            Slliw => self.binary_imm_w(op, I32_SHL),
            Srliw => self.binary_imm_w(op, I32_SHR_U),
            Sraiw => self.binary_imm_w(op, I32_SHR_S),
            Addw => self.binary_w(op, I32_ADD),
            Subw => self.binary_w(op, I32_SUB),
            Sllw => self.binary_w(op, I32_SHL),
            Srlw => self.binary_w(op, I32_SHR_U),
            Sraw => self.binary_w(op, I32_SHR_S),
            Mulw => self.binary_w(op, I32_MUL),
            Divw => self.divide(op, I32_DIV_S, true, Some(-1), true),
            Divuw => self.divide(op, I32_DIV_U, true, Some(-1), false),
            Remw => self.divide(op, I32_REM_S, true, None, true),
            Remuw => self.divide(op, I32_REM_U, true, None, false),
            Lb => self.load(k, index, offset, op, 1, 0x30),
            Lbu => self.load(k, index, offset, op, 1, 0x31),
            Lh => self.load(k, index, offset, op, 2, 0x32),
            Lhu => self.load(k, index, offset, op, 2, 0x33),
            Lw => self.load(k, index, offset, op, 4, 0x34),
            Lwu => self.load(k, index, offset, op, 4, 0x35),
            Ld => self.load(k, index, offset, op, 8, I64_LOAD),
            Sb => self.store(k, index, offset, op, 1, 0x3c),
            Sh => self.store(k, index, offset, op, 2, 0x3d),
            Sw => self.store(k, index, offset, op, 4, 0x3e),
            Sd => self.store(k, index, offset, op, 8, I64_STORE),
            Beq => self.branch(k, offset, op, I64_EQ, case_at),
            Bne => self.branch(k, offset, op, I64_NE, case_at),
            Blt => self.branch(k, offset, op, I64_LT_S, case_at),
            Bge => self.branch(k, offset, op, I64_GE_S, case_at),
            Bltu => self.branch(k, offset, op, I64_LT_U, case_at),
            Bgeu => self.branch(k, offset, op, I64_GE_U, case_at),
            Jal => {
                self.pc_at(next);
                self.set_reg(op.rd as u32);
                self.goto(k + 1, offset.wrapping_add(op.imm as i64), case_at);
                return true;
            }
            Jalr => {
                self.reg(op.rs1 as u32);
                self.i64c(op.imm as i64);
                self.o(I64_ADD);
                self.i64c(!1);
                self.o(I64_AND);
                self.local(LOCAL_SET, A);
                self.pc_at(next);
                self.set_reg(op.rd as u32);
                self.add_steps(k + 1);
                self.local(LOCAL_GET, A);
                self.exit_to_stack(true);
                return true;
            }
            // Through the interpreter, continuing.
            Mulh | Mulhsu | Mulhu | Execute => self.interpret(k, index, offset, op),
            // Through the interpreter, then on through the chain cache:
            // these can change privilege, translation (which the function
            // assumes doesn't change), interrupts (jit_op leaves for those).
            ExecuteEnd | Illegal => {
                self.interpret(k, index, offset, op);
                self.add_steps(k + 1);
                self.pc_at(next);
                self.exit_to_stack(true);
                return true;
            }
        }
        false
    }
}
