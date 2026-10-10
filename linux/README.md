# Building the Linux image from source

`npm run linux:build` (or `linux/build.sh`) builds `images/linux/Image`, which
`npm run linux` then boots. The image is a nommu RV32 Linux kernel with a
BusyBox + uClibc root filesystem built into it (an initramfs), made with
[mini-rv32ima](https://github.com/cnlohr/mini-rv32ima)'s Buildroot
configuration.

The build runs in a **Podman** container (`linux/Containerfile`, a pinned
Debian 12), so it doesn't depend on your distribution or compiler:

- **Linux:** install Podman (`apt install podman` / `dnf install podman`).
  It runs rootless, with no daemon.
- **macOS:** `brew install podman`. Podman runs containers in its own small
  Linux VM, which `linux/podman.sh` creates and starts on first use. The
  project must live under your home directory, because that's what Podman
  shares with the VM.

Your project directory is mounted into the container: programs, overlay and
configs go in, and `images/linux/Image` comes out. Buildroot itself works in
the Podman volume `risc-emulator-buildroot`, which keeps downloads and
build state between runs. `podman volume rm risc-emulator-buildroot` starts
over from scratch.

To skip the container on a Linux host, run `NATIVE=1 linux/build.sh`. You'll
need Buildroot's host packages, and a GCC older than 15: GCC 15 defaults to
C23, which this Buildroot snapshot's (2023.11) host packages don't compile
under.

The first build compiles a cross toolchain, the kernel and BusyBox. It needs
a few GB of disk and takes a while. Later builds are incremental.

## Console session

The console runs a single login session (log in as `root`, no password).
When it ends with `exit`, Ctrl-D or too many failed logins, the machine
powers off, and `npm run linux` exits with it. This is set up in
`linux/overlay/etc/inittab` and `linux/overlay/sbin/console-session`. To get
the classic behaviour, where a new `login:` prompt appears after each logout,
change the console line in `inittab` back to
`console::respawn:/sbin/getty -L console 0 vt100`.

## Adding things to the image

| Put it in…                    | …and it ends up as                                    |
| ----------------------------- | ----------------------------------------------------- |
| `linux/programs/<name>/*.c`   | `/usr/local/bin/<name>`, compiled for the target      |
| `linux/programs/<name>/Makefile` | whatever executables it builds into `$(O)`         |
| `linux/overlay/<path>`        | `/<path>`, copied verbatim (scripts, config files, …) |

Then run `npm run linux:build` again. Only your changes are rebuilt, and the
kernel is relinked with the new root filesystem.

A Makefile-based program gets `CC`, `CFLAGS`, `LDFLAGS` and `O` from the
build. For example:

```make
$(O)/myprog: main.c util.c
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
```

### Things to know about nommu Linux

- **No `fork()`.** Use `vfork()` + `exec*()` or `posix_spawn()` instead.
- **bFLT executables.** Programs are static and position independent, then
  converted from ELF to bFLT (that's what `-Wl,-elf2flt` in `LDFLAGS` does).
- **Fixed stack size** of 64 KiB (`STACK_SIZE` in `post-build.sh`).
- **No memory protection** between processes.

## Customizing the kernel, BusyBox, uClibc or Buildroot

The configs come from `vendor/mini-rv32ima/configs/`. To change one, copy it
into `linux/configs/` under the same name and edit it there. A file in
`linux/configs/` takes precedence. You can also use Buildroot's menus, e.g.
`linux/build.sh linux-menuconfig` or `linux/build.sh busybox-menuconfig`.
Copy the result back into `linux/configs/` so the change isn't lost.

`linux/build.sh <target>` runs any Buildroot make target. For example,
`linux/build.sh clean` wipes the build output but keeps the downloads.
Native builds (`NATIVE=1`) work in `.buildroot/`; set `BUILD_DIR` to build
elsewhere.
