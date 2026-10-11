#!/usr/bin/env bash
#
# Buildroot post-build hook (BR2_ROOTFS_POST_BUILD_SCRIPT): compiles every
# program in linux/programs/ with the target toolchain and installs it into
# /usr/local/bin of the root filesystem, right before the initramfs is packed.
#
# Each linux/programs/<name>/ directory is either:
#   - plain C sources: all *.c files are compiled into one executable <name>
#   - a Makefile project: `make` is run with CC, CFLAGS, LDFLAGS and O (an
#     output directory) set; every executable it leaves in $(O) is installed
#
# On the mmu flavor programs are ordinary dynamically linked ELF executables.
# On nommu they are static, position independent and converted to the bFLT
# format by elf2flt (that's what -Wl,-elf2flt does), and there is no fork():
# use vfork() / posix_spawn() instead.
#
# Called by Buildroot as: post-build.sh <target-dir>, with HOST_DIR,
# BUILD_DIR and BR2_CONFIG in the environment.
#
set -euo pipefail

TARGET_DIR=$1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROGRAMS=$HERE/programs
WORK=$BUILD_DIR/user-programs
INSTALL_DIR=$TARGET_DIR/usr/local/bin
MANIFEST=$WORK/installed.txt
STACK_SIZE=65536 # nommu: bFLT executables get a fixed-size stack; elf2flt's default (4 KiB) is tiny

# riscv32-buildroot-linux-uclibc-gcc (nommu), riscv32-...-gnu-gcc (mmu, glibc)
# or riscv64-...-gnu-gcc (rv64)
CC=$(find "$HOST_DIR/bin" -maxdepth 1 -name 'riscv*-buildroot-linux-*-gcc' | head -n 1)
[ -n "$CC" ] || { echo "post-build.sh: no riscv*-buildroot-linux-*-gcc in $HOST_DIR/bin" >&2; exit 1; }
if grep -q '^BR2_BINFMT_FLAT=y' "$BR2_CONFIG"; then
  CFLAGS=(-march=rv32ima -mabi=ilp32 -Os -fPIE -pie -static -ffunction-sections -fdata-sections -Wall)
  # shellcheck disable=SC2054 # the commas belong to -Wl,
  LDFLAGS=(-Wl,-elf2flt="-r -s $STACK_SIZE" -Wl,--gc-sections)
elif [[ $CC == */riscv64-* ]]; then
  CFLAGS=(-march=rv64gc -mabi=lp64d -O2 -Wall)
  LDFLAGS=()
else
  CFLAGS=(-march=rv32gc -mabi=ilp32d -O2 -Wall)
  LDFLAGS=()
fi

mkdir -p "$WORK" "$INSTALL_DIR"

# mini-rv32ima's BusyBox is built without shadow-password support, so `login`
# only checks the password field in /etc/passwd, where "x" (= "see
# /etc/shadow") can never match. Empty it: root logs in without a password.
sed -i 's/^root:x:/root::/' "$TARGET_DIR/etc/passwd"

# Remove what the previous run installed, so deleted programs disappear too.
if [ -f "$MANIFEST" ]; then
  while IFS= read -r f; do rm -f "$INSTALL_DIR/$f"; done <"$MANIFEST"
fi
: >"$MANIFEST"

shopt -s nullglob
for dir in "$PROGRAMS"/*/; do
  name=$(basename "$dir")
  out=$WORK/$name
  rm -rf "$out"
  mkdir -p "$out"
  echo ">>> program: $name"

  if [ -f "$dir/Makefile" ]; then
    # printf %q quotes each flag, and make hands recipes to the shell, so a flag
    # with spaces (-Wl,-elf2flt="-r -s ...") arrives as one argument.
    make -C "$dir" CC="$CC" CFLAGS="${CFLAGS[*]}" LDFLAGS="$(printf '%q ' ${LDFLAGS[@]+"${LDFLAGS[@]}"})" O="$out"
  else
    sources=("$dir"*.c)
    [ ${#sources[@]} -gt 0 ] || { echo "    (no *.c files and no Makefile, skipped)"; continue; }
    "$CC" "${CFLAGS[@]}" -o "$out/$name" "${sources[@]}" ${LDFLAGS[@]+"${LDFLAGS[@]}"}
  fi

  for f in "$out"/*; do
    # elf2flt leaves the original ELF next to the bFLT as <name>.gdb (for debugging)
    [[ $f == *.gdb ]] && continue
    [ -f "$f" ] && [ -x "$f" ] || continue
    install -m 0755 "$f" "$INSTALL_DIR/"
    basename "$f" >>"$MANIFEST"
    echo "    installed /usr/local/bin/$(basename "$f")"
  done
done
