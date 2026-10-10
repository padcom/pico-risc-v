#!/usr/bin/env bash
#
# Builds images/linux/Image from source: a nommu RV32 Linux kernel with a
# BusyBox + uClibc initramfs, using mini-rv32ima's Buildroot configuration,
# plus your own additions:
#
#   linux/overlay/     files copied verbatim into the root filesystem
#   linux/programs/    one directory per program, compiled for the target
#                      and installed into /usr/local/bin (see post-build.sh)
#   linux/configs/     optional replacements for mini-rv32ima's configs
#                      (buildroot_config, custom_kernel_config, busybox_config,
#                      uclibc_config); copy one from vendor/mini-rv32ima/configs
#                      and edit it to customize the kernel, BusyBox, ...
#
# The build runs in a Podman container (linux/podman.sh, linux/Containerfile)
# so the host's distribution and compiler don't matter; that works on Linux
# and on macOS. Set NATIVE=1 to build directly on a Linux host instead.
# The first build downloads and compiles a cross toolchain, the kernel and
# BusyBox (~2-3 GB, a while); later runs are incremental.
#
# usage: linux/build.sh [buildroot-make-target...]
#   linux/build.sh                    build (or update) the image
#   linux/build.sh linux-menuconfig   any Buildroot target, e.g. to tweak configs
#   linux/build.sh clean              wipe build output (keeps downloads)
#
# Environment:
#   NATIVE=1    build on this (Linux) host instead of in the Podman container
#   BUILD_DIR   where Buildroot lives and builds (default: <project>/.buildroot;
#               in the container: the risc-emulator-buildroot volume)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LINUX_DIR=$ROOT/linux
MINI=$ROOT/vendor/mini-rv32ima
MINI_URL=https://github.com/cnlohr/mini-rv32ima.git
BUILD_DIR=${BUILD_DIR:-$ROOT/.buildroot}
BR=$BUILD_DIR/buildroot
# mini-rv32ima's Buildroot fork, pinned for reproducible builds.
BUILDROOT_URL=https://github.com/cnlohr/buildroot.git
BUILDROOT_REV=851edd247f5e2e8e10f943c52218bc54c657688f
IMAGE=$ROOT/images/linux/Image

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

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

step "mini-rv32ima configuration (git submodule vendor/mini-rv32ima)"
cd "$ROOT"
if [ ! -e "$MINI/.git" ]; then
  if git config -f .gitmodules --get submodule.vendor/mini-rv32ima.path >/dev/null 2>&1; then
    git submodule update --init vendor/mini-rv32ima
  else
    git submodule add "$MINI_URL" vendor/mini-rv32ima
  fi
fi

step "Buildroot $BUILDROOT_REV"
if [ ! -d "$BR/.git" ]; then
  git init -q "$BR"
  git -C "$BR" remote add origin "$BUILDROOT_URL"
fi
if [ "$(git -C "$BR" rev-parse -q --verify HEAD || true)" != "$BUILDROOT_REV" ]; then
  git -C "$BR" fetch --depth 1 origin "$BUILDROOT_REV"
  git -C "$BR" checkout -q FETCH_HEAD
fi

step "Configuring"
# A config from linux/configs/ wins over mini-rv32ima's.
config() {
  if [ -f "$LINUX_DIR/configs/$1" ]; then echo "$LINUX_DIR/configs/$1"; else echo "$MINI/configs/$1"; fi
}
install_if_changed "$(config custom_kernel_config)" "$BR/kernel_config" || true
install_if_changed "$(config busybox_config)" "$BR/busybox_config" || true
install_if_changed "$(config uclibc_config)" "$BR/uclibc_config" || true
install_if_changed "$(config uclibc_config)" "$BR/uclibc_config_extra" || true

# The Buildroot config, with our hooks in place of its own, and a password-less
# root account (the console login is set up in linux/overlay/etc/inittab).
OVERRIDES='BR2_(ROOTFS_OVERLAY|ROOTFS_POST_BUILD_SCRIPT|ROOTFS_POST_IMAGE_SCRIPT|SYSTEM_DEFAULT_PATH|DL_DIR|TARGET_ENABLE_ROOT_LOGIN|TARGET_GENERIC_ROOT_PASSWD)'
{
  grep -vE "^(# )?${OVERRIDES}[= ]" "$(config buildroot_config)"
  cat <<EOF
BR2_ROOTFS_OVERLAY="$LINUX_DIR/overlay"
BR2_ROOTFS_POST_BUILD_SCRIPT="$LINUX_DIR/post-build.sh"
BR2_ROOTFS_POST_IMAGE_SCRIPT=""
BR2_SYSTEM_DEFAULT_PATH="/usr/local/bin:/bin:/sbin:/usr/bin:/usr/sbin"
BR2_DL_DIR="$BUILD_DIR/dl"
BR2_TARGET_ENABLE_ROOT_LOGIN=y
BR2_TARGET_GENERIC_ROOT_PASSWD=""
EOF
} >"$BUILD_DIR/buildroot_config.new"
if install_if_changed "$BUILD_DIR/buildroot_config.new" "$BUILD_DIR/buildroot_config" || [ ! -f "$BR/.config" ]; then
  cp "$BUILD_DIR/buildroot_config" "$BR/.config"
  make -C "$BR" olddefconfig
fi

if [ $# -gt 0 ]; then
  step "make $*"
  make -C "$BR" "$@"
  exit
fi

step "Building (toolchain, BusyBox, programs, kernel with initramfs)"
make -C "$BR"

mkdir -p "$(dirname "$IMAGE")"
cp "$BR/output/images/Image" "$IMAGE"
step "Linux image ready: $IMAGE ($(du -h "$IMAGE" | cut -f1))"
