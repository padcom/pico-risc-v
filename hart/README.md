# hart: the CPU core

The emulator's RISC-V hart (CPU core with its MMU), written in Rust and
compiled to WebAssembly. Everything else (devices, the virtio disk and network,
the NAT, the machine and CLI) is TypeScript in `src/`; `src/cpu.ts` loads
`build/hart.wasm` and makes it look like any other TypeScript class.

**What's here:** RV32IMA with Zicsr and Zifencei, machine, supervisor and
user modes with trap delegation, and Sv32 paging with a TLB.

- `src/hart.rs`: hart state, the run loop, traps and interrupts, and the
  instruction set
- `src/memory.rs`: physical memory, and loads and stores
- `src/mmu.rs`: Sv32 address translation and the TLB
- `src/csr.rs`: CSR numbers, register fields, and trap causes
- `src/lib.rs`: what `src/cpu.ts` calls

**Why it's fast:** guest RAM is a block of the WebAssembly instance's own
memory, so instruction fetches, loads and stores never leave WebAssembly.
Only device accesses call out to the TypeScript bus. 64-bit arithmetic
(`MULH`, `instret`, and later RV64) is native in WebAssembly, unlike in
JavaScript.

## Building

`npm run build`, `npm test` and `npm start` compile it automatically
(`npm run build:wasm` on its own); cargo only recompiles what changed. You
need Rust with the WebAssembly target:

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
- **linux:** the MMU image boots to the login prompt.

| | bare-metal | linux boot |
|---|---|---|
| TypeScript CPU (before) | 66 MIPS | 26.6 MIPS, 8.4 s |
| this core | 260 MIPS | 113 MIPS, 2.0 s |

Measured on an Apple Silicon Mac with Node 26.
