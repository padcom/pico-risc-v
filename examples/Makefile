# Builds the example programs into flat binaries the emulator can load.
# Requires the GNU RISC-V toolchain (macOS: brew install riscv64-elf-gcc).

CROSS   ?= riscv64-elf-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy
OBJDUMP := $(CROSS)objdump

MARCH   := rv32i
CFLAGS  := -mabi=ilp32 -O2 -Wall -Wextra -ffreestanding -nostdlib -nostartfiles -fno-pic
LDFLAGS := -T link.ld -Wl,--gc-sections -Wl,--no-warn-rwx-segments
COMMON  := crt0.S link.ld terminal.h

# matmul-m: same source as matmul, compiled for hardware multiply (RV32IM).
# bench: CPU benchmark (npm run bench), also RV32IM; bench-c the same with
# compressed instructions (RV32IMC).
PROGRAMS := hello matmul matmul-m bench bench-c

all: $(PROGRAMS:%=build/%.bin)

define link
	$(CC) -march=$(MARCH) $(CFLAGS) $(LDFLAGS) -o $@ crt0.S $(filter %.c,$^) -lgcc
endef

build/%.elf: %/*.c $(COMMON) | build
	$(link)

build/matmul-m.elf build/bench.elf: MARCH := rv32im

build/bench-c.elf: MARCH := rv32imc
build/bench-c.elf: bench/*.c $(COMMON) | build
	$(link)
build/matmul-m.elf: matmul/*.c $(COMMON) | build
	$(link)

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
