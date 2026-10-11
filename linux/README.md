# Building the Linux images from source

**`npm start`** is all you normally need: it compiles the emulator if needed
(including its CPU core, see [hart/README.md](../hart/README.md)),
builds the mmu image if it's missing or anything under `linux/` changed, and
boots it. The rest of this page explains what goes into the images.

There are three flavors:

| Flavor  | What it is | Build | Boot |
| ------- | ---------- | ----- | ---- |
| **mmu** | Regular RV32 Linux 6.18 with virtual memory (Sv32), running in S-mode on top of the OpenSBI firmware. Upstream [Buildroot](https://buildroot.org) 2026.02 LTS, glibc and BusyBox, plus extra packages, currently Midnight Commander (`mc`) and `curl` (with HTTPS). The root filesystem is on a virtual disk. | `npm run linux:build` → `images/linux-mmu/fw_dynamic.bin`, `Image`, `rootfs.ext4` | `npm start` |
| **rv64** | The same for RV64 (Sv39 virtual memory): the mmu flavor's configuration plus `linux/rv64/`. | `npm run linux:rv64:build` → `images/linux-rv64/` (the same files) | `npm run start:rv64` |
| **nommu** | [mini-rv32ima](https://github.com/cnlohr/mini-rv32ima)'s tiny no-MMU kernel running in M-mode, with BusyBox and uClibc. The root filesystem is built into the kernel (an initramfs). A prebuilt image can also be downloaded. | `npm run linux:nommu:build` → `images/linux/Image` | `npm run start:nommu` |

All are built by `linux/build.sh`; `FLAVOR=mmu` (default), `FLAVOR=rv64` or
`FLAVOR=nommu` selects one. Like mmu, `npm run start:rv64` builds its image
first if it's missing or out of date.

The build runs in a **Podman** container (`linux/Containerfile`, a pinned
Debian 12), so it doesn't depend on your distribution or compiler:

- **Linux:** install Podman (`apt install podman` / `dnf install podman`).
  It runs rootless, with no daemon.
- **macOS:** `brew install podman`. Podman runs containers in its own small
  Linux VM, which `linux/podman.sh` creates and starts on first use. The
  project must live under your home directory, because that's what Podman
  shares with the VM.

Your project directory is mounted into the container: programs, overlay and
configs go in, and the images come out. Buildroot itself works in a Podman
volume per flavor, `risc-emulator-buildroot-mmu`, `-rv64` and
`risc-emulator-buildroot` (nommu), which keep downloads and build state
between runs. `podman volume rm
<name>` starts that flavor over from scratch.

To skip the container on a Linux host, run `NATIVE=1 linux/build.sh`. You'll
need Buildroot's host packages. For the nommu flavor you also need a GCC older
than 15: GCC 15 defaults to C23, which the old Buildroot snapshot nommu uses
(2023.11) doesn't compile under.

The first build compiles a cross toolchain, the kernel and all packages. It
needs a few GB of disk and takes a while. Later builds are incremental.

## The disk (mmu flavor)

`images/linux-mmu/rootfs.ext4` is a raw disk image holding an ext4 file
system. The emulator attaches it as a virtio block device, and Linux mounts it
as its root file system (`root=/dev/vda`). The file is sparse: it's 256 MB for
the guest but only takes the space actually used.

- **Writes go to the file.** Whatever you change in the guest is still there
  next boot, like a real disk.
- **`npm start -- --snapshot`** keeps the guest's writes in memory and
  throws them away on exit; the file isn't touched.
- **A rebuild replaces `rootfs.ext4`**, so anything changed in the guest is
  lost. When `npm start` rebuilds, it first keeps the old disk as
  `rootfs.ext4.bak`. Put what should survive in `linux/overlay` or
  `linux/programs`.
- **On a Linux host** you can loop-mount the image to look inside while the
  emulator is off: `sudo mount -o loop images/linux-mmu/rootfs.ext4 /mnt`.
- **Any raw disk image works:** `npm run linux -- --disk <file> …` attaches
  it (see below).

## The network (mmu flavor)

`npm start` plugs a virtio network card (`eth0`) into a user-mode NAT
built into the emulator (`src/net/user-network.ts`), like QEMU's default
networking. No admin rights or extra programs are involved.

| Address     | What it is |
| ----------- | ---------- |
| `10.0.2.15` | the guest, configured by DHCP at boot |
| `10.0.2.2`  | the router, which is also **your machine's `localhost`**: `wget http://10.0.2.2:8080/` reaches a server listening on port 8080 on the host |
| `10.0.2.3`  | DNS, relayed to the host's resolver |

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

For HTTPS use `curl`; BusyBox's `wget` speaks plain HTTP only. HTTPS is slow
(around 10 s per request): the TLS handshake's cryptography runs on the
emulated CPU. The guest gets the date for certificate checks from the
emulator's real-time clock.

The image waits up to 15 s at boot for `eth0`, so always boot it with
the card attached (`--net`; `npm start` does).

## Console session

The console runs a single login session (log in as `root`, no password).
When it ends with `exit`, Ctrl-D or too many failed logins, the machine
powers off, and `npm start` exits with it. This is set up in
`linux/overlay/etc/inittab` and `linux/overlay/sbin/console-session`. To get
the classic behaviour, where a new `login:` prompt appears after each logout,
change the console line in `inittab` back to
`console::respawn:/sbin/getty -L console 0 xterm-256color`.

## Running other images: `npm run linux`

`npm run linux -- <options> <image>` is the emulator itself, with nothing
preset. It boots exactly what you pass:

| Option | |
| ------ | - |
| `<image>` | loaded at the start of RAM and entered in M-mode (a kernel, firmware or bare-metal program) |
| `--xlen 64` | an RV64 CPU (default: `32`, RV32) |
| `--kernel <file>` | with firmware as `<image>`: the kernel, loaded 4 MiB into RAM and entered in S-mode by OpenSBI |
| `--disk <file>` | a raw disk image as `/dev/vda`; add `--snapshot` to discard writes |
| `--net` | the network card on the user-mode NAT |
| `--memory <MiB>` | RAM size (default 64) |
| `--bootargs <string>` | the kernel command line |

For example, `npm run linux -- examples/build/hello.bin` runs a bare-metal
example, and `npm run linux -- images/linux/Image` the nommu kernel.

## Adding things to the image

| Put it in…                    | …and it ends up as                                    |
| ----------------------------- | ----------------------------------------------------- |
| `linux/programs/<name>/*.c`   | `/usr/local/bin/<name>`, compiled for the target      |
| `linux/programs/<name>/Makefile` | whatever executables it builds into `$(O)`         |
| `linux/overlay/<path>`        | `/<path>`, copied verbatim (scripts, config files, …) |

Both go into both flavors. Then run the flavor's build again. Only your changes are rebuilt, and the
kernel is relinked with the new root filesystem.

A Makefile-based program gets `CC`, `CFLAGS`, `LDFLAGS` and `O` from the
build. For example:

```make
$(O)/myprog: main.c util.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
```

On the mmu and rv64 flavors programs are ordinary dynamically linked
executables. Anything Buildroot packages can also be added: put its
`BR2_PACKAGE_...=y` option in `linux/mmu/buildroot.fragment` (that's how `mc`
is added); rv64 gets it too. `linux/build.sh menuconfig`
shows what's available.

### Things to know about nommu Linux

- **No `fork()`.** Use `vfork()` + `exec*()` or `posix_spawn()` instead.
- **bFLT executables.** Programs are static and position independent, then
  converted from ELF to bFLT (that's what `-Wl,-elf2flt` in `LDFLAGS` does).
- **Fixed stack size** of 64 KiB (`STACK_SIZE` in `post-build.sh`).
- **No memory protection** between processes.

## Customizing the kernel, BusyBox, C library or Buildroot

**mmu:** the configuration is Buildroot's `configs/qemu_riscv32_virt_defconfig`
plus `linux/mmu/buildroot.fragment`. The fragment sets the CPU features the
emulator has (RV32IMAC: compressed instructions, no FPU), the root
filesystem, OpenSBI and the packages. Changing the CPU features or the
toolchain makes the next build start over from scratch (`linux/build.sh`
notices), since everything has to be recompiled for them. Kernel options go in
`linux/mmu/linux.fragment`, on top of the kernel's `rv32_defconfig`.

**rv64:** Buildroot's `configs/qemu_riscv64_virt_defconfig`, then everything
from `linux/mmu/` (packages included), then `linux/rv64/` with what differs:
the 64-bit CPU (RV64IMAC, LP64 ABI) and OpenSBI's build, and kernel options
the 64-bit `defconfig` has on top of `rv32_defconfig`. Later settings win.

**nommu:** the configs come from `vendor/mini-rv32ima/configs/`. To change one, copy it
into `linux/nommu/configs/` under the same name and edit it there. A file in
`linux/nommu/configs/` takes precedence.

For all of them, you can also use Buildroot's menus, e.g. `linux/build.sh
linux-menuconfig` or `linux/build.sh busybox-menuconfig` (with `FLAVOR=` as
needed). Copy the result back into the fragment or config file so the change
isn't lost.

`linux/build.sh <target>` runs any Buildroot make target. For example,
`linux/build.sh clean` wipes the build output but keeps the downloads.
Native builds (`NATIVE=1`) work in `.buildroot/<flavor>/`; set `BUILD_DIR` to
build elsewhere.
