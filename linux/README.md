# Debian in the emulator

## Getting started

On a fresh clone, one script installs everything the emulator needs, then
`npm start` sets up and boots Debian:

```sh
scripts/setup-macos.sh    # macOS: Homebrew, Podman, Node.js, Rust
scripts/setup-linux.sh    # Linux: the same with apt, dnf, pacman or zypper (uses sudo)
npm start
```

The scripts install only what's missing, so running one again is harmless.
They finish by building the emulator once, as a check. On Linux, open a new
terminal before `npm start`: Node.js (fnm) and Rust (rustup) are installed
into your home directory and put on PATH by your shell's startup file.

The first `npm start` downloads and prepares Debian (a few minutes); later
runs boot right away.

`npm test` additionally needs a RISC-V bare-metal GCC for the test programs,
installed as `riscv64-elf-gcc` (macOS: `brew install riscv64-elf-gcc`; Linux
distributions name theirs differently, e.g. `riscv64-unknown-elf-gcc`), and
the test suites' submodule (`git submodule update --init`).

## What runs

All of it is Debian's, booted the way a RISC-V board boots it:

1. **OpenSBI** (Debian's `opensbi` package), the M-mode firmware, at the
   start of RAM. It provides the SBI services Linux uses (timer, console,
   power-off) and starts the next stage in S-mode.
2. **U-Boot** (Debian's `u-boot-qemu`, the build for QEMU's virt machine),
   2 MiB into RAM. It finds the virtio disk and starts GRUB from its EFI
   system partition, providing UEFI to it.
3. **GRUB** loads Debian's kernel and initrd from `/boot`, as on any Debian
   machine.
4. **Linux** (Debian's 6.12 kernel; its drivers for this machine's devices
   are built in or come from the initrd), then **systemd**.

The disk is Debian 13 (trixie)'s "nocloud" cloud image for riscv64. The
machine has an RV64GC CPU with Sv39 virtual memory, what Debian's riscv64
port requires, and 1 GiB of RAM.

Debian reaches the login prompt in about 30 seconds. Log in as `root`, no
password. `poweroff` shuts it down, and `npm start` exits with it; Ctrl-A
then X quits the emulator at any time.

Options after `--` go to the emulator: `npm start -- --snapshot` (see
[The disk](#the-disk)), `npm start -- --memory 2048`.

Since the kernel boots from the disk, `apt upgrade` updates it as on any
Debian machine; the next boot uses the new one.

## How Debian is set up

`linux/debian/build.sh` (`npm run debian:build`; `npm start` runs it when
`images/debian/` is missing or anything in `linux/debian/` changed) does it
in a Podman container, in a few minutes:

1. Downloads the nocloud image from cloud.debian.org (the latest build of
   Debian 13; about 300 MB) and checks it against Debian's SHA-512
   checksums.
2. Takes OpenSBI's `fw_dynamic.bin` and U-Boot's `u-boot.bin` out of
   Debian's packages.
3. Adapts the disk for the emulator, editing the root file system inside
   the image (with `debugfs`, no mounting). On an emulated CPU everything
   a distribution does at boot takes long, so the boot is trimmed to what
   this machine needs:
   - root logs in without a password
   - switched off (masked): `systemd-firstboot` (asks for locale, timezone
     and password on the console), AppArmor (compiles its profiles at every
     boot, half a minute), apt's automatic updates (apt's timers and
     unattended-upgrades, which would run apt in the background for
     minutes), and boot-time chores for things the machine doesn't have or
     need: loading the graphics stack (`modprobe@drm`), GRUB's
     successful-boot record, LVM snapshot cleanup (`e2scrub_reap`),
     foreign executable formats (`systemd-binfmt`), NTP (`timesyncd`; the
     emulator's clock is the host's)
   - `/boot/efi` (the EFI system partition) is mounted when first used,
     not checked and mounted at every boot: only GRUB updates need it
   - the files in `linux/debian/overlay/`: the hostname, GRUB not waiting
     on its menu, no package description translations for apt (which saves
     a third of `apt update`'s time), the Wi-Fi stack blacklisted (there's
     no wireless hardware, but systemd-networkd's request for it loads it:
     over 10 s), and `MODULES=dep` for initrds Debian makes later (after a
     kernel upgrade)
   - the initrd trimmed to what mounting the root file system takes: from
     599 modules (nearly every storage and file system driver, 39 MB) to the
     7 for the virtio disk and ext4, stored uncompressed, without udev's
     hardware database: 24 MB that the kernel unpacks without decompressing
4. Grows the disk to 8 GB (`DEBIAN_DISK_SIZE`); the root file system grows
   into it on the first boot.

The results are in `images/debian/`: `pristine.raw` (the disk as built),
`fw_dynamic.bin`, `u-boot.bin`, and `VERSIONS`, which says which image and
packages they came from. The disk is sparse: about 1 GB on your disk.

## The disk

`images/debian/disk.raw` is the disk `npm start` boots, a raw disk image
(GPT: an EFI system partition and the root file system), attached as a virtio
block device, `/dev/vda`. It starts as a copy of `pristine.raw` (on macOS a
clone, which takes no extra space until it changes); `npm test` and `npm run
bench` boot `pristine.raw` itself, read-only, so what you do in Debian
doesn't change their results.

- **Writes go to the file.** Whatever you change in the guest is still there
  next boot, like a real disk.
- **`npm start -- --snapshot`** keeps the guest's writes in memory and
  throws them away on exit; the file isn't touched.
- **Setting Debian up again replaces `disk.raw`**, so anything changed in the
  guest is lost. When `npm start` does it, it first keeps the old disk as
  `disk.raw.bak`. To start over with a fresh disk, delete `disk.raw`: the
  next `npm start` copies `pristine.raw` again.

Inside, it's ordinary Debian: `apt update` and `apt install <package>` fetch
packages from Debian's mirrors through the emulator's network. It's slower
than on real hardware, since apt works through Debian's whole package list
on the emulated CPU: `apt update` takes about 25 s, installing a small
package such as `htop` a few seconds.

## The network

`npm start` plugs a virtio network card (`eth0`) into a user-mode NAT
built into the emulator (`src/net/user-network.ts`), like QEMU's default
networking. No admin rights or extra programs are involved.

| Address     | What it is |
| ----------- | ---------- |
| `10.0.2.15` | the guest, configured by DHCP at boot |
| `10.0.2.2`  | the router, which is also **your machine's `localhost`**: `curl http://10.0.2.2:8080/` reaches a server listening on port 8080 on the host |
| `10.0.2.3`  | DNS, relayed to the host's resolver |

The guest can make outgoing TCP connections and send UDP (including DNS) to
anywhere the host can reach. Connections in come through **forwarded
ports**: `npm start` forwards `localhost:2222` on your machine to Debian's
port 22, so ssh works once Debian runs an ssh server:

```sh
apt install openssh-server        # in Debian, once
ssh -p 2222 root@localhost        # on your machine
```

root logs in over ssh without a password, as on the console
(`overlay/etc/ssh/sshd_config.d/emulator.conf`). Only your machine can
connect: the forwarded port listens on `localhost`, not on your network. To
forward other ports, run the emulator yourself with `--forward
<host port>:<guest port>` (see below). If 2222 is taken (say, by a second
emulator), the emulator says so and runs without it.

What doesn't work:
- **Only what's forwarded comes in.** Other ports can't be reached from
  outside.
- **`ping` goes through the host's `ping` command.** The emulator can't
  send ICMP itself (that needs root), so each echo request runs one `ping`
  on the host. Replies are real, but the times include starting that
  process (a few ms), and the TTL shown is always 64.
- **No IPv6.** Names may resolve to IPv6 addresses, but connections go over
  IPv4.

HTTPS works (`curl`, apt with https sources), though each new connection
takes a moment: the TLS handshake's cryptography runs on the emulated CPU.
The guest gets the date for certificate checks from the emulator's real-time
clock.

## Where the setup runs

`linux/podman.sh` runs `linux/debian/build.sh` in a **Podman** container
(`linux/debian/Containerfile`, Debian 13), so it doesn't depend on your
system's tools:

- **Linux:** Podman runs rootless, with no daemon.
- **macOS:** Podman runs containers in its own small Linux VM, which
  `linux/podman.sh` creates and starts on first use. The project must live
  under your home directory, because that's what Podman shares with the VM.

To skip the container on a Debian or Ubuntu host, run `NATIVE=1
linux/debian/build.sh` (it needs curl, xz-utils, e2fsprogs, fdisk and
python3).

## Running other things: `npm run emulator`

`npm run emulator -- <options> <image>` is the emulator itself, with nothing
preset. It boots exactly what you pass:

| Option | |
| ------ | - |
| `<image>` | loaded at the start of RAM and entered in M-mode (firmware or a bare-metal program) |
| `--kernel <file>` | with firmware as `<image>`: the next stage (U-Boot, or a Linux kernel), loaded 2 MiB into RAM and entered in S-mode by OpenSBI |
| `--disk <file>` | a raw disk image as `/dev/vda`; add `--snapshot` to discard writes |
| `--net` | the network card on the user-mode NAT |
| `--forward <host port>:<guest port>` | with `--net`: connections to `localhost:<host port>` reach the guest's `<guest port>` (repeatable) |
| `--memory <MiB>` | RAM size (default 64) |
| `--bootargs <string>` | the kernel command line (for a kernel booted directly) |

For example, `npm run emulator -- examples/build/hello.bin` runs a
bare-metal example program (`npm run build:examples` builds them).
