# hart: the CPU core

The emulator's RISC-V hart (CPU core with its MMU), written in Rust and
compiled to WebAssembly. Everything else (devices, the virtio disk and network,
the NAT, the machine and CLI) is TypeScript in `src/`; `src/cpu.ts` loads
`build/hart.wasm` and makes it look like any other TypeScript class.

**What's here:** RV32GC and RV64GC (IMAFDC with Zicsr and Zifencei), machine,
supervisor and user modes with trap delegation, and Sv32 (RV32) or Sv39
(RV64) paging with a TLB. The register width is chosen when the CPU is
created: the code is generic over it and compiled once for each, so neither
pays for the other. On RV32 the 64-bit registers hold sign-extended 32-bit
values, the way RV64 itself handles 32-bit values, so most instructions are
written only once. Compressed (16-bit) instructions are expanded into the
32-bit instructions they stand for (a table per width), then executed like
those.

Floating point (F and D) is IEEE 754 in software, with the
[softfp](https://crates.io/crates/softfp) crate: all five rounding modes and
the exception flags, which WebAssembly's own floats can't provide. `fpu.rs`
adds what's RISC-V-specific: NaN-boxing of single-precision values, canonical
NaNs, `mstatus.FS`, `fcsr`, min/max and the instructions themselves. It also
works around two softfp bugs: a square root of a signalling NaN raised the
wrong flag, and converting values of 2^32 (2^64) or more to integers wrapped
around instead of saturating.

- `src/hart.rs`: hart state, the run loop, traps and interrupts, and the
  instruction set
- `src/memory.rs`: physical memory, and loads and stores
- `src/mmu.rs`: Sv32 and Sv39 address translation, and the TLB
- `src/fpu.rs`: floating point (F and D)
- `src/rvc.rs`: compressed instructions; its tests check every one
  against encodings from GNU as
- `src/testfloat.rs`: the floating-point check against Berkeley TestFloat
  (see below)
- `src/csr.rs`: CSR numbers, register fields, and trap causes
- `src/lib.rs`: what `src/cpu.ts` calls

**Why it's fast:** guest RAM is a block of the WebAssembly instance's own
memory, so instruction fetches, loads and stores never leave WebAssembly.
Only device accesses call out to the TypeScript bus. 64-bit arithmetic
(`MULH`, `instret`, and later RV64) is native in WebAssembly, unlike in
JavaScript.

## Building

`npm run build`, `npm test` and `npm start` compile it automatically
(`npm run build:wasm` on its own); cargo only recompiles what changed.
`npm test` also runs the core's Rust tests (`cargo test`). You need Rust with
the WebAssembly target:

```sh
brew install rustup                 # or the installer from https://rustup.rs
rustup default stable
rustup target add wasm32-unknown-unknown
```

Homebrew's `rustup` isn't put on `PATH`; the build finds it anyway. To use
`cargo` yourself, add `/opt/homebrew/opt/rustup/bin` to `PATH`.

## Conformance

`npm test` also runs the official [riscv-tests](https://github.com/riscv-software-src/riscv-tests)
(`vendor/riscv-tests`, a git submodule) for both widths: user-level
instructions (base, M, A, F, D, C) and machine/supervisor behaviour, each
also run in U-mode under virtual memory. They're built with the same GNU toolchain as
the examples, into `build/riscv-tests/`. All pass except `pmpaddr`, which
needs PMP entries; there are none, which the spec allows.

Floating point gets a much deeper check: **`npm run test:float`** builds
[Berkeley TestFloat](https://github.com/ucb-bar/berkeley-testfloat-3) with
SoftFloat's RISC-V specialization (downloaded into `build/testfloat/` the
first time) and runs 2.2 million generated cases through the hart, as
instructions: every operation, both precisions, all rounding modes, results
and exception flags. All pass.

`examples/fbench` is a C program (Mandelbrot, n-body, a series,
conversions) that prints the exact bits of its results: built for RV32GC,
for RV64GC and natively for the host, it prints the same.

## Speed

`npm run bench` measures it. Both benchmarks use the virtual clock, so every
run executes exactly the same instructions:

- **bare-metal:** `examples/bench`, C code doing matrix multiplication,
  CRC-32, sorting and string work. It checks the checksum the program prints.
- **compressed:** the same program built with compressed instructions.
- **rv64:** the same program built for RV64, on an RV64 CPU.
- **linux:** the MMU image boots to the login prompt, with a fixed date and
  random seed; **linux64** the same with the RV64 image.

| | bare-metal | compressed | rv64 | linux boot | linux64 boot |
|---|---|---|---|---|---|
| TypeScript CPU, RV32IMA | 66 MIPS | – | – | 26.6 MIPS, 8.4 s | – |
| this core, RV32IMA | 265 MIPS | – | – | 113 MIPS, 2.0 s | – |
| this core, RV32IMAC | 245 MIPS | 222 MIPS | – | 107 MIPS, 2.3 s | – |
| this core, RV32/RV64IMAC | 247 MIPS | 222 MIPS | 226 MIPS | 112 MIPS, 2.1 s | 109 MIPS, 2.1 s |
| this core, RV32GC/RV64GC | 238 MIPS | 213 MIPS | 224 MIPS | 112 MIPS, 2.1 s | 110 MIPS, 2.1 s |

Measured on an Apple Silicon Mac with Node 26. The compressed-instruction
support costs some speed: fetching handles 2- and 4-byte instructions, and
each compressed one is expanded (a table lookup). A cache of decoded
instructions would win that back, and more.
