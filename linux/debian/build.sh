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
# system grows into it on the first boot. (Not here: resize2fs, on a
# partition inside an image file, sets the file's size to the file system's.)
#
# → images/debian/pristine.raw (the disk as built: npm start gives you a copy
#   to use, disk.raw; tests and benchmarks boot this one, unchanged),
#   fw_dynamic.bin (OpenSBI), u-boot.bin, VERSIONS
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
  modprobe@drm.service        # loads the graphics stack (there's no display): 6 s
  # Boot-time chores for things this machine doesn't have or need, each a few
  # seconds of CPU taken from the rest of the boot:
  grub-common.service         # records a successful boot for GRUB's failed-boot menu
  e2scrub_reap.service        # cleans up after ext4 checks of LVM snapshots
  systemd-binfmt.service      # registers handlers for foreign executable formats
  systemd-timesyncd.service   # sets the clock by NTP: the emulator's clock is the host's
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

# debugfs commands that replace file $1 in the root file system with itself
# edited by sed script $2 (keeping its owner and mode).
edit() {
  local file=$1 copy
  copy=edited-$(basename "$1")
  debugfs -R "dump $file $copy" "$ROOTFS" 2>/dev/null
  sed -i "$2" "$copy"
  local stat
  stat=$(debugfs -R "stat $file" "$ROOTFS" 2>/dev/null)
  echo "rm $file"
  echo "write $copy $file"
  echo "set_inode_field $file mode 0100$(sed -n 's/.*Mode: *0*\([0-7]*\).*/\1/p' <<<"$stat" | head -1)"
  echo "set_inode_field $file uid $(sed -n 's/^User: *\([0-9]*\).*/\1/p' <<<"$stat" | head -1)"
  echo "set_inode_field $file gid $(sed -n 's/.*Group: *\([0-9]*\).*/\1/p' <<<"$stat" | head -1)"
}

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
  edit /etc/shadow 's/^root:[^:]*:/root::/'
  # GRUB boots right away (overlay/etc/default/grub.d keeps it that way when
  # Debian regenerates grub.cfg).
  edit /boot/grub/grub.cfg 's/^\( *set timeout=\)[0-9]*$/\10/'
  # The EFI system partition is only needed when GRUB is updated: mounted on
  # first use, not checked and mounted at every boot (5 s).
  edit /etc/fstab '\|[[:space:]]/boot/efi[[:space:]]| { s|\(vfat[[:space:]]*\)\([^[:space:]]*\)|\1\2,noauto,x-systemd.automount|; s|[0-9][[:space:]]*$|0| }'
} >commands
debugfs -w -f commands "$ROOTFS" >/dev/null 2>debugfs.log
e2fsck -fn "$ROOTFS" >/dev/null || { cat debugfs.log; die "the adapted file system has errors (e2fsck -fn)"; }

step "Trimming the initrd to the modules this machine needs"
# The image's initrd has nearly every storage and file system driver Debian
# has (MODULES=most); unpacking and scanning them takes seconds at every boot
# on an emulated CPU. Kept: what mounting the root file system takes (the
# virtio disk on virtio-mmio, ext4) and what those depend on. (overlay/
# sets MODULES=dep, so initrds Debian makes itself later are small too.)
initrd=$(debugfs -R "ls /boot" "$ROOTFS" 2>/dev/null | grep -o 'initrd\.img-[^ ]*' | head -1)
kver=${initrd#initrd.img-}
debugfs -R "dump /boot/$initrd initrd" "$ROOTFS" 2>/dev/null
# Two cpio archives back to back: the modules (uncompressed, as each module
# is compressed already), then everything else (zstd).
split=$(python3 -c 'd = open("initrd", "rb").read()
end = d.index(b"TRAILER!!!") + 10
while d[end] == 0: end += 1
print(end)')
head -c "$split" initrd >modules.cpio
tail -c +$((split + 1)) initrd >main.cpio.zst
mkdir modules main
(cd modules && cpio -id --quiet <../modules.cpio)
(cd main && zstd -dcq ../main.cpio.zst | cpio -id --quiet)
moddir=usr/lib/modules/$kver
ln -s usr/lib modules/lib # (depmod and modprobe look in lib/modules)
cp main/$moddir/modules.* modules/$moddir/
needed=$(modprobe -d modules -S "$kver" --show-depends -a virtio_mmio virtio_blk ext4 crc32c |
  awk '$1 == "insmod" { n = split($2, p, "/"); print p[n] }' | sort -u)
before=$(find modules/$moddir -name '*.ko*' | wc -l)
find modules/$moddir -name '*.ko*' | while read -r module; do
  grep -qxF "$(basename "$module")" <<<"$needed" || rm "$module"
done
# Uncompressed: decompressing them is the kernel's work at every boot, on the
# emulated CPU (and the initrd is no bigger for it: see below).
find modules/$moddir -name '*.ko.xz' -exec xz -d {} +
depmod -b modules "$kver"
cp modules/$moddir/modules.* main/$moddir/
rm modules/lib modules/$moddir/modules.*
# udev's hardware database (USB and PCI device names and quirks, keyboard
# maps: half of the rest) is no use for this machine's devices.
rm main/usr/lib/udev/hwdb.bin
# All uncompressed: GRUB loading a few more MB costs much less than the
# kernel decompressing them on the emulated CPU.
{
  (cd modules && find usr | LC_ALL=C sort | cpio -o -H newc --quiet --reproducible -R 0:0)
  (cd main && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort | cpio -o -H newc --quiet --reproducible -R 0:0)
} >initrd.new
debugfs -w -f - "$ROOTFS" >/dev/null 2>>debugfs.log <<EOF
rm /boot/$initrd
write initrd.new /boot/$initrd
set_inode_field /boot/$initrd mode 0100644
set_inode_field /boot/$initrd uid 0
set_inode_field /boot/$initrd gid 0
EOF
e2fsck -fn "$ROOTFS" >/dev/null || { cat debugfs.log; die "the file system has errors after replacing the initrd (e2fsck -fn)"; }
echo "    $initrd: $before modules → $(wc -l <<<"$needed") ($(echo $needed)); $(($(stat -c %s initrd) / 1024 / 1024)) MB → $(($(stat -c %s initrd.new) / 1024 / 1024)) MB"

step "Growing the disk to $SIZE (the root file system follows on the first boot)"
truncate -s "$SIZE" disk.raw
# (The backup partition table moves to the new end; sfdisk explains that it
# isn't there yet, which is the point.)
sfdisk -q --relocate gpt-bak-std disk.raw 2>/dev/null
echo ', +' | sfdisk -q --no-reread --no-tell-kernel -N 1 disk.raw

mkdir -p "$OUT_DIR"
cp --sparse=always disk.raw "$OUT_DIR/pristine.raw"
cp fw_dynamic.bin u-boot.bin VERSIONS "$OUT_DIR/"
# (Checked again where it landed: the project directory may be a shared folder,
# e.g. in Podman's VM on macOS.)
e2fsck -fn "$OUT_DIR/pristine.raw?offset=$offset" >/dev/null || die "images/debian/pristine.raw has errors after copying it there"
# What this was built from; `npm start` rebuilds when it changes.
bash "$ROOT/linux/inputs-hash.sh" >"$OUT_DIR/.inputs-hash"
step "Debian ready in images/debian ($(du -h "$OUT_DIR/pristine.raw" | cut -f1) used of $SIZE):"
sed 's/^/    /' "$OUT_DIR/VERSIONS"
