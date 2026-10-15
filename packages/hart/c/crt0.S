# Start-up code for C programs on @padcom/pico-risc-v-hart's computer: set
# up gp and the stack, turn the FPU on (if the program uses it), clear .bss,
# call main(), and exit with what it returns (pico_exit(), pico.h): run()'s
# exitCode.

    .section .text.start
    .option arch, +zicsr            # (for mstatus, whatever -march says)
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

#ifdef __riscv_flen
    # The FPU is off after reset (FP instructions are illegal) until
    # mstatus.FS says otherwise: set it to Initial.
    li      t0, 1 << 13
    csrs    mstatus, t0
#endif

    la      t0, __bss_start
    la      t1, __bss_end
1:  bgeu    t0, t1, 2f
    sb      zero, 0(t0)
    addi    t0, t0, 1
    j       1b
2:
    li      a0, 0                   # argc
    li      a1, 0                   # argv
    call    main
    call    pico_exit               # (with main's result, in a0)

# void pico_exit(int code): the syscon ends the program, with `code`.
    .globl pico_exit
pico_exit:
    li      t0, 0x11100000          # the syscon
    andi    t1, a0, 0xff            # (an exit code is a byte, as in a shell)
    beqz    t1, 3f
    slli    t1, t1, 16
    li      t2, 0x3333              # exit with the code in the upper half...
    or      t1, t1, t2
    j       4f
3:  li      t1, 0x5555              # ...or code 0
4:  sw      t1, 0(t0)
5:  j       5b
