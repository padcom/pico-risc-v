# hart: the CPU core

The emulator's RISC-V hart (CPU core with its MMU), written in Rust and
compiled to WebAssembly. Everything else (devices, the virtio disk and network,
the NAT, the machine and CLI) is TypeScript in `src/`; `src/cpu.ts` loads
`build/hart.wasm` and makes it look like any other TypeScript class.

**What's here:** RV64GC (IMAFDC with Zicsr and Zifencei), machine,
supervisor and user modes with trap delegation, and Sv39 paging with a TLB.
Compressed (16-bit) instructions are expanded into the 32-bit instructions
they stand for (a table lookup), then executed like those.

An instance of the core holds one or more **harts**, which share its RAM
(`CPU.harts()` in `src/cpu.ts`). Each has its own caches and JIT. The
memory is a shared WebAssembly memory, so other instances of the core, on
other threads, can run the harts too: the machine runs each hart on a
thread of its own (`src/hart-worker.ts`), or, with the virtual clock, in
turn on one. AMOs and SC are atomic operations on RAM (the core is built
with WebAssembly's atomic instructions), an SC succeeds only if memory
still holds what its LR read, and FENCE is a memory fence, so they work
across harts on threads.

`run()` executes code from a **decoded-instruction cache** (`blocks.rs`):
blocks (the instructions up to the next jump or system instruction, within a
page; a conditional branch leaves the block when taken) are decoded once,
keyed by physical address, and then run as a tight loop, with one interrupt
check per block and, for pages run recently, no address translation. Loads and stores check permissions once per TLB entry
and privilege context, not on every access. The cache is coherent with memory: a write to a 64-byte line
holding cached code, by any hart or by a device (DMA, which the machine
reports through `codeWritten`), retires the blocks of that page in every
hart's cache, so software never runs stale instructions, FENCE.I or not. `step()` is the plain
interpreter: fetch, decode, execute one instruction; `run()` falls back to it
for whatever a block can't do. (Earlier versions
also did RV32; the code and the riscv-tests for it are in the git history.)

Code that runs often is compiled by a **JIT** (`jit.rs`) to WebAssembly,
which V8 compiles to machine code. The unit is a page of RAM: once a page has
run 2000 instructions from the cache, its blocks become one function, a loop
around a switch over them, so jumps and branches within the page stay in
compiled code. Registers are WebAssembly locals within a block; loads and
stores to RAM go straight to memory through a TLB of the JIT's own;
everything else (floating point, atomics, CSRs, a TLB miss) goes back to the
interpreter for that instruction. The functions are put into the core's
function table, so `run()` calls them directly, and when code jumps to
another page that's compiled, its function goes on in that page's (a tail
call), without returning to `run()`. A page compiled again for
the same code needs twice as much running each time; pages whose code
changes start over. The JIT is on by default (`jit: false` in the CPU's or
the machine's options turns it off); the riscv-tests run both ways.

Floating point (F and D) is IEEE 754 in software, with the
[softfp](https://crates.io/crates/softfp) crate: all five rounding modes and
the exception flags, which WebAssembly's own floats can't provide. `fpu.rs`
adds what's RISC-V-specific: NaN-boxing of single-precision values, canonical
NaNs, `mstatus.FS`, `fcsr`, min/max and the instructions themselves. It also
works around three softfp bugs: a square root of a signalling NaN raised the
wrong flag, converting values of 2^32 (2^64) or more to integers wrapped
around instead of saturating, and a fused multiply-add of a zero product and
a zero of the same sign lost that sign (0 × −1 + −0 gave +0).

- `src/hart.rs`: hart state, the run loop, traps and interrupts, and the
  instruction set
- `src/blocks.rs`: the decoded-instruction cache
- `src/jit.rs`: the JIT
- `src/memory.rs`: physical memory, and loads and stores
- `src/mmu.rs`: Sv39 address translation, and the TLB
- `src/fpu.rs`: floating point (F and D)
- `src/rvc.rs`: compressed instructions; its tests check every one
  against encodings from GNU as
- `src/testfloat.rs`: the floating-point check against Berkeley TestFloat
  (see below)
- `src/csr.rs`: CSR numbers, register fields, and trap causes
- `src/lib.rs`: what `src/cpu.ts` calls

**Why it's fast:** guest RAM is a block of the WebAssembly instance's own
memory, so instruction fetches, loads and stores never leave WebAssembly.
Only device accesses call out to the TypeScript bus. 64-bit arithmetic is
native in WebAssembly, unlike in JavaScript.

## Building

`npm run build`, `npm test` and `npm start` compile it automatically
(`npm run build:wasm` on its own); cargo only recompiles what changed.
`npm test` also runs the core's Rust tests (`cargo test`). You need Rust with
the WebAssembly target (`scripts/setup-macos.sh` / `setup-linux.sh` install it):

```sh
brew install rustup                 # or the installer from https://rustup.rs
rustup default stable
rustup target add wasm32-unknown-unknown
```

Homebrew's `rustup` isn't put on `PATH`; the build finds it anyway. To use
`cargo` yourself, add `/opt/homebrew/opt/rustup/bin` to `PATH`, and run it in
`hart/`, where `.cargo/config.toml` turns on WebAssembly's atomic
instructions (stable Rust warns that this target feature is unstable; it
works). `build.rs` has the linker make the memory shared and imported.

## Conformance

`npm test` also runs the official [riscv-tests](https://github.com/riscv-software-src/riscv-tests)
(`vendor/riscv-tests`, a git submodule) for RV64: user-level instructions
(base, M, A, F, D, C) and machine/supervisor behaviour, each also run in
U-mode under virtual memory. They're built with the same GNU toolchain as the
examples, into `build/riscv-tests/`. All pass except `pmpaddr`, which
needs PMP entries; there are none, which the spec allows.

Floating point gets a much deeper check: **`npm run test:float`** builds
[Berkeley TestFloat](https://github.com/ucb-bar/berkeley-testfloat-3) with
SoftFloat's RISC-V specialization (downloaded into `build/testfloat/` the
first time) and runs 63.5 million generated cases through the hart, as
instructions: every operation, both precisions, all rounding modes, results
and exception flags. All pass.

`examples/fbench` is a C program (Mandelbrot, n-body, a series,
conversions) that prints the exact bits of its results: built for RV64GC and
natively for the host, it prints the same.

## Speed

`npm run bench` measures it. All benchmarks use the virtual clock, so every
run executes exactly the same instructions:

- **bare-metal:** `examples/bench`, C code doing matrix multiplication,
  CRC-32, sorting and string work (RV64IM). It checks the checksum the
  program prints.
- **compressed:** the same program built with compressed instructions.
- **debian:** Debian's cloud image boots to the login prompt (OpenSBI,
  U-Boot, GRUB, Debian's kernel, systemd; with a fixed date and random
  seed), from the disk as built (`images/debian/pristine.raw`, not the
  `disk.raw` you use, so your changes don't change it): about 12 billion
  instructions.

| | bare-metal | compressed | debian boot |
|---|---|---|---|
| RV64GC, instruction by instruction | 240 MIPS | 225 MIPS | 145 MIPS, 124 s |
| RV64GC, decoded-instruction cache | 460 MIPS | 455 MIPS | 260 MIPS, 69 s |
| ...branches inside blocks, cheaper loads and stores | 505 MIPS | 505 MIPS | 300 MIPS, 60 s |
| ...and Debian's boot trimmed (linux/README.md) | 505 MIPS | 505 MIPS | 284 MIPS, 43 s |
| ...and the JIT | 1305 MIPS | 1340 MIPS | 436 MIPS, 28 s |
| ...compiled code running on into the next block, whole blocks | 3815 MIPS | 4150 MIPS | 754 MIPS, 16 s |
| ...loops of one block compiled as loops | 4605 MIPS | 5085 MIPS | 756 MIPS, 16 s |
| ...compiled code shared by the harts | 5140 MIPS | 5665 MIPS | 801 MIPS, 15 s |
| (the same, Debian's image rebuilt with the desktop: 11.2 billion instructions) | 5115 MIPS | 5675 MIPS | 864 MIPS, 12.9 s |
| ...loads and stores off one value sharing one translation check | 5085 MIPS | 5660 MIPS | 912 MIPS, 12.2 s |

Measured on an Apple Silicon Mac with Node 26. Earlier, when the core also
did RV32 (see the git history), the TypeScript CPU it replaced ran the
bare-metal benchmark at 66 MIPS, this core at 265 MIPS before compressed
instructions and 238 MIPS with floating point. Compressed instructions cost
some speed when executed one by one (fetching handles 2- and 4-byte
instructions, and each compressed one is expanded); from the cache they run
as fast as any other.
