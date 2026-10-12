#!/usr/bin/env bash
#
# Prepares Alpine Linux for the emulator, from what Alpine publishes:
#
#   - the minimal root file system for riscv64: a set-up base system
#     (BusyBox, apk)
#   - the packages in linux/alpine/packages, from Alpine's repositories,
#     installed onto it with this container's apk. Without their install
#     scripts: those are riscv64 programs, which the container can't run.
#     For a new system only mkinitfs's matter: it makes the initramfs, which
#     is done here instead (and the kernel package comes with its modules'
#     index, which kmod's would make).
#   - OpenSBI, from Alpine's opensbi package
#
# Booting goes OpenSBI → Linux (Alpine's linux-lts) with a small initramfs
# made here (BusyBox and the modules it takes to mount the disk) → OpenRC.
# No bootloader: the emulator loads the kernel and the initramfs itself.
#
# → images/alpine/: pristine.raw (the disk: an ext4 file system, the whole of
#   it the root file system), Image (the kernel), initramfs, fw_dynamic.bin
#   (OpenSBI), boot.json (how to boot them, and RAM in MiB: for the web
#   page), VERSIONS
#
# Runs in a Podman container (linux/podman.sh, linux/alpine/Containerfile);
# set NATIVE=1 to run directly on an Alpine host (with bash, curl, cpio,
# e2fsprogs).
#
# Environment:
#   ALPINE_BRANCH     Alpine's release branch (default v3.24)
#   ALPINE_MIRROR     where it comes from (default dl-cdn.alpinelinux.org)
#   ALPINE_DISK_SIZE  size of the disk (default 1G; the file is sparse)
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ALPINE_DIR=$ROOT/linux/alpine
OUT_DIR=$ROOT/images/alpine
BRANCH=${ALPINE_BRANCH:-v3.24}
MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}
SIZE=${ALPINE_DISK_SIZE:-1G}
# The kernel command line: the console, the root file system (the initramfs
# mounts it). quiet: every line on the console takes the guest time to print.
BOOTARGS='console=ttyS0 root=/dev/vda quiet'
# Modules the initramfs loads to mount the root file system (and what they
# need, from modules.dep).
INITRAMFS_MODULES=(virtio_mmio virtio_blk ext4)
# OpenRC's services in each runlevel, as setup-alpine sets them up (less what
# the machine doesn't have: no keyboard, no hardware clock to sync with).
# (A plain list: macOS's bash 3 runs this far, before the container does
# the rest.)
RUNLEVELS=(
  'sysinit: devfs dmesg mdev hwdrivers'
  'boot: modules sysctl hostname bootmisc syslog seedrng networking'
  'default: local'
  'shutdown: mount-ro killprocs savecache'
)

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

if [ -z "${RISC_EMULATOR_BUILD_CONTAINER:-}" ] && [ "${NATIVE:-}" != 1 ]; then
  exec bash "$ROOT/linux/podman.sh" alpine "$@"
fi
for tool in curl apk cpio gzip mkfs.ext4 e2fsck sha256sum; do
  command -v "$tool" >/dev/null || die "missing $tool"
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
APK=(apk --arch riscv64 --keys-dir /usr/share/apk/keys/riscv64 --no-cache --no-scripts
  --repositories-file /dev/null --repository "$MIRROR/$BRANCH/main" --repository "$MIRROR/$BRANCH/community")

step "Downloading Alpine's minimal root file system ($BRANCH, riscv64)"
RELEASES=$MIRROR/$BRANCH/releases/riscv64
minirootfs=$(curl -fsSL "$RELEASES/latest-releases.yaml" | sed -n 's/^ *file: \(alpine-minirootfs-.*-riscv64\.tar\.gz\)$/\1/p' | head -1)
[ -n "$minirootfs" ] || die "no minimal root file system in $RELEASES/latest-releases.yaml"
curl -fsSLO "$RELEASES/$minirootfs"
curl -fsSL "$RELEASES/$minirootfs.sha256" | sha256sum -c - >/dev/null || die "$minirootfs: checksum mismatch"
mkdir root
tar -xzpf "$minirootfs" -C root
echo "    $minirootfs"

step "Installing the packages (linux/alpine/packages)"
mapfile -t packages < <(sed 's/#.*//' "$ALPINE_DIR/packages" | tr -s ' \t' '\n' | grep .)
"${APK[@]}" --root root add "${packages[@]}" >apk.log 2>&1 || { cat apk.log; die "apk add failed"; }
# OpenSBI: only its firmware, from a root of its own.
"${APK[@]}" --root opensbi --initdb add opensbi >>apk.log 2>&1 || { cat apk.log; die "apk add opensbi failed"; }
cp opensbi/usr/share/opensbi/generic/firmware/fw_dynamic.bin .
kernel_version=$(ls root/lib/modules)
echo "    ${#packages[@]} packages, $(apk --root root info 2>/dev/null | wc -l) with what they need; kernel $kernel_version"

step "Setting the system up"
# What mkinitfs's install script does (so mkinitfs works in the guest too).
grep -qw /sbin/nlplug-findfs root/etc/mkinitfs/features.d/base.files || echo /sbin/nlplug-findfs >>root/etc/mkinitfs/features.d/base.files
# root logs in without a password; the console (the serial port) logs in by itself.
sed -i 's/^root:[^:]*:/root::/' root/etc/shadow
sed -i 's/^tty[0-9]::/#&/' root/etc/inittab
echo 'ttyS0::respawn:/sbin/getty -n -l /usr/local/sbin/autologin 0 ttyS0 vt100' >>root/etc/inittab
for runlevel in "${RUNLEVELS[@]}"; do
  level=${runlevel%%:*}
  for service in ${runlevel#*:}; do
    [ -e "root/etc/init.d/$service" ] || die "no service $service"
    ln -sf "/etc/init.d/$service" "root/etc/runlevels/$level/$service"
  done
done
cp -a "$ALPINE_DIR/overlay/." root/
chown -R 0:0 root/etc root/usr/local

step "Making the initramfs"
modules=root/lib/modules/$kernel_version
# The modules, each after those it needs (modules.dep: "path: dependencies").
ordered=()
add_module() {
  local path=$1 dep
  for done in "${ordered[@]}"; do [ "$done" = "$path" ] && return; done
  for dep in $(sed -n "s|^$path: *||p" "$modules/modules.dep"); do add_module "$dep"; done
  ordered+=("$path")
}
for name in "${INITRAMFS_MODULES[@]}"; do
  path=$(grep -o "^[^:]*/$name\.ko[^:]*" "$modules/modules.dep") || die "no module $name"
  add_module "$path"
done
mkdir -p initramfs/{bin,dev,proc,sys,newroot,lib/modules}
cp root/bin/busybox.static initramfs/bin/busybox
for path in "${ordered[@]}"; do
  name=$(basename "$path")
  case "$name" in
    *.gz) gzip -dc "$modules/$path" >"initramfs/lib/modules/${name%.gz}" ;;
    *) cp "$modules/$path" initramfs/lib/modules/ ;;
  esac
  basename "${name%.gz}" .ko >>initramfs/modules
done
cp "$ALPINE_DIR/init" initramfs/init
chmod 755 initramfs/init
(cd initramfs && find . | LC_ALL=C sort | cpio -o -H newc -R 0:0 --quiet | gzip -9) >initramfs.gz
# In /boot too, where mkinitfs would have put Alpine's.
cp initramfs.gz root/boot/initramfs-lts
echo "    $(wc -l <initramfs/modules) modules ($(tr '\n' ' ' <initramfs/modules)); $(($(stat -c %s initramfs.gz) / 1024)) KB"

step "Unpacking the kernel"
# (OpenSBI starts it where it is: it can't be compressed.)
gzip -dc root/boot/vmlinuz-lts >Image
echo "    $(($(stat -c %s Image) / 1024 / 1024)) MB"

step "Making the disk ($SIZE, ext4)"
truncate -s "$SIZE" disk.raw
mkfs.ext4 -q -L alpine -d root disk.raw
e2fsck -fn disk.raw >/dev/null 2>&1 || die "the new file system has errors (e2fsck -fn)"

cat >VERSIONS <<EOF
Alpine $(cat root/etc/alpine-release) ($minirootfs)
kernel $kernel_version (linux-lts)
opensbi $(apk --root opensbi info -v 2>/dev/null | sed -n 's/^opensbi-//p')
packages: ${packages[*]}
EOF
cat >boot.json <<EOF
{
  "firmware": "fw_dynamic.bin",
  "kernel": "Image",
  "initrd": "initramfs",
  "disk": "pristine.raw",
  "bootargs": "$BOOTARGS",
  "memory": 512
}
EOF

mkdir -p "$OUT_DIR"
cp --sparse=always disk.raw "$OUT_DIR/pristine.raw"
cp initramfs.gz "$OUT_DIR/initramfs"
cp Image fw_dynamic.bin boot.json VERSIONS "$OUT_DIR/"
e2fsck -fn "$OUT_DIR/pristine.raw" >/dev/null 2>&1 || die "images/alpine/pristine.raw has errors after copying it there"
# What this was built from (linux/inputs-hash.sh).
bash "$ROOT/linux/inputs-hash.sh" alpine >"$OUT_DIR/.inputs-hash"
step "Alpine ready in images/alpine ($(du -h "$OUT_DIR/pristine.raw" | cut -f1) used of $SIZE):"
sed 's/^/    /' "$OUT_DIR/VERSIONS"
