# @padcom/pico-risc-v-hart

**A RISC-V computer in a function call.** Give it a program, compiled for
RISC-V, and get back its exit code and what it printed. Its UART goes where
you say: your terminal, a callback that sees every character as it's
written, or both. It runs in Node.js and in browsers.

It's the core of [Pico RISC-V](https://github.com/padcom/pico-risc-v), the
emulator that boots Debian in a browser tab: the same RV64GC CPU, with the
same JIT that compiles hot RISC-V code to WebAssembly, in a small bare-metal
computer.

```js
import { readFileSync } from 'node:fs'
import { run } from '@padcom/pico-risc-v-hart'

const { exitCode, output } = await run(readFileSync('hello.elf'))
```

## Try it

The package comes with an example: a hello world that asks for your name
over the UART, already compiled.

```sh
npm install @padcom/pico-risc-v-hart
node node_modules/@padcom/pico-risc-v-hart/examples/hello/run.mjs       # type your name
node node_modules/@padcom/pico-risc-v-hart/examples/hello/capture.mjs   # a script answers
```

```
Hello from RISC-V! What's your name? Ada
Nice to meet you, Ada! Your name has 3 letters: that's my exit code.
[hello.elf exited with code 3, after 1000687 instructions]
```

## Compiling C for it

You need a RISC-V GCC for bare metal (macOS: `brew install
riscv64-elf-gcc`; Debian/Ubuntu: `apt install gcc-riscv64-unknown-elf`).
The package's `c/` directory has the rest:

- `crt0.S`: the startup code. It sets up the stack, clears `.bss`, calls
  `main()`, and exits with what `main()` returns.
- `pico.ld`: the linker script. Code goes at `0x80000000`, the stack 1 MiB
  above it.
- `pico.h`: the UART (`pico_putc`, `pico_puts`, `pico_putu`, `pico_getc`,
  `pico_gets`, `pico_ready`) and `pico_exit(code)`.

```c
#include "pico.h"

int main(void) {
    pico_puts("Hello, world!\n");
    return 0;
}
```

```sh
C=node_modules/@padcom/pico-risc-v-hart/c
riscv64-elf-gcc -march=rv64imac -mabi=lp64 -mcmodel=medany -O2 \
  -ffreestanding -nostdlib -nostartfiles -I $C -T $C/pico.ld \
  $C/crt0.S hello.c -o hello.elf
```

Floating point works too (`-march=rv64gc -mabi=lp64d`). The start-up code
turns the FPU on. There's no C library, so no `printf`. Bring your own,
or use one for embedded systems (picolibc, newlib).

## The UART

`run()` and `Computer` take a `uart`: where what the program writes goes,
and where what it reads comes from.

```js
import { both, captureUart, consoleUart, run } from '@padcom/pico-risc-v-hart'

// The terminal (the default): output only...
await run(program)
// ...or your keyboard too (raw mode: every key as you type it).
await run(program, { uart: consoleUart({ input: true }) })

// Captured: every character as it's written, all of it at the end,
// and input whenever you like.
const uart = captureUart({
  onText: text => process.stdout.write(text),
  input: 'Ada\r', // (there when it starts reading)
})
const result = await run(program, { uart })
uart.text // everything it wrote (result.output has it too)
uart.send('more input\r')

// Both at once: shown on the terminal and captured.
await run(program, { uart: both(consoleUart(), captureUart({ onText })) })
```

Or write your own: anything with a `write(byte)` method is a UART.
`attach(send)` is optional and gets the function that types into the
program; `close()` is called when the program stops.

## The API

```ts
run(program: Uint8Array, options?: ComputerOptions): Promise<RunResult>
```

The program can be an ELF executable (64-bit RISC-V; its segments go where
it says, in RAM, and it starts at its entry point), or a flat binary, which
goes at the start of RAM and starts there.

| Option | Default | |
|---|---|---|
| `uart` | `consoleUart()` | where the UART goes |
| `memory` | 16 MiB | RAM, in bytes |
| `maxInstructions` | none | stop after this many |
| `signal` | | an `AbortSignal` that stops it |
| `jit` | `true` | compile hot code to WebAssembly |

The result:

| Field | |
|---|---|
| `reason` | `'exit'` (it exited), `'limit'` (`maxInstructions`) or `'aborted'` |
| `exitCode` | 0 to 255, with `'exit'` |
| `output` | everything it wrote to the UART, as text |
| `instructions` | how many it ran |

For more control, use `Computer`: `load(program)`, `run()`, `send(input)`
while it runs, and `stop()`. Its `cpu`, `uart` and `clint` are there too.
The building blocks (`CPU`, `SystemBus`, `RAM`, `Terminal`, `Clint`,
`Syscon`, `parseElf`, and a small assembler, `asm`) are exported for
machines of your own. That's how Pico RISC-V's Linux machine is built.

## The machine

- **CPU:** one RV64GC hart (RV64IMAFDC, Zicsr, Zifencei), in machine,
  supervisor and user modes, with Sv39 virtual memory. Hot code is compiled
  to WebAssembly.
- **Memory map:**

  | Address | |
  |---|---|
  | `0x1000_0000` | UART (16550-style); its interrupt is the hart's machine external interrupt (`mip.MEIP`) |
  | `0x1100_0000` | CLINT: `mtime` (1 MHz, real time), `mtimecmp`, `msip` |
  | `0x1110_0000` | syscon: write `0x5555` to exit with code 0, or `code << 16 \| 0x3333` to exit with `code` |
  | `0x8000_0000` | RAM |

- **Waiting:** a program waiting in `wfi` sleeps (no CPU) until its timer
  or input wakes it. One that polls the UART in a loop keeps running at
  full speed.

In a browser, compile the core first and hand it over:
`setCoreModule(await WebAssembly.compileStreaming(fetch(<url of the package's
build/hart.wasm>)))`. (Node.js reads it from the package by itself.)

## Who wrote it

Every line of it was written by Claude (Anthropic's AI), in Claude Code, as
part of [Pico RISC-V](https://github.com/padcom/pico-risc-v).

License: ISC.
