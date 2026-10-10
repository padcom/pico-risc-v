# Minimal C runtime start-up: set up gp and the stack, clear .bss, call main().
# When main returns, its result is left in a0 and the machine is powered off
# through the syscon device (see src/syscon.ts).

    .section .text.start
    .globl _start
_start:
    # The linker relaxes accesses to globals near __global_pointer$ into
    # gp-relative ones, so gp must be set before any C code runs. norelax keeps
    # the linker from "optimizing" this very load into a gp-relative one.
    .option push
    .option norelax
    la      gp, __global_pointer$
    .option pop

    la      sp, __stack_top

    la      t0, __bss_start
    la      t1, __bss_end
1:  bgeu    t0, t1, 2f
    sw      zero, 0(t0)
    addi    t0, t0, 4
    j       1b
2:
    call    main

    li      t0, 0x11100000          # syscon
    li      t1, 0x5555              # power-off command
    sw      t1, 0(t0)
3:  j       3b
