# Debian in the emulator

## Getting started

On a fresh clone, one script installs everything the emulator and the image
builds need, then `npm start` builds and boots Debian:

```sh
scripts/setup-macos.sh    # macOS: Homebrew, Podman, Node.js, Rust
scripts/setup-linux.sh    # Linux: the same with apt, dnf, pacman or zypper (uses sudo)
npm start
```

The scripts install only what's missing, so running one again is harmless.
They finish by building the emulator once, as a check. On Linux, open a new
terminal before `npm start`: Node.js (fnm) and Rust (rustup) are installed
into your home directory and put on PATH by your shell's startup file.

The first `npm start` takes a while: it builds the Linux kernel and firmware
with Buildroot, which compiles a cross toolchain first, and then the Debian
disk. Later runs boot right away.

`npm test` additionally needs a RISC-V bare-metal GCC for the test programs,
installed as `riscv64-elf-gcc` (macOS: `brew install riscv64-elf-gcc`; Linux
distributions name theirs differently, e.g. `riscv64-unknown-elf-gcc`), and
the test suites' submodule (`git submodule update --init`).

## What `npm start` does

1. Compiles the emulator if needed, including its CPU core (see
   [hart/README.md](../hart/README.md)).
2. Builds what's missing or out of date (anything in its directory under
   `linux/` changed):
   - the kernel and firmware, `images/kernel/Image` and `fw_dynamic.bin`
     (`linux/kernel/`, `npm run kernel:build`)
   - the Debian disk, `images/debian/rootfs.ext4` (`linux/debian/`,
     `npm run debian:build`)
3. Boots it: OpenSBI (the firmware) at the start of RAM, Linux 6.18 4 MiB
   later in S-mode, Debian 13 (trixie) on a virtio disk, the network card on
   the emulator's NAT, 512 MiB of RAM. The CPU is RV64GC with Sv39 virtual
   memory, what Debian's riscv64 port requires.

Debian reaches the login prompt in about 35 s. Log in as `root`, no
password. `poweroff` shuts it down, and `npm start` exits with it; Ctrl-A
then X quits the emulator at any time.

Options after `--` go to the emulator: `npm start -- --snapshot` (see
[The disk](#the-disk)), `npm start -- --memory 1024`.

## The Debian disk

It's Debian's own riscv64 system, unmodified: Debian's packages, systemd as
init, systemd-networkd and systemd-resolved for the network, and apt.
`linux/debian/build.sh` builds it (about a minute and a half):

1. [mmdebstrap](https://gitlab.mister-muffin.de/josch/mmdebstrap) downloads
   Debian's minimal base system plus the packages in
   `linux/debian/packages` from `deb.debian.org` and installs them. The
   packages' install scripts are riscv64 programs: they run under QEMU's
   user-mode emulator, through a `binfmt_misc` mounted inside the build
   container only (Linux 6.7+), so nothing changes on your machine or in
   Podman's VM. On older Linux kernels, `scripts/setup-linux.sh` sets QEMU
   up on the host instead, and the build uses that.
2. The files in `linux/debian/overlay/` are copied in: hostname, `fstab`,
   the network configuration and apt settings. root's password is removed,
   and apt's daily timers are switched off: on an emulated CPU they would
   take over the machine for minutes at random times.
3. `mke2fs` writes it all into a 4 GB ext4 disk image (`DEBIAN_DISK_SIZE` to
   change it), and `e2fsck` checks the result. The file is sparse: about
   200 MB on your disk.

Debian's packages are fetched fresh on every build, so a later build gets
Debian's latest updates.

To have more packages on every new disk, add them to `linux/debian/packages`;
for files, put them under `linux/debian/overlay/`. The next `npm start`
rebuilds the disk.

## The disk

`images/debian/rootfs.ext4` is a raw disk image holding an ext4 file system.
The emulator attaches it as a virtio block device, and Linux mounts it as its
root file system (`root=/dev/vda`).

- **Writes go to the file.** Whatever you change in the guest is still there
  next boot, like a real disk.
- **`npm start -- --snapshot`** keeps the guest's writes in memory and
  throws them away on exit; the file isn't touched.
- **A rebuild replaces `rootfs.ext4`**, so anything changed in the guest is
  lost. When `npm start` rebuilds, it first keeps the old disk as
  `rootfs.ext4.bak`.
- **On a Linux host** you can loop-mount the image to look inside while the
  emulator is off: `sudo mount -o loop images/debian/rootfs.ext4 /mnt`.

Inside, it's ordinary Debian: `apt update` and `apt install <package>` fetch
packages from Debian's mirrors through the emulator's network. Expect it to
be slow, since apt works through Debian's whole package list on the emulated
CPU: `apt update` takes about 2 minutes, installing a small package such as
`htop` about half a minute. (Package description translations are switched
off, in `overlay/etc/apt/apt.conf.d/`, which saves a third of that.)

## The network

`npm start` plugs a virtio network card (`eth0`) into a user-mode NAT
built into the emulator (`src/net/user-network.ts`), like QEMU's default
networking. No admin rights or extra programs are involved.

| Address     | What it is |
| ----------- | ---------- |
| `10.0.2.15` | the guest, configured by DHCP at boot (systemd-networkd) |
| `10.0.2.2`  | the router, which is also **your machine's `localhost`**: `curl http://10.0.2.2:8080/` reaches a server listening on port 8080 on the host |
| `10.0.2.3`  | DNS, relayed to the host's resolver (systemd-resolved asks it) |

The guest can make outgoing TCP connections and send UDP (including DNS) to
anywhere the host can reach. What doesn't work:
- **No incoming connections.** Nothing outside can connect in yet: there's no
  port forwarding.
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

## The kernel and firmware

`linux/kernel/build.sh` builds them from source with
[Buildroot](https://buildroot.org) 2026.02 LTS: a cross toolchain, Linux 6.18
and OpenSBI 1.6, configured for exactly the emulated CPU:

- `linux/kernel/buildroot.fragment`: Buildroot settings on top of its
  `qemu_riscv64_virt_defconfig` (the CPU, the toolchain, OpenSBI; no root
  filesystem, Debian's disk is separate)
- `linux/kernel/linux.fragment`: kernel options on top of the kernel's
  `defconfig`. Everything is built in (no modules, no initramfs), with what
  this machine doesn't have switched off and a few boot-time hogs removed.

Changing the CPU or toolchain settings makes the next build start over from
scratch (the build notices); changing kernel options reconfigures and
recompiles the kernel. For Buildroot's menus, e.g. `linux/kernel/build.sh
linux-menuconfig` (copy the result back into the fragment, or it's lost);
`linux/kernel/build.sh <target>` runs any Buildroot make target, e.g.
`clean`.

## Where the builds run

Both builds run in **Podman** containers (`linux/kernel/Containerfile`, a
pinned Debian 12, and `linux/debian/Containerfile`, Debian 13), so they
don't depend on your distribution or compiler (`linux/podman.sh` runs them):

- **Linux:** Podman runs rootless, with no daemon.
- **macOS:** Podman runs containers in its own small Linux VM, which
  `linux/podman.sh` creates and starts on first use. The project must live
  under your home directory, because that's what Podman shares with the VM.

Your project directory is mounted into the container: the configuration goes
in, and the images come out. Buildroot itself works in a Podman volume,
`risc-emulator-kernel`, which keeps downloads and build state between runs
(about 13 GB); `podman volume rm risc-emulator-kernel` starts it over from
scratch. The first build compiles the cross toolchain, the kernel and the
firmware, which takes a while; later builds are incremental.

To skip the container on a Linux host, run the scripts with `NATIVE=1`. The
kernel build needs Buildroot's host packages; the Debian build needs
mmdebstrap, e2fsprogs and QEMU's user-mode emulator registered for riscv64
(Debian/Ubuntu: `apt install mmdebstrap e2fsprogs qemu-user-binfmt
arch-test`), and runs as root or with mmdebstrap's unshare mode set up.
Native kernel builds work in `.buildroot/kernel/`; set `BUILD_DIR` to build
elsewhere.

## Running other things: `npm run emulator`

`npm run emulator -- <options> <image>` is the emulator itself, with nothing
preset. It boots exactly what you pass:

| Option | |
| ------ | - |
| `<image>` | loaded at the start of RAM and entered in M-mode (a kernel, firmware or bare-metal program) |
| `--kernel <file>` | with firmware as `<image>`: the kernel, loaded 4 MiB into RAM and entered in S-mode by OpenSBI |
| `--disk <file>` | a raw disk image as `/dev/vda`; add `--snapshot` to discard writes |
| `--net` | the network card on the user-mode NAT |
| `--memory <MiB>` | RAM size (default 64) |
| `--bootargs <string>` | the kernel command line |

For example, `npm run emulator -- examples/build/hello.bin` runs a
bare-metal example program (`npm run build:examples` builds them).
