#!/usr/bin/env bash
#
# Runs linux/build.sh inside a Podman container built from linux/Containerfile,
# so the build doesn't depend on the host's distribution or compiler.
#
#   - the project directory is bind-mounted at /work: linux/programs,
#     linux/overlay and linux/configs go in, images/linux/Image comes out
#   - Buildroot works in the named volume "risc-emulator-buildroot" (a Linux,
#     case-sensitive file system; it keeps downloads and build state between
#     runs). `podman volume rm risc-emulator-buildroot` throws it all away.
#   - on macOS Podman runs containers in its own Linux VM ("podman machine");
#     it is created and started here if needed
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=localhost/risc-emulator-buildroot
VOLUME=risc-emulator-buildroot

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
podman build --tag "$IMAGE" --file "$ROOT/linux/Containerfile" "$ROOT/linux"

tty=() # (expanded below in a way that also works with macOS's bash 3.2 and set -u)
[ -t 0 ] && [ -t 1 ] && tty=(--interactive --tty) # e.g. for linux-menuconfig

step "Running linux/build.sh in the container"
# :z relabels the bind mount on SELinux hosts (Fedora, ...); it's a no-op elsewhere.
exec podman run --rm ${tty[@]+"${tty[@]}"} \
  --volume "$VOLUME:/build" \
  --volume "$ROOT:/work:z" \
  --workdir /work \
  --env BUILD_DIR=/build \
  "$IMAGE" bash linux/build.sh "$@"
