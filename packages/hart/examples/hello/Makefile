# hello.elf, from hello.c, with the package's C runtime (../../c): a RISC-V
# GCC for bare metal (macOS: brew install riscv64-elf-gcc; Debian/Ubuntu:
# apt install gcc-riscv64-unknown-elf, then make CC=riscv64-unknown-elf-gcc).
CC := riscv64-elf-gcc
PICO := ../../c
CFLAGS := -march=rv64imac -mabi=lp64 -mcmodel=medany -O2 -Wall \
          -ffreestanding -nostdlib -nostartfiles -I $(PICO)

hello.elf: hello.c $(PICO)/crt0.S $(PICO)/pico.h $(PICO)/pico.ld
	$(CC) $(CFLAGS) -T $(PICO)/pico.ld $(PICO)/crt0.S hello.c -o $@

clean:
	rm -f hello.elf
