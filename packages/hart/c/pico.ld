/*
 * Where a C program goes on @padcom/pico-risc-v-hart's computer: RAM from
 * 0x80000000, the code first (crt0.S's _start), the stack at the top of
 * PICO_RAM (1 MiB here: the computer has 16 MiB by default; more needs
 * `--defsym=PICO_RAM=<bytes>` at link time, up to its `memory`).
 */
OUTPUT_ARCH(riscv)
ENTRY(_start)

PICO_RAM = DEFINED(PICO_RAM) ? PICO_RAM : 1M;

MEMORY
{
    RAM (rwx) : ORIGIN = 0x80000000, LENGTH = 16M
}

SECTIONS
{
    .text : {
        KEEP(*(.text.start))
        *(.text .text.*)
    } > RAM

    .rodata : { *(.rodata .rodata.* .srodata .srodata.*) } > RAM

    .data : {
        __global_pointer$ = . + 0x800;
        *(.data .data.* .sdata .sdata.*)
    } > RAM

    .bss (NOLOAD) : {
        __bss_start = .;
        *(.bss .bss.* .sbss .sbss.* COMMON)
        __bss_end = .;
    } > RAM

    __stack_top = ORIGIN(RAM) + PICO_RAM;
}
