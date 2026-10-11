#!/usr/bin/env bash
#
# Builds a Debian disk image for the 64-bit machine: Debian 13 (trixie) for
# riscv64, installed with mmdebstrap from Debian's own packages, in an ext4
# file system image. It boots with our kernel and firmware (images/kernel/,
# linux/kernel/build.sh); `npm start` builds whatever is missing and boots it.
#
#   linux/debian/packages   what's installed on top of the minimal base system
#   linux/debian/overlay/   files copied verbatim into the root filesystem
#
# → images/debian/rootfs.ext4 (replaced on every build)
#
# The packages' install scripts are riscv64 programs; they run under QEMU's
# user-mode emulator (qemu-user, through binfmt_misc). The build runs in a
# Podman container (linux/podman.sh, linux/debian/Containerfile) that mounts
# a binfmt_misc of its own for that, so nothing changes on the host or in
# Podman's VM. Set NATIVE=1 to build directly on a Linux host instead, as
# root, or as a user with mmdebstrap's unshare mode set up; there, riscv64
# programs must already run (Debian/Ubuntu: apt install qemu-user-binfmt).
#
# usage: linux/debian/build.sh
#
# Environment:
#   NATIVE=1          build on this (Linux) host instead of in the container
#   DEBIAN_DISK_SIZE  size of the disk as the guest sees it (default 4G; the
#                     file is sparse, so it only takes the space in use)
#   DEBIAN_MIRROR     Debian mirror (default http://deb.debian.org/debian)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEBIAN_DIR=$ROOT/linux/debian
OUT_DIR=$ROOT/images/debian
SUITE=trixie
MIRROR=${DEBIAN_MIRROR:-http://deb.debian.org/debian}
SIZE=${DEBIAN_DISK_SIZE:-4G}

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

if [ -z "${RISC_EMULATOR_BUILD_CONTAINER:-}" ] && [ "${NATIVE:-}" != 1 ]; then
  FLAVOR=debian exec bash "$ROOT/linux/podman.sh" "$@"
fi
[ "$(uname -s)" = Linux ] || die "a native build (NATIVE=1) needs a Linux host; this is $(uname -s)"
for tool in mmdebstrap mke2fs; do
  command -v "$tool" >/dev/null || die "missing $tool (Debian/Ubuntu: apt install mmdebstrap e2fsprogs qemu-user-binfmt arch-test)"
done

if [ -n "${RISC_EMULATOR_BUILD_CONTAINER:-}" ]; then
  # Linux 6.7+ gives a container a binfmt_misc of its own when it mounts one;
  # registered there, QEMU runs riscv64 programs for this container only.
  # "F" opens the interpreter now, so it also works inside the target's chroot.
  step "Running riscv64 programs with qemu-user"
  if mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null; then
    printf '%s' ':qemu-riscv64:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xf3\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-riscv64:F' \
      >/proc/sys/fs/binfmt_misc/register
  # Older kernels: it works if the host runs riscv64 programs with QEMU, as
  # registered by its qemu-user-static package (scripts/setup-linux.sh
  # installs it there).
  elif ! arch-test riscv64 >/dev/null 2>&1; then
    die "can't run riscv64 programs: Linux before 6.7 can't give the container its own binfmt_misc.
  Set QEMU up on the host instead (Debian/Ubuntu: sudo apt install qemu-user-static)"
  fi
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The package list without comments, comma-separated.
packages=$(sed -e 's/#.*//' "$DEBIAN_DIR/packages" | tr -s ' \t\n' '\n' | grep . | paste -sd, -)

step "Installing Debian $SUITE (riscv64) with mmdebstrap"
# Customization, in the target (chroot) after the packages are installed:
#   - the overlay's files
#   - root logs in without a password
#   - networkd brings up eth0 (resolved is enabled by its package)
#   - no apt runs on timers: on an emulated CPU they'd take over the machine
#     for minutes at random times; run `apt update` when you need it
#   - an empty machine-id: systemd makes a new one on first boot
mmdebstrap \
  --arch=riscv64 \
  --variant=minbase \
  --include="$packages" \
  --customize-hook="cp -r --preserve=mode,timestamps '$DEBIAN_DIR/overlay/.' \"\$1/\"" \
  --customize-hook='chroot "$1" passwd --delete root' \
  --customize-hook='chroot "$1" systemctl enable systemd-networkd.service' \
  --customize-hook='chroot "$1" systemctl mask apt-daily.timer apt-daily-upgrade.timer' \
  --customize-hook='rm -f "$1/etc/machine-id" && touch "$1/etc/machine-id"' \
  "$SUITE" "$WORK/rootfs.tar" \
  "deb $MIRROR $SUITE main" \
  "deb $MIRROR $SUITE-updates main" \
  "deb http://security.debian.org/debian-security $SUITE-security main"

step "Creating the disk image ($SIZE, ext4)"
mke2fs -q -t ext4 -L debian -d "$WORK/rootfs.tar" "$WORK/rootfs.ext4" "$SIZE"
e2fsck -fn "$WORK/rootfs.ext4" >/dev/null || die "the new file system has errors (e2fsck -fn)"

mkdir -p "$OUT_DIR"
cp --sparse=always "$WORK/rootfs.ext4" "$OUT_DIR/rootfs.ext4"
# (Checked again where it landed: the project directory may be a shared folder,
# e.g. in Podman's VM on macOS.)
e2fsck -fn "$OUT_DIR/rootfs.ext4" >/dev/null || die "images/debian/rootfs.ext4 has errors after copying it there (e2fsck -fn)"
# What this image was built from; `npm start` rebuilds when it changes.
bash "$ROOT/linux/inputs-hash.sh" debian >"$OUT_DIR/.inputs-hash"
step "Debian disk image ready: images/debian/rootfs.ext4 ($(du -h "$OUT_DIR/rootfs.ext4" | cut -f1) used of $SIZE)"
