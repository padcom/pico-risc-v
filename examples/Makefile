# Builds the example programs into flat binaries the emulator can load.
# Requires the GNU RISC-V toolchain (macOS: brew install riscv64-elf-gcc).

CROSS   ?= riscv64-elf-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy
OBJDUMP := $(CROSS)objdump

# RAM at 0x8000_0000 is beyond the ±2 GiB the default code model reaches
# from address 0, hence medany (pc-relative addressing).
MARCH   := rv64i
MABI    := lp64
CFLAGS   = -mabi=$(MABI) -mcmodel=medany -O2 -Wall -Wextra -ffreestanding -nostdlib -nostartfiles -fno-pic
LDFLAGS := -T link.ld -Wl,--gc-sections -Wl,--no-warn-rwx-segments
COMMON  := crt0.S link.ld terminal.h
# libgcc (software multiply and divide, ...): the toolchain only has it built
# for some instruction sets, so name the soft-float one (its routines use no
# M instructions) instead of letting the -march pick, which would fail.
LIBGCC   = $(shell $(CC) -march=rv64imac -mabi=lp64 -print-libgcc-file-name)

# hello, matmul: the base instruction set (RV64I; multiplication in libgcc).
# matmul-m: same source as matmul, compiled for hardware multiply (RV64IM).
# bench: CPU benchmark (npm run bench), also RV64IM; bench-c the same with
# compressed instructions (RV64IMC).
# fbench: floating-point test program (RV64GC).
PROGRAMS := hello matmul matmul-m bench bench-c fbench

all: $(PROGRAMS:%=build/%.bin)

define link
	$(CC) -march=$(MARCH) $(CFLAGS) $(LDFLAGS) -o $@ crt0.S $(filter %.c,$^) $(LIBGCC)
endef

build/%.elf: %/*.c $(COMMON) | build
	$(link)

build/matmul-m.elf build/bench.elf: MARCH := rv64im
build/matmul-m.elf: matmul/*.c $(COMMON) | build
	$(link)

build/bench-c.elf: MARCH := rv64imc
build/bench-c.elf: bench/*.c $(COMMON) | build
	$(link)

# Floating point: no fused multiply-adds, no libm (sqrt is the instruction),
# so the results are exact functions of the program and match other CPUs.
build/fbench.elf: MARCH := rv64gc
build/fbench.elf: MABI := lp64d
build/fbench.elf: CFLAGS += -ffp-contract=off -fno-math-errno
build/fbench.elf: LIBGCC := -lgcc

build/%.bin: build/%.elf
	$(OBJCOPY) -O binary $< $@

build/%.lst: build/%.elf
	$(OBJDUMP) -d $< > $@

build:
	mkdir -p $@

clean:
	rm -rf build

.PHONY: all clean
.PRECIOUS: build/%.elf
