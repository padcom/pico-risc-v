# hart: the CPU core

The emulator's RISC-V hart (CPU core with its MMU), written in Rust and
compiled to WebAssembly. Everything else (devices, the virtio disk and network,
the NAT, the machine and CLI) is TypeScript in `src/`; `src/cpu.ts` loads
`build/hart.wasm` and makes it look like any other TypeScript class.

**What's here:** RV64GC (IMAFDC with Zicsr and Zifencei), machine,
supervisor and user modes with trap delegation, and Sv39 paging with a TLB.
Compressed (16-bit) instructions are expanded into the 32-bit instructions
they stand for (a table lookup), then executed like those. (Earlier versions
also did RV32; the code and the riscv-tests for it are in the git history.)

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
`cargo` yourself, add `/opt/homebrew/opt/rustup/bin` to `PATH`.

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
  seed): about 18 billion instructions.

| | bare-metal | compressed | debian boot |
|---|---|---|---|
| this core, RV64GC | 240 MIPS | 225 MIPS | 145 MIPS, 124 s |

Measured on an Apple Silicon Mac with Node 26. Earlier, when the core also
did RV32 (see the git history), the TypeScript CPU it replaced ran the
bare-metal benchmark at 66 MIPS, this core at 265 MIPS before compressed
instructions and 238 MIPS with floating point. The compressed-instruction
support costs some speed: fetching handles 2- and 4-byte instructions, and
each compressed one is expanded (a table lookup). A cache of decoded
instructions would win that back, and more.
