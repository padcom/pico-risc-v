//! The emulator's CPU core, compiled to WebAssembly and driven by src/cpu.ts.
//!
//! An instance holds the harts (each created by `hart_new`, and passed to
//! every export that works on one) and guest RAM, a block of this
//! instance's linear memory shared by them all, so loads, stores and
//! instruction fetches never leave WebAssembly. Device accesses call out to
//! the JavaScript bus (see memory.rs).
//!
//! Nothing allocates after the harts are created, so the linear memory never
//! grows and the JavaScript views into it (registers, RAM) stay valid.
//!
//! Register and CSR values cross over as 64-bit integers (BigInt in
//! JavaScript).

mod blocks;
mod csr;
mod fpu;
mod hart;
mod jit;
mod memory;
mod mmu;
mod rvc;
#[cfg(test)]
mod testfloat;

use blocks::{Code, NO_CODE};
use core::cell::UnsafeCell;
use hart::Hart;

/// RAM, and what's known about code in it: shared by the harts (set up once,
/// by `ram_alloc`, before they are created).
struct Ram {
    ptr: *mut u8,
    base: u64,
    size: u64,
    code: &'static Code,
}

struct Global<T>(UnsafeCell<T>);
// SAFETY: written once, before any hart exists; only read after that.
unsafe impl<T> Sync for Global<T> {}

static RAM: Global<Ram> = Global(UnsafeCell::new(Ram { ptr: core::ptr::null_mut(), base: 0, size: 0, code: &NO_CODE }));

fn ram() -> &'static Ram {
    // SAFETY: see Global.
    unsafe { &*RAM.0.get() }
}

/// The hart JavaScript passes (as `hart_new` returned it).
fn hart(h: *mut Hart) -> &'static mut Hart {
    // SAFETY: a hart from hart_new, which lives forever. JavaScript re-enters
    // only through these exports, during device calls, which treat the hart
    // as possibly modified.
    unsafe { &mut *h }
}

/// Flags for `hart_new`.
const BREAK_ON_EBREAK: u32 = 1;
const HAS_TIME: u32 = 2;

/// Allocate `size` bytes of zeroed RAM at physical address `base` (before
/// creating harts); returns where it is in linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn ram_alloc(base: u32, size: u32) -> *mut u8 {
    // SAFETY: see Global (no harts yet).
    let ram = unsafe { &mut *RAM.0.get() };
    // (8-byte aligned, for atomic accesses.)
    ram.ptr = vec![0u64; (size as usize).div_ceil(8)].leak().as_mut_ptr().cast();
    ram.base = base as u64;
    ram.size = size as u64;
    ram.code = Box::leak(Box::new(Code::new((size as usize).div_ceil(4096))));
    ram.ptr
}

/// A new hart, `id` (mhartid), reset to start at `reset_vector`. With RAM
/// (`ram_alloc`), it gets its decoded-instruction cache.
#[unsafe(no_mangle)]
pub extern "C" fn hart_new(id: u32, reset_vector: u64, flags: u32) -> *mut Hart {
    rvc::fill_table();
    let h = Box::leak(Box::new(Hart::new()));
    h.id = id as u64;
    let ram = ram();
    if ram.size > 0 {
        h.ram = ram.ptr;
        h.ram_base = ram.base;
        h.ram_size = ram.size;
        h.code = ram.code;
        h.blocks = vec![blocks::EMPTY_BLOCK; blocks::BLOCKS];
        h.ops = vec![blocks::NO_OP; blocks::OPS];
        h.jit.allocate(ram.code.lines.len());
        h.chain = vec![jit::CHAIN_EMPTY; jit::CHAIN_SIZE];
    }
    h.reset(reset_vector);
    h.break_on_ebreak = flags & BREAK_ON_EBREAK != 0;
    h.has_time = flags & HAS_TIME != 0;
    h
}

/// How many function table slots the JIT needs (one per page of RAM).
#[unsafe(no_mangle)]
pub extern "C" fn jit_slots() -> u32 {
    ram().code.lines.len() as u32
}

/// Turn a hart's JIT on: its slots start at `table_base` in the function
/// table; a page is compiled after running `threshold` instructions, `batch`
/// pages at a time.
#[unsafe(no_mangle)]
pub extern "C" fn jit_init(h: *mut Hart, table_base: u32, threshold: u32, batch: u32) {
    let h = hart(h);
    h.jit.table_base = table_base;
    h.jit.threshold = threshold.max(1);
    h.jit.batch = (batch as usize).max(1);
    h.jit.enabled = !h.blocks.is_empty();
}

/// Compiled code's way into the interpreter (jit.rs: `Hart::jit_op`).
#[unsafe(no_mangle)]
pub extern "C" fn jit_op(h: *mut Hart, index: u32, pc: u64) -> u32 {
    hart(h).jit_op(index, pc)
}

/// Where x0..x31 live in linear memory (32 × 64 bits).
#[unsafe(no_mangle)]
pub extern "C" fn registers(h: *mut Hart) -> *mut u64 {
    hart(h).x.as_mut_ptr()
}

/// Where f0..f31 live in linear memory (32 × 64 bits; singles NaN-boxed).
#[unsafe(no_mangle)]
pub extern "C" fn fp_registers(h: *mut Hart) -> *mut u64 {
    hart(h).f.as_mut_ptr()
}

/// A device wrote (or may have written) RAM at physical `pa..pa + len`.
#[unsafe(no_mangle)]
pub extern "C" fn code_written(pa: u64, len: u32) {
    let ram = ram();
    let offset = pa.wrapping_sub(ram.base);
    if offset < ram.size {
        ram.code.written(offset, (len as u64).min(ram.size - offset));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn reset(h: *mut Hart, pc: u64) {
    hart(h).reset(pc);
}

#[unsafe(no_mangle)]
pub extern "C" fn run(h: *mut Hart, max_steps: u32) -> u32 {
    hart(h).run(max_steps)
}

#[unsafe(no_mangle)]
pub extern "C" fn step(h: *mut Hart) {
    hart(h).step();
}

#[unsafe(no_mangle)]
pub extern "C" fn stop(h: *mut Hart) {
    hart(h).stop_reason = hart::STOPPED;
}

#[unsafe(no_mangle)]
pub extern "C" fn set_interrupt_pending(h: *mut Hart, bit: u32, pending: u32) {
    let h = hart(h);
    h.mip = if pending != 0 { h.mip | bit as u64 } else { h.mip & !(bit as u64) };
}

/// Instructions retired since reset (not what software set the counters to).
#[unsafe(no_mangle)]
pub extern "C" fn instret(h: *mut Hart) -> f64 {
    hart(h).retired as f64
}

// State visible to JavaScript as CPU properties, by index (the order of
// FIELDS in src/cpu.ts).
const PC: u32 = 0;
const PRIV: u32 = 1;
const MSTATUS: u32 = 2;
const MIE: u32 = 3;
const MIP: u32 = 4;
const MTVEC: u32 = 5;
const MSCRATCH: u32 = 6;
const MEPC: u32 = 7;
const MCAUSE: u32 = 8;
const MTVAL: u32 = 9;
const MEDELEG: u32 = 10;
const MIDELEG: u32 = 11;
const MCOUNTEREN: u32 = 12;
const STVEC: u32 = 13;
const SSCRATCH: u32 = 14;
const SEPC: u32 = 15;
const SCAUSE: u32 = 16;
const STVAL: u32 = 17;
const SATP: u32 = 18;
const SCOUNTEREN: u32 = 19;
const WAITING: u32 = 20;
const BREAK_ON_EBREAK_FIELD: u32 = 21;

#[unsafe(no_mangle)]
pub extern "C" fn get(h: *mut Hart, field: u32) -> u64 {
    let h = hart(h);
    match field {
        PC => h.pc,
        PRIV => h.priv_ as u64,
        MSTATUS => h.mstatus,
        MIE => h.mie,
        MIP => h.mip,
        MTVEC => h.mtvec,
        MSCRATCH => h.mscratch,
        MEPC => h.mepc,
        MCAUSE => h.mcause,
        MTVAL => h.mtval,
        MEDELEG => h.medeleg,
        MIDELEG => h.mideleg,
        MCOUNTEREN => h.mcounteren,
        STVEC => h.stvec,
        SSCRATCH => h.sscratch,
        SEPC => h.sepc,
        SCAUSE => h.scause,
        STVAL => h.stval,
        SATP => h.satp,
        SCOUNTEREN => h.scounteren,
        WAITING => h.waiting as u64,
        BREAK_ON_EBREAK_FIELD => h.break_on_ebreak as u64,
        _ => 0,
    }
}

/// Set a field directly (no WARL masking, like poking the register file from
/// a debugger), keeping derived state (translation mode, TLB) consistent.
#[unsafe(no_mangle)]
pub extern "C" fn set(h: *mut Hart, field: u32, value: u64) {
    let h = hart(h);
    match field {
        PC => h.pc = value,
        PRIV => h.priv_ = value as u32,
        MSTATUS => h.mstatus = value,
        MIE => h.mie = value,
        MIP => h.mip = value,
        MTVEC => h.mtvec = value,
        MSCRATCH => h.mscratch = value,
        MEPC => h.mepc = value,
        MCAUSE => h.mcause = value,
        MTVAL => h.mtval = value,
        MEDELEG => h.medeleg = value,
        MIDELEG => h.mideleg = value,
        MCOUNTEREN => h.mcounteren = value,
        STVEC => h.stvec = value,
        SSCRATCH => h.sscratch = value,
        SEPC => h.sepc = value,
        SCAUSE => h.scause = value,
        STVAL => h.stval = value,
        SATP => {
            h.satp = value;
            h.flush_tlb();
        }
        SCOUNTEREN => h.scounteren = value,
        WAITING => h.waiting = value != 0,
        BREAK_ON_EBREAK_FIELD => h.break_on_ebreak = value != 0,
        _ => {}
    }
    h.update_translation();
}
