//! The JIT: hot code compiled to WebAssembly, which the host (V8) compiles to
//! machine code.
//!
//! The unit is a page of RAM: its hot blocks (blocks.rs) become one
//! function, a loop around a switch over them, so jumps between them (loops,
//! branches, calls within the page) stay inside the function; those to a
//! block further on go straight to its code, the others through the
//! switch. When the code
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
//! The harts share what's compiled. A page that has run `threshold`
//! instructions the regular way (by any hart, since it was last compiled, or
//! its code changed) is queued; once `batch` pages are queued (or they've
//! waited long enough), the hart that notices compiles each (again, if it
//! was before), with all its blocks in its cache and those of the page's
//! previous function, together into one module, which src/cpu.ts
//! instantiates against this module's memory, putting the functions into
//! the instance's function table. RAM page `p` owns table slot `base + p`,
//! so a page's code is called with a plain indirect call, never leaving
//! WebAssembly. Harts running in other instances of the core (on threads of
//! their own) install the module in theirs from a log (`JitShared`), and
//! find their blocks in it through its case lists: the code is the same for
//! every hart (it finds the hart's things from the hart pointer it's
//! passed), so it's compiled once.
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
//!   `jit_op` (the interpreter), which then refills the TLB. A block's
//!   accesses off the same value (a register, or what it was plus a
//!   constant: a stack frame, a structure, the two sides of a copy) share
//!   one check, by the first of them, for all of their range
//!   (`memory_groups`): the others just add the page's offset. When it
//!   fails, jit_op checks again after the first access (which may have put
//!   the page in the TLB), so the rest needn't go through it too; that also
//!   takes a range on two pages that follow each other in RAM.
//! - Each compiled function is named after its page's physical address
//!   ("pa_80a3f000"), as profilers (node --cpu-prof) show it.
//! - Atomics (AMOs but MIN/MAX, LR, SC) to RAM go straight to memory too,
//!   with WebAssembly's atomic instructions, when naturally aligned on a
//!   page the JIT TLB has for stores (for LR, loads), without code.
//! - Whatever isn't compiled (floating point, AMOMIN/MAX, CSRs but reading
//!   sstatus or setting or clearing its SIE, system instructions) also
//!   runs through `jit_op` (passed the decoded
//!   instruction). Only `jit_op` can reach devices, so it also ends the
//!   function when one raised an interrupt or stopped the CPU, or when code
//!   was written (which may be the function's own). CSR instructions (but
//!   for satp) go on after it; the other system instructions end the block.
//! - A jump that the chain cache finds on the function's own page (a return
//!   to it, say) goes on through the switch, without a call.
//!
//! Functions take the page's virtual address as a parameter: the same
//! physical code may run at several (shared libraries).

use crate::blocks::{Block, FETCH_CACHE, Kind, Op, SINK};
use crate::csr::{MSTATUS_FS, MSTATUS_SIE, PRIV_S};
use crate::hart::{Hart, NO_RESERVATION, SSTATUS_VISIBLE, SSTATUS_WRITABLE};
use crate::mmu::TLB_SIZE;
use core::cell::UnsafeCell;
use core::sync::atomic::Ordering::{Acquire, Relaxed, Release, SeqCst};
use core::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, AtomicU16, AtomicU32, AtomicU64, fence};

// Implemented by src/cpu.ts (and src/hart-worker.ts): `jit_load` copies
// `code` (a module); `jit_install` compiles the module copied last,
// instantiates it and puts its exported functions "0", "1", ... into the
// table at `slots`. Returns 1 on success.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn jit_load(code: *const u8, len: u32);
    fn jit_install(slots: *const u32, count: u32) -> u32;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn jit_load(_: *const u8, _: u32) {}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn jit_install(_: *const u32, _: u32) -> u32 {
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

/// Case lists (the offsets of functions' cases in their pages, halved) take
/// at most this many entries in all (`JitShared::offsets`), then start over.
const OFFSETS: usize = 1 << 21;
/// The log of compiled modules, for the tables of other instances (on other
/// threads): this many bytes, which take the latest modules...
const LOG_SIZE: usize = 16 << 20;
/// ...of which this many are indexed.
const LOG_INDEX: usize = 4096;

/// What the harts share about compiled code (allocated with the RAM, like
/// `Code`): which pages are hot, the queue of pages to compile, the latest
/// function of each page, and the modules compiled, numbered from 1.
///
/// One hart at a time queues and compiles pages: the one holding `lock`
/// (another just tries again later). A module is compiled once: the harts
/// of other instances of the core install it from the log.
pub struct JitShared {
    lock: AtomicU32,
    /// Pages waiting to be compiled (under the lock), and how many.
    queue: UnsafeCell<Vec<u32>>,
    queue_len: AtomicU32,
    /// Per RAM page: instructions run the regular way (by any hart) since it
    /// was last compiled (or its code changed); whether it's queued; how
    /// often it's been compiled, and the version of its code it was last
    /// compiled from.
    steps: Vec<AtomicU32>,
    queued: Vec<AtomicBool>,
    compiles: Vec<AtomicU8>,
    compiled_version: Vec<AtomicU32>,
    /// Per RAM page: its latest function's module and code version
    /// (`module << 32 | version`), and where its case list is in
    /// `offsets` (`start << 32 | count`).
    function: Vec<AtomicU64>,
    cases: Vec<AtomicU64>,
    offsets: Vec<AtomicU16>,
    /// Entries of `offsets` in use (under the lock), and the first module
    /// whose case lists are all still there.
    offsets_used: UnsafeCell<usize>,
    floor: AtomicU32,
    /// The modules compiled so far.
    modules: AtomicU32,
    /// The log (LOG_SIZE bytes; allocated with the first table for another
    /// thread, else none): each module as its page count (u32), its pages
    /// (u32 each), its code; `written` is how many bytes have been written
    /// in all (a module's bytes are intact while it's at most LOG_SIZE past
    /// where they start). Module n is at `index[n % LOG_INDEX]`: where it
    /// starts, and `n << 32 | length`.
    log: AtomicPtr<u8>,
    written: AtomicU64,
    index: Vec<[AtomicU64; 2]>,
}

// SAFETY: what isn't atomic is only used under the lock.
unsafe impl Sync for JitShared {}

/// For harts without RAM (no JIT).
pub static NO_JIT: JitShared = JitShared {
    lock: AtomicU32::new(0),
    queue: UnsafeCell::new(Vec::new()),
    queue_len: AtomicU32::new(0),
    steps: Vec::new(),
    queued: Vec::new(),
    compiles: Vec::new(),
    compiled_version: Vec::new(),
    function: Vec::new(),
    cases: Vec::new(),
    offsets: Vec::new(),
    offsets_used: UnsafeCell::new(0),
    floor: AtomicU32::new(0),
    modules: AtomicU32::new(0),
    log: AtomicPtr::new(core::ptr::null_mut()),
    written: AtomicU64::new(0),
    index: Vec::new(),
};

impl JitShared {
    pub fn new(pages: usize) -> JitShared {
        JitShared {
            lock: AtomicU32::new(0),
            queue: UnsafeCell::new(Vec::with_capacity(MAX_QUEUE)),
            queue_len: AtomicU32::new(0),
            steps: (0..pages).map(|_| AtomicU32::new(0)).collect(),
            queued: (0..pages).map(|_| AtomicBool::new(false)).collect(),
            compiles: (0..pages).map(|_| AtomicU8::new(0)).collect(),
            compiled_version: (0..pages).map(|_| AtomicU32::new(0)).collect(),
            function: (0..pages).map(|_| AtomicU64::new(0)).collect(),
            cases: (0..pages).map(|_| AtomicU64::new(0)).collect(),
            offsets: (0..OFFSETS).map(|_| AtomicU16::new(0)).collect(),
            offsets_used: UnsafeCell::new(0),
            floor: AtomicU32::new(0),
            modules: AtomicU32::new(0),
            log: AtomicPtr::new(core::ptr::null_mut()),
            written: AtomicU64::new(0),
            index: (0..LOG_INDEX).map(|_| [AtomicU64::new(0), AtomicU64::new(0)]).collect(),
        }
    }

    /// Allocate the log, if it isn't (before the threads that read it start).
    pub fn allocate_log(&self) {
        if self.log.load(Relaxed).is_null() {
            self.log.store(vec![0u8; LOG_SIZE].leak().as_mut_ptr(), SeqCst);
        }
    }

    fn try_lock(&self) -> bool {
        self.lock.compare_exchange(0, 1, Acquire, Relaxed).is_ok()
    }

    fn unlock(&self) {
        self.lock.store(0, Release);
    }

    /// Before compiling module `module`: start `offsets` over if its case
    /// lists might not fit (those of the modules before then no longer count).
    fn make_room(&self, module: u32) {
        // SAFETY: under the lock.
        let used = unsafe { &mut *self.offsets_used.get() };
        if *used + MAX_PENDING > OFFSETS {
            *used = 0;
            self.floor.store(module, SeqCst);
            fence(SeqCst);
        }
    }

    /// Room for `count` entries in `offsets` (make_room made sure there is).
    fn offsets_for(&self, count: usize) -> usize {
        // SAFETY: under the lock.
        let used = unsafe { &mut *self.offsets_used.get() };
        let start = *used;
        *used += count;
        start
    }

    /// Whether the log still has the bytes written from `pos`.
    fn intact(&self, pos: u64) -> bool {
        self.written.load(SeqCst) <= pos + LOG_SIZE as u64
    }

    /// Make module `module` (its code, for `pages`, whose case lists are
    /// `lists`: start, count, version) the latest function of those pages,
    /// and put it in the log.
    fn publish(&self, module: u32, pages: &[u32], lists: &[(u32, u32, u32)], code: &[u8]) {
        let log = self.log.load(Relaxed);
        if !log.is_null() {
            let len = 4 + 4 * pages.len() + code.len();
            let mut pos = self.written.load(Relaxed);
            if pos as usize % LOG_SIZE + len > LOG_SIZE {
                pos = pos.next_multiple_of(LOG_SIZE as u64); // (all in one piece)
            }
            // Written first: a reader of what's overwritten sees it's gone.
            self.written.store(pos + len as u64, SeqCst);
            fence(SeqCst);
            // SAFETY: the log has LOG_SIZE bytes, and len fits (MAX_MODULE).
            unsafe {
                let at = log.add(pos as usize % LOG_SIZE);
                at.cast::<u32>().write_unaligned(pages.len() as u32);
                core::ptr::copy_nonoverlapping(pages.as_ptr().cast::<u8>(), at.add(4), 4 * pages.len());
                core::ptr::copy_nonoverlapping(code.as_ptr(), at.add(4 + 4 * pages.len()), code.len());
            }
            let entry = &self.index[module as usize % LOG_INDEX];
            entry[1].store(0, SeqCst);
            entry[0].store(pos, SeqCst);
            entry[1].store((module as u64) << 32 | len as u64, SeqCst);
        }
        for (&page, &(start, count, version)) in pages.iter().zip(lists) {
            self.cases[page as usize].store((start as u64) << 32 | count as u64, Release);
            self.function[page as usize].store((module as u64) << 32 | version as u64, Release);
        }
        self.modules.store(module, Release);
    }
}

/// An instance's function table, as far as the JIT is concerned: shared by
/// the harts running in that instance (one per thread, or all of them
/// taking turns), each of which has its own.
pub struct Table {
    /// The table slot of RAM page 0.
    pub(crate) base: u32,
    /// Modules installed (or passed over: gone from the log): all up to this one.
    installed: u32,
    /// Bumped by every install (harts then forget their chains).
    epoch: u32,
    /// Per RAM page: the module whose function is in its slot (0: none).
    pub(crate) slot_module: Vec<u32>,
    /// Scratch: the pages and slots of a module being installed.
    pages: Vec<u32>,
    slots: Vec<u32>,
}

impl Table {
    pub fn new(pages: usize) -> Table {
        Table {
            base: 0,
            installed: 0,
            epoch: 0,
            slot_module: vec![0; pages],
            pages: Vec::with_capacity(MAX_QUEUE),
            slots: Vec::with_capacity(MAX_QUEUE),
        }
    }

    /// For a new function table at `base` (empty).
    pub fn reset(&mut self, base: u32) {
        self.base = base;
        self.installed = 0;
        self.epoch = self.epoch.wrapping_add(1);
        self.slot_module.fill(0);
    }
}

pub struct Jit {
    pub enabled: bool,
    /// The table of the instance the hart runs in, and its epoch when the
    /// hart last looked.
    pub table: *mut Table,
    table_epoch: u32,
    /// Instructions run the regular way before a page is compiled, and how
    /// many pages are compiled together.
    pub threshold: u32,
    pub batch: usize,
    /// Instructions this hart has run the regular way since it last saw the
    /// queue empty, or compiled.
    waited: u32,
    /// The module being built, a function's code, the code section, the
    /// slots and pages, and the pages' case lists (start, count, version).
    module: Vec<u8>,
    function: Vec<u8>,
    bodies: Vec<u8>,
    slots: Vec<u32>,
    pages: Vec<u32>,
    lists: Vec<(u32, u32, u32)>,
    /// The blocks compiled in this batch (cache index, case, address),
    /// marked compiled once installed (if they're still there).
    pending: Vec<(u32, u32, u64)>,
    /// The page being compiled: its blocks (cache indexes, by address), and
    /// for each 2-byte offset in the page, the case of the block starting
    /// there, plus 1 (0: none).
    cases: Vec<u32>,
    case_at: Vec<u16>,
    lengths: Vec<u16>,
}

impl Jit {
    pub const fn new() -> Jit {
        Jit {
            enabled: false,
            table: core::ptr::null_mut(),
            table_epoch: 0,
            threshold: 0,
            batch: 0,
            waited: 0,
            module: Vec::new(),
            function: Vec::new(),
            bodies: Vec::new(),
            slots: Vec::new(),
            pages: Vec::new(),
            lists: Vec::new(),
            pending: Vec::new(),
            cases: Vec::new(),
            case_at: Vec::new(),
            lengths: Vec::new(),
        }
    }

    /// Allocate the buffers, once (nothing may allocate later: see lib.rs).
    pub fn allocate(&mut self) {
        // (The module: its sections, exports, and the code section: up to
        // MAX_MODULE, plus one more function, of up to MAX_FUNCTION plus an
        // instruction's and the end's code.)
        self.function = Vec::with_capacity(MAX_FUNCTION + 4096);
        self.bodies = Vec::with_capacity(MAX_MODULE + 2 * MAX_FUNCTION);
        self.module = Vec::with_capacity(MAX_MODULE + 2 * MAX_FUNCTION + 16 * MAX_QUEUE + 4096);
        self.slots = Vec::with_capacity(MAX_QUEUE);
        self.pages = Vec::with_capacity(MAX_QUEUE);
        self.lists = Vec::with_capacity(MAX_QUEUE);
        self.pending = Vec::with_capacity(MAX_PENDING);
        self.cases = Vec::with_capacity(2048);
        self.case_at = vec![0; 2048];
        self.lengths = Vec::with_capacity(2048);
    }
}

impl Hart {
    #[inline(always)]
    pub(crate) fn jit_table(&self) -> &Table {
        // SAFETY: set by jit_init (with `enabled`); lives forever.
        unsafe { &*self.jit.table }
    }

    #[allow(clippy::mut_from_ref)]
    fn jit_table_mut(&self) -> &mut Table {
        // SAFETY: as jit_table; only this thread uses it, and no reference
        // to it is held across this.
        unsafe { &mut *self.jit.table }
    }

    /// Use the table at `table` (an instance's, new: it's emptied) from now on.
    pub fn jit_use_table(&mut self, table: *mut Table, base: u32) {
        self.jit.table = table;
        self.jit_table_mut().reset(base);
        self.jit.table_epoch = self.jit_table().epoch;
        self.forget_chains();
    }

    /// Before running: install the modules other instances compiled, and
    /// forget the chains if the table changed.
    #[inline(always)]
    pub(crate) fn jit_catch_up(&mut self) {
        if self.jits.modules.load(Relaxed) != self.jit_table().installed {
            self.jit_sync();
        }
        if self.jit_table().epoch != self.jit.table_epoch {
            self.jit.table_epoch = self.jit_table().epoch;
            self.forget_chains();
        }
    }

    /// Install the modules compiled since the table's last, in order, from
    /// the log (those gone from it are passed over: their pages run the
    /// regular way until compiled again).
    #[inline(never)]
    fn jit_sync(&mut self) {
        let shared = self.jits;
        let latest = shared.modules.load(Acquire);
        let log = shared.log.load(Acquire);
        let table = self.jit_table_mut();
        while table.installed < latest {
            let n = table.installed + 1;
            table.installed = n;
            if log.is_null() {
                continue;
            }
            let entry = &shared.index[n as usize % LOG_INDEX];
            let tag = entry[1].load(SeqCst);
            let pos = entry[0].load(SeqCst);
            if tag >> 32 != n as u64 || entry[1].load(SeqCst) != tag || !shared.intact(pos) {
                continue;
            }
            let len = tag as u32 as usize;
            // (Read while another thread may be overwriting it: checked after.)
            // SAFETY: the entry is in the log, in one piece.
            let at = unsafe { log.add(pos as usize % LOG_SIZE) };
            let count = unsafe { at.cast::<u32>().read_unaligned() } as usize;
            if count > MAX_QUEUE || 4 + 4 * count > len {
                continue;
            }
            table.pages.clear();
            table.slots.clear();
            for i in 0..count {
                // SAFETY: as above: within the entry.
                let page = unsafe { at.add(4 + 4 * i).cast::<u32>().read_unaligned() };
                let page = page.min(table.slot_module.len() as u32 - 1);
                table.pages.push(page);
                table.slots.push(table.base + page);
            }
            // SAFETY: an import implemented in JavaScript, which copies the bytes.
            unsafe { jit_load(at.add(4 + 4 * count), (len - 4 - 4 * count) as u32) };
            fence(SeqCst);
            if !shared.intact(pos) {
                continue;
            }
            // SAFETY: an import implemented in JavaScript; it only reads the buffer.
            if unsafe { jit_install(table.slots.as_ptr(), count as u32) } != 0 {
                for &page in &table.pages {
                    table.slot_module[page as usize] = n;
                }
                table.epoch = table.epoch.wrapping_add(1);
            }
        }
    }

    /// `steps` instructions of RAM `page` have run the regular way: queue
    /// the page when that's enough, and compile the queue when it's time.
    #[inline(always)]
    pub(crate) fn jit_account(&mut self, page: usize, steps: u32) {
        let shared = self.jits;
        // (Not atomically: another hart's steps may be lost, now and then.)
        let total = shared.steps[page].load(Relaxed).saturating_add(steps);
        shared.steps[page].store(total, Relaxed);
        if !shared.queued[page].load(Relaxed) {
            let version = self.code.versions[page].load(Relaxed);
            let backoff = if shared.compiled_version[page].load(Relaxed) == version {
                shared.compiles[page].load(Relaxed).min(MAX_BACKOFF)
            } else {
                0
            };
            if total >= self.jit.threshold << backoff {
                self.jit_queue(page);
            }
        }
        let queued = shared.queue_len.load(Relaxed);
        if queued == 0 {
            self.jit.waited = 0;
        } else {
            self.jit.waited += steps;
            if (self.jit.waited >= WAIT || queued as usize >= self.jit.batch.min(MAX_QUEUE)) && shared.try_lock() {
                self.jit_compile();
                shared.unlock();
            }
        }
    }

    #[inline(never)]
    fn jit_queue(&mut self, page: usize) {
        let shared = self.jits;
        if shared.try_lock() {
            // SAFETY: under the lock.
            let queue = unsafe { &mut *shared.queue.get() };
            if !shared.queued[page].load(Relaxed) && queue.len() < MAX_QUEUE {
                shared.queued[page].store(true, Relaxed);
                queue.push(page as u32);
                shared.queue_len.store(queue.len() as u32, Relaxed);
            }
            shared.unlock();
        }
    }

    /// Run RAM `page`'s compiled code from virtual `pc`, the start of its
    /// block `entry`, for up to `budget` steps.
    #[inline(always)]
    pub(crate) fn run_compiled(&mut self, page: usize, entry: u32, pc: u64, budget: u32) -> u32 {
        let slot = self.jit_table().base as usize + page;
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
        let slot = self.jit_table().base + page as u32;
        let e = &mut self.chain[(pc >> 1) as usize & (CHAIN_SIZE - 1)];
        e.pc = pc;
        e.ctx = self.chain_ctx;
        e.slot = slot;
        e.case = case;
        e.ppn = (pa >> 12) as u32;
    }

    /// Compiled code changed (or its blocks' ops went): forget the chain
    /// cache's entries, by starting a new epoch.
    pub(crate) fn forget_chains(&mut self) {
        self.chain_ctx = self.chain_ctx.wrapping_add(1);
    }

    /// `block` (of RAM `page`) isn't known to be in the function of module
    /// `installed`, now in the page's slot: look it up there (in its case
    /// list, if that's the page's latest function, of the block's code).
    #[inline(never)]
    pub(crate) fn jit_lookup(&self, mut block: Block, page: usize, installed: u32) -> Block {
        block.module = installed;
        if block.jit == COMPILED {
            block.jit = 0;
        }
        let shared = self.jits;
        let function = shared.function[page].load(Acquire);
        if installed == 0 || function != (installed as u64) << 32 | block.version as u64 {
            return block;
        }
        let cases = shared.cases[page].load(Acquire);
        let (start, count) = ((cases >> 32) as usize, cases as u32 as usize);
        let offset = ((block.pa & 0xfff) / 2) as u16;
        let at = |i: usize| shared.offsets[(start + i) % OFFSETS].load(Relaxed);
        let (mut low, mut high) = (0, count);
        while low < high {
            let mid = (low + high) / 2;
            if at(mid) < offset {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let found = low < count && at(low) == offset;
        // (Still the list read: the page's function is the same, and its list wasn't overwritten.)
        fence(SeqCst);
        if found && shared.function[page].load(SeqCst) == function && shared.floor.load(SeqCst) <= installed {
            block.jit = COMPILED;
            block.entry = low as u32;
        }
        block
    }

    /// Compile the queued pages (holding the lock): into a module, which is
    /// installed in this hart's table, and published for the others.
    #[inline(never)]
    fn jit_compile(&mut self) {
        // The table first has every module so far (they're installed in order).
        self.jit_sync();
        let shared = self.jits;
        let module = shared.modules.load(Relaxed) + 1;
        // SAFETY: under the lock.
        let queue = unsafe { &mut *shared.queue.get() };
        shared.make_room(module);
        let mut bodies = core::mem::take(&mut self.jit.bodies);
        let mut function = core::mem::take(&mut self.jit.function);
        bodies.clear();
        self.jit.slots.clear();
        self.jit.pages.clear();
        self.jit.lists.clear();
        self.jit.pending.clear();
        let base = self.jit_table().base;
        let mut taken = 0;
        for &page in queue.iter() {
            if bodies.len() > MAX_MODULE || self.jit.pending.len() + 2048 > MAX_PENDING {
                break; // the rest next time
            }
            taken += 1;
            let page = page as usize;
            shared.queued[page].store(false, Relaxed);
            shared.steps[page].store(0, Relaxed);
            let Some(version) = self.collect_cases(page) else { continue };
            function.clear();
            let emitter = Emitter::new(self, &mut function);
            if !emitter.page(self) {
                continue; // too big after all: (not expected)
            }
            uleb(&mut bodies, function.len() as u64);
            bodies.extend_from_slice(&function);
            self.jit.slots.push(base + page as u32);
            self.jit.pages.push(page as u32);
            let start = shared.offsets_for(self.jit.cases.len());
            for (case, &index) in self.jit.cases.iter().enumerate() {
                let pa = self.blocks[index as usize].pa;
                shared.offsets[start + case].store((pa & 0xfff) as u16 / 2, Relaxed);
                self.jit.pending.push((index, case as u32, pa));
            }
            self.jit.lists.push((start as u32, self.jit.cases.len() as u32, version));
            if shared.compiled_version[page].load(Relaxed) != version {
                shared.compiles[page].store(0, Relaxed); // new code
            }
            shared.compiles[page].store(shared.compiles[page].load(Relaxed).saturating_add(1), Relaxed);
            shared.compiled_version[page].store(version, Relaxed);
        }
        queue.drain(..taken);
        shared.queue_len.store(queue.len() as u32, Relaxed);
        self.jit.waited = 0;
        self.jit.function = function;

        let count = self.jit.slots.len();
        if count > 0 {
            let mut code = core::mem::take(&mut self.jit.module);
            build_module(&mut code, &bodies, count, self.ram_base, &self.jit.pages);
            // SAFETY: imports implemented in JavaScript; they only read the buffers.
            let ok = unsafe {
                jit_load(code.as_ptr(), code.len() as u32);
                jit_install(self.jit.slots.as_ptr(), count as u32)
            } != 0;
            if ok {
                let table = self.jit_table_mut();
                for &page in &self.jit.pages {
                    table.slot_module[page as usize] = module;
                }
                table.installed = module;
                table.epoch = table.epoch.wrapping_add(1);
                shared.publish(module, &self.jit.pages, &self.jit.lists, &code);
                for &(index, case, pa) in &self.jit.pending {
                    let block = &mut self.blocks[index as usize];
                    if block.pa != pa {
                        continue; // (replaced by one decoded for a later page)
                    }
                    block.jit = COMPILED;
                    block.entry = case;
                    block.module = module;
                }
                self.forget_chains(); // (pages compiled again have new cases)
                self.jit.table_epoch = self.jit_table().epoch;
            } else {
                self.jit.enabled = false;
            }
            self.jit.module = code;
        }
        self.jit.bodies = bodies;
    }

    /// The blocks of RAM `page` of its current code (hot or not; this hart's,
    /// and those of its latest function, if that's of the same code) into
    /// `jit.cases`, by address, with `jit.case_at`, and how much of each to
    /// compile into `jit.lengths`: up to where another one starts (which then
    /// goes on), so each instruction is compiled once. Those beyond the limit
    /// are left out. Returns the code's version, if there are any.
    fn collect_cases(&mut self, page: usize) -> Option<u32> {
        self.jit.cases.clear();
        self.jit.case_at.fill(0);
        let version = self.code.versions[page].load(Relaxed);
        let page_pa = self.ram_base + ((page as u64) << 12);
        // Those of the latest function (perhaps another hart's) this hart
        // doesn't have: decoded now.
        let shared = self.jits;
        let function = shared.function[page].load(Relaxed);
        if function as u32 == version && (function >> 32) as u32 >= shared.floor.load(Relaxed) && function != 0 {
            let cases = shared.cases[page].load(Relaxed);
            for i in 0..cases as u32 as usize {
                let offset = shared.offsets[((cases >> 32) as usize + i) % OFFSETS].load(Relaxed) as u64 * 2;
                self.jit_decode(page_pa + offset);
            }
        }
        let lines = self.code.lines[page].load(Relaxed);
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
        (!self.jit.cases.is_empty()).then_some(version)
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

    /// An instruction that compiled code hands to the interpreter: `op` (as
    /// `Op::pack` made it) at `pc`, with `retired` already counting the
    /// instructions before it. Returns 0 to go on with the next instruction;
    /// otherwise pc and retired are updated, and it's 2 to go on at pc
    /// (after a jump or a trap), 1 to return to `run()`: a device stopped
    /// the CPU or raised an interrupt, the hart waits for one, or code was
    /// written.
    pub(crate) fn jit_op(&mut self, a: u64, b: u64, pc: u64) -> u32 {
        let op = Op::unpack(a, b);
        let next = pc.wrapping_add(op.len as u64);
        let addr = self.x[op.rs1 as usize].wrapping_add(op.imm as i64 as u64);
        // (An atomic's address: rs1 alone, its immediate is its bits.)
        let atomic = (op.kind == Kind::Execute && op.inst & 0x7f == 0x2f).then(|| self.x[op.rs1 as usize]);
        let group = core::mem::take(&mut self.jit_group);
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
                } else if let Some(addr) = atomic {
                    self.jit_fill(addr, op.inst >> 27 != 0b00010); // (LR: a load)
                }
                if group != 0 {
                    // A memory group's first access: its range, from where
                    // the group starts (`group`: from that, span, access).
                    let start = addr.wrapping_sub(op.imm as i64 as u64).wrapping_add(group as i32 as i64 as u64);
                    self.jit_group_ok = match self.jit_range(start, (group >> 32) as u16 as u64, (group >> 48) as u32) {
                        Some(host) => [1, host],
                        None => [0, 0],
                    };
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

    /// Whether the JIT TLB has bytes `addr..addr + span` on a page, or on two
    /// in a row that are in a row in RAM too (the same host offset), for
    /// `access` (1 loads, 2 stores, 3 both; stores: without code): their
    /// host offset if so. For a memory group whose check failed (see
    /// `Emitter::group_slow_path`), after its first access: its page may be
    /// there now, and a range that keeps crossing into the next page (a
    /// stack frame, say) would otherwise always fail. (Pages that aren't in
    /// a row in RAM still do: taking either's offset, as each access would
    /// then have to, costs all the code more than it saves.)
    fn jit_range(&self, addr: u64, span: u64, access: u32) -> Option<u32> {
        let last = addr.wrapping_add(span.max(1) - 1);
        if last >> 12 != addr >> 12 && last >> 12 != (addr >> 12).wrapping_add(1) {
            return None;
        }
        let host = self.jit_tlb[(addr >> 12) as usize & (TLB_SIZE - 1)].host;
        for page in [addr, last] {
            let e = &self.jit_tlb[(page >> 12) as usize & (TLB_SIZE - 1)];
            let tag = page & !0xfff | self.jit_ctx;
            if e.host != host || access & 1 != 0 && e.load != tag || access & 2 != 0 && e.store != tag {
                return None;
            }
            let offset = (page as u32).wrapping_add(host).wrapping_sub(self.ram as u32) >> 12;
            if access & 2 != 0 && self.code.lines[offset as usize].load(Relaxed) != 0 {
                return None;
            }
        }
        Some(host)
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
/// and naming each after the physical address of its page (`pages`, in RAM
/// at `ram_base`), as profilers show it: "pa_80a3f000".
fn build_module(out: &mut Vec<u8>, bodies: &[u8], count: usize, ram_base: u64, pages: &[u32]) {
    out.clear();
    out.extend_from_slice(b"\0asm\x01\0\0\0");
    // Types: 0 = (i32 hart, i64 page, i32 entry, i32 budget, i32 steps,
    // i64 base) -> i32 steps, the pages (Compiled); 1 = (i32 hart, i64 op,
    // i64 op, i64 pc) -> i32, jit_op.
    let s = begin_section(out, 1);
    out.extend_from_slice(&[2, 0x60, 6, I32, I64, I32, I32, I32, I64, 1, I32, 0x60, 4, I32, I64, I64, I64, 1, I32]);
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
    // The "name" custom section: its function names (subsection 1).
    let s = begin_section(out, 0);
    out.extend_from_slice(&[4, b'n', b'a', b'm', b'e', 1]);
    let names = out.len();
    out.extend_from_slice(&[0x80, 0x80, 0x80, 0x80, 0]);
    uleb(out, count as u64);
    for (i, &page) in pages.iter().enumerate().take(count) {
        uleb(out, i as u64 + 1); // (after the import)
        out.push(11);
        out.extend_from_slice(b"pa_");
        let pa = ram_base + ((page as u64) << 12);
        for shift in (0..8).rev() {
            out.push(b"0123456789abcdef"[(pa >> (4 * shift)) as usize & 15]);
        }
    }
    end_section(out, names + 5);
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
const I32_OR: u8 = 0x72;
const ATOMIC_PREFIX: u8 = 0xfe;
const ATOMIC_FENCE: u8 = 0x03;

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
/// Then, for each memory group (`memory_groups`) of the block being compiled,
/// two i32: whether its check passed, and its page's host offset.
const GROUP: u32 = 45;
/// Memory groups per block, at most (the rest go the regular way).
const MAX_GROUPS: usize = 8;

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

/// How many bytes a load or store accesses (None: not one compiled as such).
fn access_width(kind: Kind) -> Option<i64> {
    use Kind::*;
    match kind {
        Lb | Lbu | Sb => Some(1),
        Lh | Lhu | Sh => Some(2),
        Lw | Lwu | Sw => Some(4),
        Ld | Sd => Some(8),
        _ => None,
    }
}

/// The check a group's first access does, for all of them: bytes
/// `x[rs1] + from` to that plus `span`, on one page the JIT TLB has, for
/// loads and/or stores (then holding no code).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Check {
    from: i64,
    span: i64,
    loads: bool,
    stores: bool,
}

/// A load or store in a memory group: its locals (GROUP + 2 * slot...), and
/// for the group's first access, the check.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Member {
    slot: u32,
    check: Option<Check>,
}

/// The loads and stores of a block (`ops`) that can share one translation
/// check: those whose addresses are the same value plus different
/// constants, 256 bytes' worth at most. (If the check fails, they go
/// through jit_op, which refills the TLB: as it does when it misses, or
/// when the range crosses into another page, which a narrow one rarely
/// does. Doing the regular lookup instead takes more code than it saves.) Within the block, a register written
/// by ADDI (MV) holds another's value plus a constant: the value that one
/// had then, which stays the same whatever happens to the register after
/// (the code computes each access's address from its own register anyway).
/// Groups of one aren't groups; MAX_GROUPS per block, in the order they
/// start.
fn memory_groups(ops: &[Op]) -> Vec<Option<Member>> {
    // x[r] = x[b] (as it was after its v-th other write in the block; 0:
    // at its start) + c.
    let mut form: [(u8, u32, i64); 32] = core::array::from_fn(|r| (r as u8, 0, 0));
    let mut version = [0u32; 32];
    struct Group {
        base: (u8, u32),
        min: i64,
        end: i64,
        loads: bool,
        stores: bool,
        count: u32,
        first: usize,
        first_c: i64,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut of = vec![None; ops.len()];
    for (k, op) in ops.iter().enumerate() {
        if let Some(width) = access_width(op.kind) {
            let (b, v, c) = form[op.rs1 as usize];
            let at = c.wrapping_add(op.imm as i64);
            let g = groups.iter().position(|g| g.base == (b, v)).unwrap_or_else(|| {
                groups.push(Group { base: (b, v), min: at, end: at, loads: false, stores: false, count: 0, first: k, first_c: c });
                groups.len() - 1
            });
            let group = &mut groups[g];
            group.min = group.min.min(at);
            group.end = group.end.max(at.wrapping_add(width));
            group.count += 1;
            if op.kind.is_load() {
                group.loads = true;
            } else {
                group.stores = true;
            }
            of[k] = Some(g);
        }
        let rd = op.rd as usize;
        if rd != 0 && rd < 32 && registers(op).1 & 1 << rd != 0 {
            form[rd] = if op.kind == Kind::Addi {
                let (b, v, c) = form[op.rs1 as usize];
                (b, v, c.wrapping_add(op.imm as i64))
            } else {
                version[rd] += 1;
                (rd as u8, version[rd], 0)
            };
        }
    }
    let mut slots = vec![None; groups.len()];
    let mut used = 0;
    for (g, group) in groups.iter().enumerate() {
        if group.count >= 2 && group.end - group.min <= 256 && used < MAX_GROUPS {
            slots[g] = Some(used as u32);
            used += 1;
        }
    }
    of.iter()
        .enumerate()
        .map(|(k, g)| {
            let g = (*g)?;
            let slot = slots[g]?;
            let group = &groups[g];
            let check = (group.first == k).then(|| Check {
                from: group.min - group.first_c,
                span: group.end - group.min,
                loads: group.loads,
                stores: group.stores,
            });
            Some(Member { slot, check })
        })
        .collect()
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
    /// The depth of the switch's outermost block (case i's code follows the
    /// end of the one at `cases + n - i`), the number of cases, and the case
    /// being compiled.
    cases: u32,
    n: u32,
    case: u32,
    self_loop: Option<SelfLoop>,
    /// The memory groups of the block being compiled, by instruction.
    members: Vec<Option<Member>>,
    chain: u32,
    /// The function's RAM page (physical).
    ppn: u32,
    exit: u32,
    helper_exit: u32,
    // Where the hart's things are, from its start (so that the code works
    // for any hart: the parameter HART)...
    x: u32,
    pc: u32,
    retired: u32,
    ctx: u32,
    group: u32,
    reservation: u32,
    reserved_value: u32,
    privilege: u32,
    mstatus: u32,
    mie: u32,
    mip: u32,
    group_ok: u32,
    tlb: u32,
    chain_base: u32,
    chain_ctx: u32,
    fetch_tags: u32,
    fetch_pages: u32,
    fetch_ctx: u32,
    // ...and the RAM's, in linear memory.
    ram: u32,
    ram_base: u64,
    code_lines: u32,
}

impl<'a> Emitter<'a> {
    fn new(hart: &Hart, out: &'a mut Vec<u8>) -> Emitter<'a> {
        let at = |field: *const u64| field as u32 - hart as *const Hart as u32;
        Emitter {
            out,
            loaded: 0,
            dirty: 0,
            depth: 0,
            top: 0,
            cases: 0,
            n: 0,
            case: 0,
            self_loop: None,
            members: Vec::new(),
            chain: 0,
            ppn: 0,
            exit: 0,
            helper_exit: 0,
            x: at(hart.x.as_ptr()),
            pc: at(&hart.pc),
            retired: at(&hart.retired),
            ctx: at(&hart.jit_ctx),
            reservation: at(&hart.reservation),
            reserved_value: at(&hart.reserved_value),
            privilege: at((&hart.priv_ as *const u32).cast()),
            mstatus: at(&hart.mstatus),
            mie: at(&hart.mie),
            mip: at(hart.mip.as_ptr()),
            group: at(&hart.jit_group),
            group_ok: at(hart.jit_group_ok.as_ptr().cast()),
            tlb: at(hart.jit_tlb.as_ptr().cast()),
            chain_base: at((&hart.chain_base as *const u32).cast()),
            chain_ctx: at(&hart.chain_ctx),
            fetch_tags: at(hart.fetch_tags.as_ptr()),
            fetch_pages: at(hart.fetch_pages.as_ptr().cast()),
            fetch_ctx: at(&hart.fetch_ctx),
            ram: hart.ram as u32,
            ram_base: hart.ram_base,
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

    /// Push the hart (where its things are from).
    fn hart(&mut self) {
        self.local(LOCAL_GET, HART);
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
            self.hart();
            self.mem(I64_LOAD, self.x + 8 * r);
            self.local(LOCAL_TEE, X + r);
            self.loaded |= 1 << r;
        }
    }

    /// Load x[r] into its local.
    fn preload(&mut self, r: u32) {
        self.hart();
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
                self.hart();
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
        self.hart();
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
        if case != 0 && case as u32 - 1 > self.case {
            self.enter(case as u32 - 1);
        } else if case != 0 {
            self.i32c(case as i32 - 1);
            self.local(LOCAL_SET, NEXT);
            self.flush();
            self.br(self.top);
        } else {
            self.pc_at(offset);
            self.exit_to_stack(true);
        }
    }

    /// Go on in case `i`, further on in the function: straight there (to
    /// the end of the switch's block its code follows), not through the
    /// switch.
    fn enter(&mut self, i: u32) {
        self.flush();
        self.br(self.cases + self.n - i);
    }

    /// Run instruction `k` of a block (`op`, at `offset` in the page)
    /// through jit_op; leave the function if that says so (ENTRY: what it
    /// said).
    fn interpret(&mut self, k: u32, offset: i64, op: &Op) {
        // jit_op works on the registers in memory, and the function may end
        // there: write them all back.
        let (_, writes) = registers(op);
        self.flush();
        self.dirty = 0;
        self.set_retired(k);
        let (a, b) = op.pack();
        self.hart();
        self.i64c(a as i64);
        self.i64c(b as i64);
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
    fn slow_path(&mut self, k: u32, offset: i64, op: &Op) {
        let (loaded, dirty) = (self.loaded, self.dirty);
        self.interpret(k, offset, op);
        (self.loaded, self.dirty) = (loaded, dirty);
    }

    /// The slow path of a memory group's first access (its check failed):
    /// jit_op also checks the group's range again, once it's done the access
    /// (`Hart::jit_group`), and the check's locals take what it found, for
    /// the rest of the group. (No more than that, in straight-line code: a
    /// branch here, in every group, makes all of the code slower to compile.)
    fn group_slow_path(&mut self, k: u32, offset: i64, op: &Op, slot: u32, check: Check) {
        let access = check.loads as u64 | (check.stores as u64) << 1;
        self.hart();
        self.i64c((check.from as u32 as u64 | (check.span as u64) << 32 | access << 48) as i64);
        self.mem(I64_STORE, self.group);
        self.slow_path(k, offset, op);
        for i in 0..2 {
            self.hart();
            self.mem(I32_LOAD, self.group_ok + 4 * i);
            self.local(LOCAL_SET, GROUP + 2 * slot + i);
        }
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
        self.hart();
        self.o(I32_ADD);
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

    /// A memory group's check (its first access does it, for all, see
    /// `memory_groups`): whether its range is on a page the JIT TLB has (for
    /// what the group does: loads, stores), into its first local, and if so,
    /// the page's host offset into its second.
    fn group_check(&mut self, op: &Op, slot: u32, check: Check) {
        let (ok, host) = (GROUP + 2 * slot, GROUP + 2 * slot + 1);
        self.reg(op.rs1 as u32);
        if check.from != 0 {
            self.i64c(check.from);
            self.o(I64_ADD);
        }
        self.local(LOCAL_TEE, ADDR);
        self.i64c(7);
        self.o(I64_SHR_U);
        self.o(I32_WRAP_I64);
        self.i32c(((TLB_SIZE - 1) << 5) as i32);
        self.o(I32_AND);
        self.hart();
        self.o(I32_ADD);
        self.local(LOCAL_SET, ENTRY);
        if check.loads {
            self.range_tag(0, check.span);
        }
        if check.stores {
            self.range_tag(8, check.span);
            if check.loads {
                self.o(I32_AND);
            }
        }
        self.open(IF, I32);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, self.tlb + 16);
        self.local(LOCAL_SET, host);
        if check.stores {
            // No code on the page (Code::lines of its RAM page is 0).
            self.local(LOCAL_GET, ADDR);
            self.o(I32_WRAP_I64);
            self.local(LOCAL_GET, host);
            self.o(I32_ADD);
            self.i32c(self.ram as i32);
            self.o(I32_SUB);
            self.i32c(12);
            self.o(I32_SHR_U);
            self.i32c(3);
            self.o(I32_SHL);
            self.mem(I64_LOAD, self.code_lines);
            self.o(I64_EQZ);
        } else {
            self.i32c(1);
        }
        self.o(ELSE);
        self.i32c(0);
        self.close();
        self.local(LOCAL_SET, ok);
    }

    /// Push whether ENTRY's tag (at `at`: loads 0, stores 8) is the page of
    /// ADDR's range of `span` bytes (its last byte's: one across pages misses).
    fn range_tag(&mut self, at: u32, span: i64) {
        self.local(LOCAL_GET, ENTRY);
        self.mem(I64_LOAD, self.tlb + at);
        self.local(LOCAL_GET, ADDR);
        if span > 1 {
            self.i64c(span - 1);
            self.o(I64_ADD);
        }
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.local(LOCAL_GET, CTX);
        self.o(I64_OR);
        self.o(I64_EQ);
    }

    /// Into HOST: where a grouped access goes in linear memory, if its group's
    /// check passed (its address plus the page's host offset).
    fn group_host(&mut self, op: &Op, slot: u32) {
        self.reg(op.rs1 as u32);
        if op.imm != 0 {
            self.i64c(op.imm as i64);
            self.o(I64_ADD);
        }
        self.o(I32_WRAP_I64);
        self.local(LOCAL_GET, GROUP + 2 * slot + 1);
        self.o(I32_ADD);
        self.local(LOCAL_SET, HOST);
    }

    fn load(&mut self, k: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
        if let Some(Member { slot, check }) = self.members.get(k as usize).copied().flatten() {
            // In a group: straight there if its check passed.
            if let Some(check) = check {
                self.group_check(op, slot, check);
            }
            self.group_host(op, slot);
            self.local(LOCAL_GET, GROUP + 2 * slot);
            self.open(IF, I64);
            self.local(LOCAL_GET, HOST);
            self.mem(opcode, 0);
            self.o(ELSE);
            match check {
                Some(check) => self.group_slow_path(k, offset, op, slot, check),
                None => self.slow_path(k, offset, op),
            }
            let rd = op.rd as u32;
            if rd == SINK as u32 {
                self.i64c(0);
            } else {
                self.hart();
                self.mem(I64_LOAD, self.x + 8 * rd);
            }
            self.close();
        } else {
            self.load_value(k, offset, op, width, opcode);
        }
        self.set_reg(op.rd as u32);
    }

    /// Push what a load loads, the regular way: through the JIT TLB, or jit_op.
    fn load_value(&mut self, k: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
        self.tlb_lookup(op, width, false);
        self.open(IF, I64);
        self.host_address();
        self.mem(opcode, 0);
        self.o(ELSE);
        self.slow_path(k, offset, op);
        let rd = op.rd as u32;
        if rd == SINK as u32 {
            self.i64c(0);
        } else {
            self.hart();
            self.mem(I64_LOAD, self.x + 8 * rd);
        }
        self.close();
    }

    fn store(&mut self, k: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
        self.reg(op.rs2 as u32);
        self.local(LOCAL_SET, B);
        if let Some(Member { slot, check }) = self.members.get(k as usize).copied().flatten() {
            // In a group: straight there if its check passed.
            if let Some(check) = check {
                self.group_check(op, slot, check);
            }
            self.group_host(op, slot);
            self.local(LOCAL_GET, GROUP + 2 * slot);
            self.open(IF, EMPTY);
            self.local(LOCAL_GET, HOST);
            self.local(LOCAL_GET, B);
            self.mem(opcode, 0);
            self.o(ELSE);
            match check {
                Some(check) => self.group_slow_path(k, offset, op, slot, check),
                None => self.slow_path(k, offset, op),
            }
            self.close();
        } else {
            self.store_value(k, offset, op, width, opcode);
        }
    }

    /// A store of B, the regular way: through the JIT TLB, or jit_op.
    fn store_value(&mut self, k: u32, offset: i64, op: &Op, width: i64, opcode: u8) {
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
        self.slow_path(k, offset, op);
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

    /// An atomic instruction (AMO, LR or SC, of `Execute` op), compiled: if
    /// it's naturally aligned, on a page in the JIT TLB (to store to, but
    /// for LR; and without code), with WebAssembly's atomic instructions,
    /// otherwise through jit_op. Returns false for those it doesn't do.
    fn atomic(&mut self, k: u32, offset: i64, op: &Op) -> bool {
        let funct5 = op.inst >> 27;
        let w = op.inst >> 12 & 7 == 2;
        let (width, align) = if w { (4, 2) } else { (8, 3) };
        // (WebAssembly's i32 and i64 forms are 1 apart.)
        let rmw = match funct5 {
            0b00000 => 0x1e, // add
            0b00001 => 0x41, // xchg
            0b01100 => 0x2c, // and
            0b01000 => 0x33, // or
            0b00100 => 0x3a, // xor
            0b00010 | 0b00011 => 0, // LR, SC
            _ => return false,
        };
        let (lr, sc) = (funct5 == 0b00010, funct5 == 0b00011);
        let rd = op.rd as u32;
        // The address is rs1's (an atomic's immediate is its bits).
        let at = Op { imm: 0, ..*op };
        if !lr {
            self.reg(op.rs2 as u32);
            self.local(LOCAL_SET, B);
        }
        self.tlb_lookup(&at, width, !lr);
        self.local(LOCAL_GET, ADDR);
        self.i64c(width - 1);
        self.o(I64_AND);
        self.o(I64_EQZ);
        self.o(I32_AND);
        self.open(IF, I32);
        self.host_address();
        self.local(LOCAL_TEE, HOST);
        if lr {
            self.o(DROP);
            self.i32c(1);
        } else {
            // No code on the page (Code::lines of its RAM page is 0).
            self.i32c(self.ram as i32);
            self.o(I32_SUB);
            self.i32c(12);
            self.o(I32_SHR_U);
            self.i32c(3);
            self.o(I32_SHL);
            self.mem(I64_LOAD, self.code_lines);
            self.o(I64_EQZ);
        }
        self.o(ELSE);
        self.i32c(0);
        self.close();
        self.open(IF, I64);
        let atomic = |e: &mut Self, opcode: u8| {
            e.o(ATOMIC_PREFIX);
            e.o(opcode + !w as u8);
            e.o(align);
            e.o(0);
        };
        // The access's physical address (for the reservation).
        let physical = |e: &mut Self| {
            e.local(LOCAL_GET, HOST);
            e.i32c(e.ram as i32);
            e.o(I32_SUB);
            e.o(I64_EXTEND_I32_U);
            e.i64c(e.ram_base as i64);
            e.o(I64_ADD);
        };
        if lr {
            // Load, and reserve (the address, and the value: see Hart::amo).
            self.local(LOCAL_GET, HOST);
            atomic(self, 0x10);
            if w {
                self.o(I64_EXTEND_I32_U);
            }
            self.local(LOCAL_SET, A);
            self.hart();
            self.local(LOCAL_GET, A);
            self.mem(I64_STORE, self.reserved_value);
            self.hart();
            physical(self);
            self.mem(I64_STORE, self.reservation);
            self.local(LOCAL_GET, A);
            if w {
                self.o(I32_WRAP_I64);
                self.o(I64_EXTEND_I32_S);
            }
        } else if sc {
            // Store, if the reservation is this address's and memory still
            // holds what LR read; rd = 0 if so, else 1. Either way the
            // reservation is gone.
            self.hart();
            self.mem(I64_LOAD, self.reservation);
            physical(self);
            self.o(I64_EQ);
            self.hart();
            self.i64c(NO_RESERVATION as i64);
            self.mem(I64_STORE, self.reservation);
            self.open(IF, I64);
            self.local(LOCAL_GET, HOST);
            self.hart();
            self.mem(I64_LOAD, self.reserved_value);
            self.local(LOCAL_TEE, A);
            if w {
                self.o(I32_WRAP_I64);
            }
            self.local(LOCAL_GET, B);
            if w {
                self.o(I32_WRAP_I64);
            }
            atomic(self, 0x48); // cmpxchg: the old value
            if w {
                self.o(I64_EXTEND_I32_U);
            }
            self.local(LOCAL_GET, A);
            self.o(I64_NE);
            self.o(I64_EXTEND_I32_U);
            self.o(ELSE);
            self.i64c(1);
            self.close();
        } else {
            self.local(LOCAL_GET, HOST);
            self.local(LOCAL_GET, B);
            if w {
                self.o(I32_WRAP_I64);
            }
            atomic(self, rmw);
            if w {
                self.o(I64_EXTEND_I32_S);
            }
        }
        self.o(ELSE);
        self.slow_path(k, offset, op);
        if rd == 0 {
            self.i64c(0);
        } else {
            self.hart();
            self.mem(I64_LOAD, self.x + 8 * rd);
        }
        self.close();
        self.set_reg(rd);
        true
    }

    /// CSRRS / CSRRC (or their immediate forms) on sstatus (of `ExecuteEnd`
    /// op), compiled when they only read it, or set or clear SIE: in S-mode
    /// or above, and, if SIE may be set, with no interrupt pending (jit_op
    /// leaves for those); otherwise through jit_op. Returns false for those
    /// it doesn't do (writes to other fields).
    fn sstatus(&mut self, k: u32, offset: i64, op: &Op) -> bool {
        let funct3 = op.inst >> 12 & 7;
        let set = funct3 & 3 == 2;
        let (imm, src) = (funct3 & 4 != 0, op.rs1 as u32);
        let others = SSTATUS_WRITABLE & !MSTATUS_SIE;
        if imm && src as u64 & others != 0 {
            return false;
        }
        let writes = src != 0;
        let rd = op.rd as u32;
        if writes {
            if imm {
                self.i64c(src as i64);
            } else {
                self.reg(src);
            }
            self.local(LOCAL_SET, B);
        }
        // S-mode or above...
        self.hart();
        self.mem(I32_LOAD, self.privilege);
        self.i32c(PRIV_S as i32);
        self.o(I32_GE_U);
        if writes && !imm {
            // ...SIE alone...
            self.local(LOCAL_GET, B);
            self.i64c(others as i64);
            self.o(I64_AND);
            self.o(I64_EQZ);
            self.o(I32_AND);
        }
        if writes && set && (!imm || src as u64 & MSTATUS_SIE != 0) {
            // ...and no interrupt it could let in.
            self.local(LOCAL_GET, B);
            self.i64c(MSTATUS_SIE as i64);
            self.o(I64_AND);
            self.o(I64_EQZ);
            self.hart();
            self.mem(I64_LOAD, self.mip);
            self.hart();
            self.mem(I64_LOAD, self.mie);
            self.o(I64_AND);
            self.o(I64_EQZ);
            self.o(I32_OR);
            self.o(I32_AND);
        }
        self.open(IF, I64);
        // The old value (with SD for a dirty FS), and the new.
        self.hart();
        self.mem(I64_LOAD, self.mstatus);
        self.local(LOCAL_TEE, A);
        self.i64c(SSTATUS_VISIBLE as i64);
        self.o(I64_AND);
        self.local(LOCAL_GET, A);
        self.i64c(MSTATUS_FS as i64);
        self.o(I64_AND);
        self.i64c(MSTATUS_FS as i64);
        self.o(I64_EQ);
        self.o(I64_EXTEND_I32_U);
        self.i64c(63);
        self.o(I64_SHL);
        self.o(I64_OR);
        if writes {
            self.hart();
            self.local(LOCAL_GET, A);
            self.local(LOCAL_GET, B);
            self.i64c(MSTATUS_SIE as i64);
            self.o(I64_AND);
            if set {
                self.o(I64_OR);
            } else {
                self.i64c(-1);
                self.o(I64_XOR);
                self.o(I64_AND);
            }
            self.mem(I64_STORE, self.mstatus);
        }
        self.o(ELSE);
        self.slow_path(k, offset, op);
        self.hart();
        self.mem(I64_LOAD, self.ctx);
        self.local(LOCAL_SET, CTX);
        if rd == 0 {
            self.i64c(0);
        } else {
            self.hart();
            self.mem(I64_LOAD, self.x + 8 * rd);
        }
        self.close();
        self.set_reg(rd);
        true
    }

    /// x[rd] = the high 64 bits of x[rs1] * x[rs2], from four 32-bit
    /// products; then, for signed operands, less the other operand for each
    /// negative one (two's complement).
    fn multiply_high(&mut self, op: &Op, signed_a: bool, signed_b: bool) {
        const LOW: i64 = 0xffff_ffff;
        let half = |e: &mut Self, local, high: bool| {
            e.local(LOCAL_GET, local);
            if high {
                e.i64c(32);
                e.o(I64_SHR_U);
            } else {
                e.i64c(LOW);
                e.o(I64_AND);
            }
        };
        self.reg(op.rs1 as u32);
        self.local(LOCAL_SET, A);
        self.reg(op.rs2 as u32);
        self.local(LOCAL_SET, B);
        // ADDR = a.low * b.high, PC_OUT = a.high * b.low (scratch here).
        half(self, A, false);
        half(self, B, true);
        self.o(I64_MUL);
        self.local(LOCAL_SET, ADDR);
        half(self, A, true);
        half(self, B, false);
        self.o(I64_MUL);
        self.local(LOCAL_SET, PC_OUT);
        // a.high * b.high + the cross products' high halves...
        half(self, A, true);
        half(self, B, true);
        self.o(I64_MUL);
        half(self, ADDR, true);
        self.o(I64_ADD);
        half(self, PC_OUT, true);
        self.o(I64_ADD);
        // ...plus the carry out of the middle: (a.low * b.low).high + the
        // cross products' low halves.
        half(self, A, false);
        half(self, B, false);
        self.o(I64_MUL);
        self.i64c(32);
        self.o(I64_SHR_U);
        half(self, ADDR, false);
        self.o(I64_ADD);
        half(self, PC_OUT, false);
        self.o(I64_ADD);
        self.i64c(32);
        self.o(I64_SHR_U);
        self.o(I64_ADD);
        for (signed, negative, other) in [(signed_a, A, B), (signed_b, B, A)] {
            if signed {
                self.local(LOCAL_GET, other);
                self.local(LOCAL_GET, negative);
                self.i64c(63);
                self.o(I64_SHR_S);
                self.o(I64_AND);
                self.o(I64_SUB);
            }
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
        // Locals: 36 i64 (x1..x31, ADDR, A, B, CTX, PC_OUT), 3 i32 (ENTRY,
        // FETCH, HOST), then the memory groups' (GROUP...).
        self.out.extend_from_slice(&[2, 36, I64, 3 + 2 * MAX_GROUPS as u8, I32]);
        self.hart();
        self.mem(I64_LOAD, self.ctx);
        self.local(LOCAL_SET, CTX);

        self.ppn = cases.first().map_or(0, |&index| (hart.blocks[index as usize].pa >> 12) as u32);
        self.exit = self.open(BLOCK, EMPTY);
        self.top = self.open(LOOP, EMPTY);
        self.chain = self.open(BLOCK, EMPTY);
        self.helper_exit = self.open(BLOCK, EMPTY);
        // The switch: case i's code follows the end of the i-th innermost
        // block (the outermost, after the last case, is its default).
        self.cases = self.depth + 1;
        self.n = n;
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
            self.case = case as u32;
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
            self.members = memory_groups(ops);
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
                ended = self.op(k, offset, &op, case_at);
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
        self.hart();
        self.mem(I64_LOAD, self.pc);
        self.local(LOCAL_SET, PC_OUT);
        self.hart();
        self.mem(I64_LOAD, self.retired);
        self.local(LOCAL_GET, STEPS);
        self.o(I64_EXTEND_I32_U);
        self.o(I64_SUB);
        self.local(LOCAL_SET, BASE);
        self.close(); // chain: (registers written back)
        self.chain_lookup();
        self.close(); // the loop (not found in the chain cache)
        self.close(); // exit: (registers written back)
        self.hart();
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
        self.hart();
        self.mem(I32_LOAD, self.chain_base);
        self.o(I32_ADD);
        self.local(LOCAL_TEE, ENTRY);
        self.mem(I64_LOAD, 0);
        self.local(LOCAL_GET, PC_OUT);
        self.o(I64_EQ);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I64_LOAD, 8);
        self.hart();
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
        self.hart();
        self.o(I32_ADD);
        self.mem(I64_LOAD, self.fetch_tags);
        self.local(LOCAL_GET, PC_OUT);
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.hart();
        self.mem(I64_LOAD, self.fetch_ctx);
        self.o(I64_OR);
        self.o(I64_EQ);
        self.o(I32_AND);
        self.local(LOCAL_GET, FETCH);
        self.i32c(1);
        self.o(I32_SHR_U);
        self.hart();
        self.o(I32_ADD);
        self.mem(I32_LOAD, self.fetch_pages);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, 24);
        self.o(I32_EQ);
        self.o(I32_AND);
        self.open(IF, EMPTY);
        // Code of this function (on its page, at the same virtual address):
        // on in it, through the switch.
        self.local(LOCAL_GET, PC_OUT);
        self.local(LOCAL_GET, PAGE);
        self.o(I64_XOR);
        self.i64c(12);
        self.o(I64_SHR_U);
        self.o(I64_EQZ);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, 24);
        self.i32c(self.ppn as i32);
        self.o(I32_EQ);
        self.o(I32_AND);
        self.open(IF, EMPTY);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, 20);
        self.local(LOCAL_SET, NEXT);
        self.br(self.top);
        self.close();
        self.local(LOCAL_GET, HART);
        self.local(LOCAL_GET, PC_OUT);
        self.i64c(!0xfff);
        self.o(I64_AND);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, 20);
        self.local(LOCAL_GET, BUDGET);
        self.local(LOCAL_GET, STEPS);
        self.local(LOCAL_GET, BASE);
        self.local(LOCAL_GET, ENTRY);
        self.mem(I32_LOAD, 16);
        self.o(RETURN_CALL_INDIRECT);
        self.o(0); // the type: Compiled
        self.o(0); // the table
        self.close();
    }

    /// Instruction `k` of a block; returns whether it ends the block.
    fn op(&mut self, k: u32, offset: i64, op: &Op, case_at: &[u16]) -> bool {
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
            Lb => self.load(k, offset, op, 1, 0x30),
            Lbu => self.load(k, offset, op, 1, 0x31),
            Lh => self.load(k, offset, op, 2, 0x32),
            Lhu => self.load(k, offset, op, 2, 0x33),
            Lw => self.load(k, offset, op, 4, 0x34),
            Lwu => self.load(k, offset, op, 4, 0x35),
            Ld => self.load(k, offset, op, 8, I64_LOAD),
            Sb => self.store(k, offset, op, 1, 0x3c),
            Sh => self.store(k, offset, op, 2, 0x3d),
            Sw => self.store(k, offset, op, 4, 0x3e),
            Sd => self.store(k, offset, op, 8, I64_STORE),
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
            Mulhu => self.multiply_high(op, false, false),
            Mulh => self.multiply_high(op, true, true),
            Mulhsu => self.multiply_high(op, true, false),
            // FENCE: order this hart's memory accesses as other harts
            // (threads) see them, as the interpreter does.
            Execute if op.inst & 0x707f == 0x0f => {
                self.o(ATOMIC_PREFIX);
                self.o(ATOMIC_FENCE);
                self.o(0);
            }
            // Atomics (but AMOMIN/MAX*): to RAM in the JIT TLB, compiled.
            Execute if op.inst & 0x707f == 0x202f || op.inst & 0x707f == 0x302f => {
                if !self.atomic(k, offset, op) {
                    self.interpret(k, offset, op);
                }
            }
            // Through the interpreter, continuing.
            Execute => self.interpret(k, offset, op),
            // Reading sstatus, or setting or clearing its SIE alone
            // (interrupts on and off): compiled.
            ExecuteEnd if op.inst & 0x7f == 0x73 && op.inst >> 20 == 0x100 && op.inst >> 12 & 3 >= 2
                && self.sstatus(k, offset, op) => {}
            // A CSR instruction, but for satp (the function assumes the
            // page's translation stays): through the interpreter, then on
            // (jit_op leaves for an interrupt it made pending). The data
            // accesses' context may have changed (mstatus.SUM, MXR, MPRV).
            ExecuteEnd if op.inst & 0x7f == 0x73 && op.inst >> 12 & 7 != 0 && op.inst >> 20 != 0x180 => {
                self.interpret(k, offset, op);
                self.hart();
                self.mem(I64_LOAD, self.ctx);
                self.local(LOCAL_SET, CTX);
            }
            // Through the interpreter, then on through the chain cache:
            // these can change privilege, translation (which the function
            // assumes doesn't change), interrupts (jit_op leaves for those).
            ExecuteEnd | Illegal => {
                self.interpret(k, offset, op);
                self.add_steps(k + 1);
                self.pc_at(next);
                self.exit_to_stack(true);
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::decode;

    /// Ops from 32-bit encodings.
    fn ops(code: &[u32]) -> Vec<Op> {
        code.iter().map(|&inst| decode(inst, 4, inst)).collect()
    }

    // Encodings: I-type (addi, loads), S-type (stores).
    fn i(opcode: u32, funct3: u32, rd: u32, rs1: u32, imm: i32) -> u32 {
        ((imm as u32 & 0xfff) << 20) | rs1 << 15 | funct3 << 12 | rd << 7 | opcode
    }
    fn s(funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
        let imm = imm as u32 & 0xfff;
        (imm >> 5) << 25 | rs2 << 20 | rs1 << 15 | funct3 << 12 | (imm & 0x1f) << 7 | 0x23
    }
    fn addi(rd: u32, rs1: u32, imm: i32) -> u32 {
        i(0x13, 0, rd, rs1, imm)
    }
    fn ld(rd: u32, rs1: u32, imm: i32) -> u32 {
        i(0x03, 3, rd, rs1, imm)
    }
    fn lw(rd: u32, rs1: u32, imm: i32) -> u32 {
        i(0x03, 2, rd, rs1, imm)
    }
    fn sd(rs1: u32, rs2: u32, imm: i32) -> u32 {
        s(3, rs1, rs2, imm)
    }
    fn add(rd: u32, rs1: u32, rs2: u32) -> u32 {
        rs2 << 20 | rs1 << 15 | rd << 7 | 0x33
    }
    const A0: u32 = 10;
    const A1: u32 = 11;
    const A3: u32 = 13;
    const A4: u32 = 14;
    const A5: u32 = 15;
    const A6: u32 = 16;
    const SP: u32 = 2;

    fn member(slot: u32) -> Option<Member> {
        Some(Member { slot, check: None })
    }
    fn first(slot: u32, from: i64, span: i64, loads: bool, stores: bool) -> Option<Member> {
        Some(Member { slot, check: Some(Check { from, span, loads, stores }) })
    }

    #[test]
    fn groups_accesses_off_one_register() {
        // Saving and restoring on the stack: one group each way.
        let code = ops(&[sd(SP, A0, 8), sd(SP, A1, 16), ld(A3, SP, 8), lw(A4, SP, 20)]);
        assert_eq!(memory_groups(&code), vec![first(0, 8, 16, true, true), member(0), member(0), member(0)]);
    }

    #[test]
    fn follows_registers_that_are_others_plus_a_constant() {
        // glibc's memcpy loop: the stores through a0 and a3, each a5 (a0 - 16) plus
        // something; the loads through a1, moved along.
        let code = ops(&[
            addi(A5, A0, -16),
            ld(A6, A1, 16),
            addi(A3, A5, 24),
            sd(A0, A4, 0),
            ld(A4, A1, 24),
            addi(A0, A5, 32),
            sd(A3, A6, 0),
            addi(A1, A1, 64),
            ld(A6, A1, -32),
            sd(A0, A4, 0),
        ]);
        let groups = memory_groups(&code);
        // Loads: a1 + 16, + 24, + 32 (after a1 += 64: -32): one group, checked
        // from the first (at a1 + 16).
        assert_eq!(groups[1], first(0, 16, 24, true, false));
        assert_eq!((groups[4], groups[8]), (member(0), member(0)));
        // Stores: a0 + 0, a0 + 8 (a3), a0 + 16 (a0, moved): one group.
        assert_eq!(groups[3], first(1, 0, 24, false, true));
        assert_eq!((groups[6], groups[9]), (member(1), member(1)));
    }

    #[test]
    fn leaves_out_what_it_cant_tell() {
        // A register written otherwise starts a new group (a1 + a1 isn't a1 plus
        // anything); one access alone isn't a group; nor are accesses farther
        // apart than 256 bytes.
        let code = ops(&[ld(A3, A1, 0), add(A1, A1, A1), ld(A4, A1, 0), ld(A5, A0, 0), ld(A6, A0, 256)]);
        assert_eq!(memory_groups(&code), vec![None, None, None, None, None]);
    }
}
