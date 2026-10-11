#!/usr/bin/env bash
#
# Builds the Linux kernel and the OpenSBI firmware Debian boots on, from
# source with Buildroot (2026.02 LTS): a cross toolchain, Linux 6.18 and
# OpenSBI, configured for exactly the emulated CPU (RV64GC):
#
#   linux/kernel/buildroot.fragment   Buildroot settings (CPU, toolchain, firmware)
#   linux/kernel/linux.fragment       kernel options
#
# → images/kernel/fw_dynamic.bin (firmware) and Image (kernel)
#
# The build runs in a Podman container (linux/podman.sh, linux/kernel/Containerfile)
# so the host's distribution and compiler don't matter; that works on Linux
# and on macOS. Set NATIVE=1 to build directly on a Linux host instead.
# The first build downloads and compiles the cross toolchain, the kernel and
# the firmware (a few GB, a while); later runs are incremental.
#
# usage: linux/kernel/build.sh [buildroot-make-target...]
#   linux/kernel/build.sh                    build (or update) the kernel and firmware
#   linux/kernel/build.sh linux-menuconfig   any Buildroot target, e.g. to tweak the kernel
#   linux/kernel/build.sh clean              wipe build output (keeps downloads)
#
# Environment:
#   NATIVE=1    build on this (Linux) host instead of in the Podman container
#   BUILD_DIR   where Buildroot lives and builds (default: <project>/.buildroot/kernel;
#               in the container: the risc-emulator-kernel volume)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
KERNEL_DIR=$ROOT/linux/kernel
BUILD_DIR=${BUILD_DIR:-$ROOT/.buildroot/kernel}
BR=$BUILD_DIR/buildroot
OUT_DIR=$ROOT/images/kernel
BUILDROOT_URL=https://gitlab.com/buildroot.org/buildroot.git
BUILDROOT_REV=2026.02.3 # LTS release
BOARD=qemu_riscv64_virt_defconfig

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

if [ -z "${RISC_EMULATOR_BUILD_CONTAINER:-}" ] && [ "${NATIVE:-}" != 1 ]; then
  FLAVOR=kernel exec bash "$ROOT/linux/podman.sh" "$@"
fi
[ "$(uname -s)" = Linux ] || die "a native build (NATIVE=1) needs a Linux host; this is $(uname -s)"

missing=()
for tool in make gcc g++ git wget cpio unzip rsync bc file perl python3 patch bzip2 gzip tar find sed awk flock; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
[ ${#missing[@]} -eq 0 ] || die "missing host tools: ${missing[*]}
  Debian/Ubuntu: sudo apt install build-essential git wget cpio unzip rsync bc file perl python3 patch bzip2
  Fedora:        sudo dnf install @development-tools gcc-c++ git wget cpio unzip rsync bc file perl python3 patch bzip2"

# Copy $1 to $2 only if the content differs, so Buildroot doesn't see spurious changes.
install_if_changed() {
  if ! cmp -s "$1" "$2"; then cp "$1" "$2"; return 0; fi
  return 1
}

# Two builds in one build directory would trample each other's files.
mkdir -p "$BUILD_DIR"
exec 9>"$BUILD_DIR/.lock"
flock --nonblock 9 || die "another build is already running in $BUILD_DIR; wait for it to finish"

step "Buildroot $BUILDROOT_REV"
if [ ! -d "$BR/.git" ]; then
  git init -q "$BR"
  git -C "$BR" remote add origin "$BUILDROOT_URL"
fi
if [ "$(cat "$BUILD_DIR/buildroot-rev" 2>/dev/null)" != "$BUILDROOT_REV" ]; then
  git -C "$BR" fetch --depth 1 origin "$BUILDROOT_REV"
  git -C "$BR" checkout -q FETCH_HEAD
  echo "$BUILDROOT_REV" >"$BUILD_DIR/buildroot-rev"
fi

step "Configuring"
# Buildroot's own QEMU board config, minus what's QEMU-specific or about the
# root filesystem, plus our fragment and the kernel options.
{
  grep -vE "^(# )?(BR2_ROOTFS_POST_IMAGE_SCRIPT|BR2_TARGET_ROOTFS_EXT2|BR2_PACKAGE_HOST_QEMU[A-Z_]*|BR2_SYSTEM_DHCP)[= ]" \
    "$BR/configs/$BOARD"
  cat "$KERNEL_DIR/buildroot.fragment"
  echo "BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES=\"$KERNEL_DIR/linux.fragment\""
  echo 'BR2_ROOTFS_POST_IMAGE_SCRIPT=""'
  echo "BR2_DL_DIR=\"$BUILD_DIR/dl\""
} >"$BUILD_DIR/defconfig.new"
reconfigured=
if install_if_changed "$BUILD_DIR/defconfig.new" "$BUILD_DIR/defconfig" || [ ! -f "$BR/.config" ]; then
  make -C "$BR" BR2_DEFCONFIG="$BUILD_DIR/defconfig" defconfig
  reconfigured=1
fi

if [ $# -gt 0 ]; then
  step "make $*"
  make -C "$BR" "$@"
  exit
fi

# Buildroot doesn't rebuild what's already built when the target CPU or the
# toolchain changes: everything would have to be recompiled for them, so start
# over (downloads are kept).
grep -E '^BR2_(RISCV|riscv|TOOLCHAIN|GCC|BINUTILS)' "$BR/.config" >"$BUILD_DIR/toolchain-config.new" || true
if [ -d "$BR/output/host" ] && ! cmp -s "$BUILD_DIR/toolchain-config.new" "$BUILD_DIR/toolchain-config" 2>/dev/null; then
  step "Target CPU or toolchain changed: rebuilding everything (make clean)"
  make -C "$BR" clean
fi
mv "$BUILD_DIR/toolchain-config.new" "$BUILD_DIR/toolchain-config"

# Nor does it notice changed kernel options or firmware settings: configure
# the kernel again (kbuild then recompiles what they affect) and rebuild
# OpenSBI, both quick next to a full build.
kernel_inputs=$(cat "$KERNEL_DIR/linux.fragment" "$BUILD_DIR/defconfig" | cksum)
if [ -d "$BR/output/build" ] && { [ -n "$reconfigured" ] || [ "$kernel_inputs" != "$(cat "$BUILD_DIR/kernel-inputs" 2>/dev/null)" ]; }; then
  step "Configuration changed: reconfiguring the kernel, rebuilding the firmware"
  make -C "$BR" linux-reconfigure opensbi-rebuild
fi

step "Building (toolchain, kernel, firmware)"
make -C "$BR"
echo "$kernel_inputs" >"$BUILD_DIR/kernel-inputs"

mkdir -p "$OUT_DIR"
cp "$BR/output/images/Image" "$BR/output/images/fw_dynamic.bin" "$OUT_DIR/"
# What these were built from; `npm start` rebuilds when it changes.
bash "$ROOT/linux/inputs-hash.sh" kernel >"$OUT_DIR/.inputs-hash"
step "Kernel and firmware ready in images/kernel: $(cd "$OUT_DIR" && echo Image fw_dynamic.bin)"
