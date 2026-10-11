#!/usr/bin/env bash
#
# Builds a Linux image for the emulator from source with Buildroot. Two
# flavors (FLAVOR=...):
#
#   mmu    (default) regular RV32 Linux with virtual memory (Sv32), running in
#          S-mode under OpenSBI. Upstream Buildroot, uClibc-ng with threads and
#          wide chars, plus extra packages such as Midnight Commander (mc).
#          → images/linux-mmu/fw_dynamic.bin (firmware), Image (kernel) and
#            rootfs.ext4 (root filesystem disk image, replaced on every build)
#   nommu  mini-rv32ima's tiny no-MMU kernel running in M-mode.
#          → images/linux/Image
#
# Both include your own additions:
#
#   linux/overlay/     files copied verbatim into the root filesystem
#   linux/programs/    one directory per program, compiled for the target
#                      and installed into /usr/local/bin (see post-build.sh)
#   linux/mmu/         mmu flavor: Buildroot and kernel config fragments
#                      (add packages to buildroot.fragment)
#   linux/nommu/configs/  nommu flavor: optional replacements for
#                      mini-rv32ima's configs (buildroot_config,
#                      custom_kernel_config, busybox_config, uclibc_config)
#
# The build runs in a Podman container (linux/podman.sh, linux/Containerfile)
# so the host's distribution and compiler don't matter; that works on Linux
# and on macOS. Set NATIVE=1 to build directly on a Linux host instead.
# The first build downloads and compiles a cross toolchain, the kernel and
# all packages (a few GB, a while); later runs are incremental.
#
# usage: [FLAVOR=mmu|nommu] linux/build.sh [buildroot-make-target...]
#   linux/build.sh                    build (or update) the image
#   linux/build.sh linux-menuconfig   any Buildroot target, e.g. to tweak configs
#   linux/build.sh clean              wipe build output (keeps downloads)
#
# Environment:
#   FLAVOR      mmu (default) or nommu
#   NATIVE=1    build on this (Linux) host instead of in the Podman container
#   BUILD_DIR   where Buildroot lives and builds (default: <project>/.buildroot/<flavor>;
#               in the container: the risc-emulator-buildroot[-mmu] volume)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LINUX_DIR=$ROOT/linux
FLAVOR=${FLAVOR:-mmu}
BUILD_DIR=${BUILD_DIR:-$ROOT/.buildroot/$FLAVOR}
BR=$BUILD_DIR/buildroot

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

case "$FLAVOR" in
  mmu)
    BUILDROOT_URL=https://gitlab.com/buildroot.org/buildroot.git
    BUILDROOT_REV=2026.02.3 # LTS release
    OUT_DIR=$ROOT/images/linux-mmu
    ;;
  nommu)
    # mini-rv32ima's Buildroot fork, pinned for reproducible builds.
    BUILDROOT_URL=https://github.com/cnlohr/buildroot.git
    BUILDROOT_REV=851edd247f5e2e8e10f943c52218bc54c657688f
    OUT_DIR=$ROOT/images/linux
    MINI=$ROOT/vendor/mini-rv32ima
    MINI_URL=https://github.com/cnlohr/mini-rv32ima.git
    ;;
  *) die "unknown FLAVOR '$FLAVOR' (use mmu or nommu)" ;;
esac

if [ -z "${RISC_EMULATOR_BUILD_CONTAINER:-}" ] && [ "${NATIVE:-}" != 1 ]; then
  exec bash "$LINUX_DIR/podman.sh" "$@"
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

step "Buildroot $BUILDROOT_REV ($FLAVOR)"
if [ ! -d "$BR/.git" ]; then
  git init -q "$BR"
  git -C "$BR" remote add origin "$BUILDROOT_URL"
fi
if [ "$(cat "$BUILD_DIR/buildroot-rev" 2>/dev/null)" != "$BUILDROOT_REV" ]; then
  git -C "$BR" fetch --depth 1 origin "$BUILDROOT_REV"
  git -C "$BR" checkout -q FETCH_HEAD
  echo "$BUILDROOT_REV" >"$BUILD_DIR/buildroot-rev"
fi

# Settings shared by both flavors: our hooks, and a password-less root account
# (the console login itself is set up in linux/overlay/etc/inittab).
common_config() {
  cat <<EOF
BR2_ROOTFS_OVERLAY="$LINUX_DIR/overlay"
BR2_ROOTFS_POST_BUILD_SCRIPT="$LINUX_DIR/post-build.sh"
BR2_ROOTFS_POST_IMAGE_SCRIPT=""
BR2_SYSTEM_DEFAULT_PATH="/usr/local/bin:/bin:/sbin:/usr/bin:/usr/sbin"
BR2_DL_DIR="$BUILD_DIR/dl"
BR2_TARGET_ENABLE_ROOT_LOGIN=y
BR2_TARGET_GENERIC_ROOT_PASSWD=""
EOF
}
COMMON_KEYS='BR2_(ROOTFS_OVERLAY|ROOTFS_POST_BUILD_SCRIPT|ROOTFS_POST_IMAGE_SCRIPT|SYSTEM_DEFAULT_PATH|DL_DIR|TARGET_ENABLE_ROOT_LOGIN|TARGET_GENERIC_ROOT_PASSWD)'

step "Configuring"
if [ "$FLAVOR" = mmu ]; then
  # Buildroot's own QEMU RV32 board config, minus what's QEMU-specific, plus
  # linux/mmu/buildroot.fragment (CPU features, packages, ...) and our hooks.
  {
    grep -vE "^(# )?(${COMMON_KEYS}|BR2_TARGET_ROOTFS_EXT2|BR2_PACKAGE_HOST_QEMU[A-Z_]*|BR2_SYSTEM_DHCP)[= ]" \
      "$BR/configs/qemu_riscv32_virt_defconfig"
    cat "$LINUX_DIR/mmu/buildroot.fragment"
    echo "BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES=\"$LINUX_DIR/mmu/linux.fragment\""
    common_config
  } >"$BUILD_DIR/defconfig.new"
  if install_if_changed "$BUILD_DIR/defconfig.new" "$BUILD_DIR/defconfig" || [ ! -f "$BR/.config" ]; then
    make -C "$BR" BR2_DEFCONFIG="$BUILD_DIR/defconfig" defconfig
  fi
else
  step "mini-rv32ima configuration (git submodule vendor/mini-rv32ima)"
  cd "$ROOT"
  if [ ! -e "$MINI/.git" ]; then
    if git config -f .gitmodules --get submodule.vendor/mini-rv32ima.path >/dev/null 2>&1; then
      git submodule update --init vendor/mini-rv32ima
    else
      git submodule add "$MINI_URL" vendor/mini-rv32ima
    fi
  fi
  # A config from linux/nommu/configs/ wins over mini-rv32ima's.
  config() {
    if [ -f "$LINUX_DIR/nommu/configs/$1" ]; then echo "$LINUX_DIR/nommu/configs/$1"; else echo "$MINI/configs/$1"; fi
  }
  install_if_changed "$(config custom_kernel_config)" "$BR/kernel_config" || true
  install_if_changed "$(config busybox_config)" "$BR/busybox_config" || true
  install_if_changed "$(config uclibc_config)" "$BR/uclibc_config" || true
  install_if_changed "$(config uclibc_config)" "$BR/uclibc_config_extra" || true
  {
    grep -vE "^(# )?${COMMON_KEYS}[= ]" "$(config buildroot_config)"
    common_config
  } >"$BUILD_DIR/buildroot_config.new"
  if install_if_changed "$BUILD_DIR/buildroot_config.new" "$BUILD_DIR/buildroot_config" || [ ! -f "$BR/.config" ]; then
    cp "$BUILD_DIR/buildroot_config" "$BR/.config"
    make -C "$BR" olddefconfig
  fi
fi

if [ $# -gt 0 ]; then
  step "make $*"
  make -C "$BR" "$@"
  exit
fi

step "Building (toolchain, packages, programs, kernel, root filesystem)"
make -C "$BR"

mkdir -p "$OUT_DIR"
cp "$BR/output/images/Image" "$OUT_DIR/Image"
if [ "$FLAVOR" = mmu ]; then
  cp "$BR/output/images/fw_dynamic.bin" "$OUT_DIR/fw_dynamic.bin"
  cp --sparse=always "$BR/output/images/rootfs.ext4" "$OUT_DIR/rootfs.ext4"
  # What this image was built from; `npm start` rebuilds when it changes.
  bash "$LINUX_DIR/inputs-hash.sh" >"$OUT_DIR/.inputs-hash"
fi
step "Linux image ready in ${OUT_DIR#"$ROOT"/}: $(find "$OUT_DIR" -maxdepth 1 -type f -printf '%f ')"
