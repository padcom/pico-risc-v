# hart: the CPU core

The emulator's RISC-V hart (CPU core with its MMU), written in Rust and
compiled to WebAssembly. Everything else (devices, the virtio disk and network,
the NAT, the machine and CLI) is TypeScript in `src/`; `src/cpu.ts` loads
`build/hart.wasm` and makes it look like any other TypeScript class.

**What's here:** RV32IMAC with Zicsr and Zifencei, machine, supervisor and
user modes with trap delegation, and Sv32 paging with a TLB. Compressed
(16-bit) instructions are expanded into the 32-bit instructions they stand
for, then executed like those.

- `src/hart.rs`: hart state, the run loop, traps and interrupts, and the
  instruction set
- `src/memory.rs`: physical memory, and loads and stores
- `src/mmu.rs`: Sv32 address translation and the TLB
- `src/rvc.rs`: compressed instructions; its tests check every one
  against encodings from GNU as
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

## Speed

`npm run bench` measures it. Both benchmarks use the virtual clock, so every
run executes exactly the same instructions:

- **bare-metal:** `examples/bench`, C code doing matrix multiplication,
  CRC-32, sorting and string work. It checks the checksum the program prints.
- **compressed:** the same program built with compressed instructions.
- **linux:** the MMU image boots to the login prompt, with a fixed date and
  random seed.

| | bare-metal | compressed | linux boot |
|---|---|---|---|
| TypeScript CPU, RV32IMA | 66 MIPS | – | 26.6 MIPS, 8.4 s |
| this core, RV32IMA | 265 MIPS | – | 113 MIPS, 2.0 s |
| this core, RV32IMAC | 245 MIPS | 222 MIPS | 107 MIPS, 2.3 s |

Measured on an Apple Silicon Mac with Node 26. The compressed-instruction
support costs some speed: fetching handles 2- and 4-byte instructions, and
each compressed one is expanded (a table lookup). A cache of decoded
instructions would win that back, and more.
