#!/usr/bin/env bash
#
# Prepares Debian for the emulator from what Debian itself publishes:
#
#   - the "nocloud" cloud image for riscv64 (cloud.debian.org): a disk with
#     an EFI system partition (GRUB) and the root file system, with Debian's
#     kernel and initrd in /boot
#   - the firmware, from Debian's packages: OpenSBI (opensbi), which runs in
#     M-mode, and U-Boot (u-boot-qemu), which runs in S-mode, provides UEFI
#     and starts GRUB from the disk
#
# Booting goes OpenSBI → U-Boot → GRUB → Linux → systemd, as on a RISC-V
# board; kernel updates from apt take effect like on any Debian machine.
#
# The disk gets a few changes for the emulator (see "Adapting" below and
# linux/debian/overlay/), and is grown to DEBIAN_DISK_SIZE; the root file
# system grows into it on the first boot.
#
# → images/debian/disk.raw, fw_dynamic.bin (OpenSBI), u-boot.bin, VERSIONS
#
# Runs in a Podman container (linux/podman.sh, linux/debian/Containerfile);
# set NATIVE=1 to run directly on a Linux host with curl, xz, e2fsprogs,
# sfdisk, python3 and apt (Debian/Ubuntu).
#
# Environment:
#   DEBIAN_DISK_SIZE   size of the disk as the guest sees it (default 8G; the
#                      file is sparse, so it only takes the space in use)
#   DEBIAN_CLOUD_URL   where the image comes from (default: the latest trixie
#                      build on cloud.debian.org)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEBIAN_DIR=$ROOT/linux/debian
OUT_DIR=$ROOT/images/debian
IMAGE=debian-13-nocloud-riscv64
URL=${DEBIAN_CLOUD_URL:-https://cloud.debian.org/images/cloud/trixie/latest}
SIZE=${DEBIAN_DISK_SIZE:-8G}

# Units switched off (masked). On an emulated CPU each costs a lot of time,
# at boot or at random times later, for nothing this machine needs:
MASKED=(
  systemd-firstboot.service   # asks for locale, timezone, password on the console
  apparmor.service            # compiles security profiles: half a minute every boot
  apt-daily.timer             # apt runs in the background for minutes...
  apt-daily-upgrade.timer
  unattended-upgrades.service # ...and installs upgrades by itself
)

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

if [ -z "${RISC_EMULATOR_BUILD_CONTAINER:-}" ] && [ "${NATIVE:-}" != 1 ]; then
  exec bash "$ROOT/linux/podman.sh" "$@"
fi
for tool in curl xz debugfs e2fsck sfdisk python3 apt-get dpkg-deb sha512sum; do
  command -v "$tool" >/dev/null || die "missing $tool"
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

step "Downloading $IMAGE"
curl -fL --retry 3 --progress-bar -o "$IMAGE.tar.xz" "$URL/$IMAGE.tar.xz"
curl -fsSL --retry 3 -o SHA512SUMS "$URL/SHA512SUMS"
grep " $IMAGE.tar.xz\$" SHA512SUMS | sha512sum -c - || die "$IMAGE.tar.xz doesn't match Debian's checksum"
tar -xSf "$IMAGE.tar.xz" # disk.raw (sparse)
rm "$IMAGE.tar.xz"

step "Firmware: OpenSBI and U-Boot from Debian's packages"
apt-get update -qq
apt-get download -q -o APT::Sandbox::User=root opensbi u-boot-qemu
for deb in *.deb; do dpkg-deb -x "$deb" packages; done
cp packages/usr/lib/riscv64-linux-gnu/opensbi/generic/fw_dynamic.bin fw_dynamic.bin
cp packages/usr/lib/u-boot/qemu-riscv64_smode/u-boot.bin u-boot.bin
{
  echo "$IMAGE from $URL (SHA-512 $(grep " $IMAGE.tar.xz\$" SHA512SUMS | cut -c1-16)...)"
  for deb in *.deb; do dpkg-deb --show "$deb"; done
} >VERSIONS

# The root file system: partition 1 (after the EFI system partition, 15).
offset=$(sfdisk --json disk.raw | python3 -c 'import json, sys
table = json.load(sys.stdin)["partitiontable"]
print(next(p["start"] for p in table["partitions"] if p["node"].endswith("disk.raw1")) * table.get("sectorsize", 512))')
ROOTFS="disk.raw?offset=$offset"

step "Adapting the disk for the emulator"
# debugfs edits the file system inside the disk image in place. (mkdir and rm
# complain about what exists or doesn't; that's fine.)
{
  for unit in "${MASKED[@]}"; do
    echo "symlink /etc/systemd/system/$unit /dev/null"
  done
  # The overlay's files, replacing any already there: root's, mode 644.
  (cd "$DEBIAN_DIR/overlay" && find . -type d ! -name . | sort) | while read -r dir; do
    echo "mkdir ${dir#.}"
  done
  (cd "$DEBIAN_DIR/overlay" && find . -type f ! -name .DS_Store | sort) | while read -r path; do
    file=${path#.}
    echo "rm $file"
    echo "write $DEBIAN_DIR/overlay$file $file"
    echo "set_inode_field $file mode 0100644"
    echo "set_inode_field $file uid 0"
    echo "set_inode_field $file gid 0"
  done
  # root logs in without a password.
  debugfs -R "dump /etc/shadow shadow" "$ROOTFS" 2>/dev/null
  sed -i 's/^root:[^:]*:/root::/' shadow
  echo "rm /etc/shadow"
  echo "write shadow /etc/shadow"
  echo "set_inode_field /etc/shadow mode 0100640"
  echo "set_inode_field /etc/shadow uid 0"
  echo "set_inode_field /etc/shadow gid $(debugfs -R "stat /etc/shadow" "$ROOTFS" 2>/dev/null | sed -n 's/.*Group: *\([0-9]*\).*/\1/p')"
  # GRUB boots right away (overlay/etc/default/grub.d keeps it that way when
  # Debian regenerates grub.cfg).
  debugfs -R "dump /boot/grub/grub.cfg grub.cfg" "$ROOTFS" 2>/dev/null
  sed -i 's/^\( *set timeout=\)[0-9]*$/\10/' grub.cfg
  echo "rm /boot/grub/grub.cfg"
  echo "write grub.cfg /boot/grub/grub.cfg"
  echo "set_inode_field /boot/grub/grub.cfg mode 0100444"
} >commands
debugfs -w -f commands "$ROOTFS" >/dev/null 2>debugfs.log
e2fsck -fn "$ROOTFS" >/dev/null || { cat debugfs.log; die "the adapted file system has errors (e2fsck -fn)"; }

step "Growing the disk to $SIZE (the root file system follows on the first boot)"
truncate -s "$SIZE" disk.raw
# (The backup partition table moves to the new end; sfdisk explains that it
# isn't there yet, which is the point.)
sfdisk -q --relocate gpt-bak-std disk.raw 2>/dev/null
echo ', +' | sfdisk -q --no-reread --no-tell-kernel -N 1 disk.raw

mkdir -p "$OUT_DIR"
cp --sparse=always disk.raw "$OUT_DIR/disk.raw"
cp fw_dynamic.bin u-boot.bin VERSIONS "$OUT_DIR/"
# (Checked again where it landed: the project directory may be a shared folder,
# e.g. in Podman's VM on macOS.)
e2fsck -fn "$OUT_DIR/disk.raw?offset=$offset" >/dev/null || die "images/debian/disk.raw has errors after copying it there"
# What this was built from; `npm start` rebuilds when it changes.
bash "$ROOT/linux/inputs-hash.sh" >"$OUT_DIR/.inputs-hash"
step "Debian ready in images/debian ($(du -h "$OUT_DIR/disk.raw" | cut -f1) used of $SIZE):"
sed 's/^/    /' "$OUT_DIR/VERSIONS"
