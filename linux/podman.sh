#!/usr/bin/env bash
#
# Runs a build script inside a Podman container, so the build doesn't depend
# on the host's distribution or compiler:
#
#   FLAVOR=kernel   linux/kernel/build.sh in a container from linux/kernel/Containerfile
#   FLAVOR=debian   linux/debian/build.sh in a container from linux/debian/Containerfile
#
#   - the project directory is bind-mounted at /work: configuration goes in,
#     the images come out
#   - Buildroot (the kernel build) works in a named volume,
#     "risc-emulator-kernel": a Linux, case-sensitive file system that keeps
#     downloads and build state between runs. `podman volume rm
#     risc-emulator-kernel` throws it all away.
#   - on macOS Podman runs containers in its own Linux VM ("podman machine");
#     it is created and started here if needed
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FLAVOR=${FLAVOR:-kernel}
case "$FLAVOR" in
  kernel)
    IMAGE=localhost/risc-emulator-kernel
    extra=(--volume risc-emulator-kernel:/build --env BUILD_DIR=/build)
    ;;
  debian)
    IMAGE=localhost/risc-emulator-debian
    # Mounting a binfmt_misc of the container's own, to run riscv64 programs
    # with QEMU while building (see linux/debian/build.sh); no build volume.
    extra=(--cap-add SYS_ADMIN)
    ;;
  *) echo "error: unknown FLAVOR '$FLAVOR' (kernel or debian)" >&2; exit 1 ;;
esac
CONTEXT=$ROOT/linux/$FLAVOR
SCRIPT=linux/$FLAVOR/build.sh

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

command -v podman >/dev/null || die "the Linux build runs in a Podman container; install Podman first:
  macOS:         brew install podman
  Debian/Ubuntu: sudo apt install podman
  Fedora:        sudo dnf install podman"

if [ "$(uname -s)" = Darwin ]; then
  if [ -z "$(podman machine list --format '{{.Name}}')" ]; then
    cpus=$(sysctl -n hw.ncpu)
    mem_mib=$(($(sysctl -n hw.memsize) / 1024 / 1024 / 2))
    [ "$mem_mib" -gt 16384 ] && mem_mib=16384
    step "Creating the Podman VM ($cpus CPUs, $((mem_mib / 1024)) GiB RAM)"
    podman machine init --cpus "$cpus" --memory "$mem_mib" --disk-size 100
  fi
  if ! podman machine list --format '{{.Running}}' | grep -qx true; then
    step "Starting the Podman VM"
    podman machine start
  fi
  case "$ROOT" in
    "$HOME"/*) ;;
    *) die "on macOS the project must live under $HOME (only that is shared with the Podman VM)" ;;
  esac
fi

step "Preparing the build container"
podman build --tag "$IMAGE" --file "$CONTEXT/Containerfile" "$CONTEXT"

tty=() # (expanded below in a way that also works with macOS's bash 3.2 and set -u)
[ -t 0 ] && [ -t 1 ] && tty=(--interactive --tty) # e.g. for linux-menuconfig

step "Running $SCRIPT in the container"
# No SELinux separation (the podman machine, Fedora, ... enforce it): this is
# our own build tool, and with it, files in the build volume can end up with
# labels a later container may not touch (seen as "Permission denied" for root).
# It also leaves the project directory's labels alone.
exec podman run --rm ${tty[@]+"${tty[@]}"} \
  --security-opt label=disable \
  "${extra[@]}" \
  --volume "$ROOT:/work" \
  --workdir /work \
  --env FLAVOR="$FLAVOR" \
  "$IMAGE" bash "$SCRIPT" "$@"
