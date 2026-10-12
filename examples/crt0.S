# Minimal C runtime start-up: set up gp and the stack, enable the FPU (if the
# program uses it), clear .bss, call main().
# When main returns, its result is left in a0 and the machine is powered off
# through the syscon device (see src/syscon.ts).
#
# All harts start here. Hart 0 runs main(); the others (each with a stack of
# 16 KiB below the previous hart's) wait until .bss is cleared, then call
# hart_main(hart id), which by default parks them in WFI. A program that wants
# them defines its own.

#define STACK_SHIFT 14            /* 16 KiB per hart */

    .section .text.start
    .option arch, +zicsr            # (for mhartid, whatever -march says)
    .globl _start
_start:
    # The linker relaxes accesses to globals near __global_pointer$ into
    # gp-relative ones, so gp must be set before any C code runs. norelax keeps
    # the linker from "optimizing" this very load into a gp-relative one.
    .option push
    .option norelax
    la      gp, __global_pointer$
    .option pop

    csrr    s1, mhartid
    slli    t1, s1, STACK_SHIFT
    la      sp, __stack_top
    sub     sp, sp, t1

#ifdef __riscv_flen
    # The FPU is off after reset (FP instructions are illegal) until
    # mstatus.FS says otherwise: set it to Initial.
    li      t0, 1 << 13
    csrs    mstatus, t0
#endif

    bnez    s1, secondary

    la      t0, __bss_start
    la      t1, __bss_end
1:  bgeu    t0, t1, 2f
    sw      zero, 0(t0)
    addi    t0, t0, 4
    j       1b
2:
    fence   w, w
    la      t0, bss_cleared
    li      t1, 1
    sw      t1, 0(t0)
    call    main

    li      t0, 0x11100000          # syscon
    li      t1, 0x5555              # power-off command
    sw      t1, 0(t0)
3:  j       3b

secondary:
    la      t1, bss_cleared
4:  lw      t2, 0(t1)
    beqz    t2, 4b
    fence   r, rw
    mv      a0, s1
    call    hart_main
    # (falls through: park)

    .weak hart_main
hart_main:
    wfi
    j       hart_main

    .data
    .balign 4
bss_cleared:
    .word   0
