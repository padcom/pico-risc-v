# Building the Linux images from source

There are two flavors, both RV32 with the root filesystem built into the
kernel (an initramfs):

| Flavor  | What it is | Build | Boot |
| ------- | ---------- | ----- | ---- |
| **mmu** | Regular Linux 6.18 with virtual memory (Sv32), running in S-mode on top of the OpenSBI firmware. Upstream [Buildroot](https://buildroot.org) 2026.02 LTS, glibc and BusyBox, plus extra packages, currently Midnight Commander (`mc`). | `npm run linux:build` → `images/linux-mmu/fw_jump.bin` + `Image` | `npm run linux` |
| **nommu** | [mini-rv32ima](https://github.com/cnlohr/mini-rv32ima)'s tiny no-MMU kernel running in M-mode, with BusyBox and uClibc. A prebuilt image can also be downloaded. | `npm run linux:nommu:build` → `images/linux/Image` | `npm run linux:nommu` |

Both are built by `linux/build.sh`; `FLAVOR=mmu` (default) or `FLAVOR=nommu`
selects one.

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
volume per flavor, `risc-emulator-buildroot-mmu` and `risc-emulator-buildroot`
(nommu), which keep downloads and build state between runs. `podman volume rm
<name>` starts that flavor over from scratch.

To skip the container on a Linux host, run `NATIVE=1 linux/build.sh`. You'll
need Buildroot's host packages. For the nommu flavor you also need a GCC older
than 15: GCC 15 defaults to C23, which the old Buildroot snapshot nommu uses
(2023.11) doesn't compile under.

The first build compiles a cross toolchain, the kernel and all packages. It
needs a few GB of disk and takes a while. Later builds are incremental.

## Console session

The console runs a single login session (log in as `root`, no password).
When it ends with `exit`, Ctrl-D or too many failed logins, the machine
powers off, and `npm run linux` exits with it. This is set up in
`linux/overlay/etc/inittab` and `linux/overlay/sbin/console-session`. To get
the classic behaviour, where a new `login:` prompt appears after each logout,
change the console line in `inittab` back to
`console::respawn:/sbin/getty -L console 0 xterm-256color`.

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

On the mmu flavor programs are ordinary dynamically linked executables.
Anything Buildroot packages can also be added: put its `BR2_PACKAGE_...=y`
option in `linux/mmu/buildroot.fragment` (that's how `mc` is added). `linux/build.sh menuconfig`
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
emulator has (RV32IMA, no FPU, no compressed instructions), the root
filesystem, OpenSBI and the packages. Kernel options go in
`linux/mmu/linux.fragment`, on top of the kernel's `rv32_defconfig`.

**nommu:** the configs come from `vendor/mini-rv32ima/configs/`. To change one, copy it
into `linux/nommu/configs/` under the same name and edit it there. A file in
`linux/nommu/configs/` takes precedence.

For both, you can also use Buildroot's menus, e.g. `linux/build.sh
linux-menuconfig` or `linux/build.sh busybox-menuconfig` (with `FLAVOR=` as
needed). Copy the result back into the fragment or config file so the change
isn't lost.

`linux/build.sh <target>` runs any Buildroot make target. For example,
`linux/build.sh clean` wipes the build output but keeps the downloads.
Native builds (`NATIVE=1`) work in `.buildroot/<flavor>/`; set `BUILD_DIR` to
build elsewhere.
