//! The emulator's CPU core, compiled to WebAssembly and driven by src/cpu.ts.
//!
//! One module instance is one hart: its state is a single static, and guest
//! RAM is a block of this instance's linear memory, so loads, stores and
//! instruction fetches never leave WebAssembly. Device accesses call out to
//! the JavaScript bus (see memory.rs).
//!
//! Nothing allocates after `ram_alloc`, so the linear memory never grows and
//! the JavaScript views into it (registers, RAM) stay valid.
//!
//! Register and CSR values cross over as 64-bit integers (BigInt in
//! JavaScript), whatever the XLEN.

mod csr;
mod fpu;
mod hart;
mod memory;
mod mmu;
mod rvc;
#[cfg(test)]
mod testfloat;

use core::cell::UnsafeCell;
use hart::Hart;

struct Global(UnsafeCell<Hart>);
// SAFETY: WebAssembly instances are single-threaded.
unsafe impl Sync for Global {}

static HART: Global = Global(UnsafeCell::new(Hart::new()));

fn hart() -> &'static mut Hart {
    // SAFETY: single-threaded; JavaScript re-enters only through the exports
    // below, during device calls, which treat the hart as possibly modified.
    unsafe { &mut *HART.0.get() }
}

/// Flags for `init`.
const BREAK_ON_EBREAK: u32 = 1;
const HAS_TIME: u32 = 2;
const RV64: u32 = 4;

#[unsafe(no_mangle)]
pub extern "C" fn init(reset_vector: u64, flags: u32) {
    let h = hart();
    h.xlen64 = flags & RV64 != 0;
    rvc::fill_table(h.xlen64);
    h.reset(reset_vector);
    h.break_on_ebreak = flags & BREAK_ON_EBREAK != 0;
    h.has_time = flags & HAS_TIME != 0;
}

/// Allocate `size` bytes of zeroed RAM at physical address `base`; returns
/// where it is in linear memory.
#[unsafe(no_mangle)]
pub extern "C" fn ram_alloc(base: u32, size: u32) -> *mut u8 {
    let h = hart();
    h.ram = vec![0u8; size as usize].leak().as_mut_ptr();
    h.ram_base = base as u64;
    h.ram_size = size as u64;
    h.ram
}

/// Where x0..x31 live in linear memory (32 × 64 bits; on RV32 sign-extended
/// 32-bit values).
#[unsafe(no_mangle)]
pub extern "C" fn registers() -> *mut u64 {
    hart().x.as_mut_ptr()
}

/// Where f0..f31 live in linear memory (32 × 64 bits; singles NaN-boxed).
#[unsafe(no_mangle)]
pub extern "C" fn fp_registers() -> *mut u64 {
    hart().f.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn reset(pc: u64) {
    hart().reset(pc);
}

#[unsafe(no_mangle)]
pub extern "C" fn run(max_steps: u32) -> u32 {
    let h = hart();
    if h.xlen64 { h.run::<true>(max_steps) } else { h.run::<false>(max_steps) }
}

#[unsafe(no_mangle)]
pub extern "C" fn step() {
    let h = hart();
    if h.xlen64 { h.step::<true>() } else { h.step::<false>() }
}

#[unsafe(no_mangle)]
pub extern "C" fn stop() {
    hart().stop_reason = hart::STOPPED;
}

#[unsafe(no_mangle)]
pub extern "C" fn set_interrupt_pending(bit: u32, pending: u32) {
    let h = hart();
    h.mip = if pending != 0 { h.mip | bit as u64 } else { h.mip & !(bit as u64) };
}

/// Instructions retired since reset (not what software set the counters to).
#[unsafe(no_mangle)]
pub extern "C" fn instret() -> f64 {
    hart().retired as f64
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
pub extern "C" fn get(field: u32) -> u64 {
    let h = hart();
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
pub extern "C" fn set(field: u32, value: u64) {
    let h = hart();
    let value = value & h.address_mask; // RV32: 32-bit registers
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
