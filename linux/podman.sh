#!/usr/bin/env bash
#
# Runs linux/<distribution>/build.sh inside a Podman container built from
# linux/<distribution>/Containerfile, so the build doesn't depend on the
# host's distribution or tools:
#
#   linux/podman.sh [<distribution>] [build.sh's arguments]   (debian, the default; alpine)
#
#   - the project directory is bind-mounted at /work: linux/<distribution>/
#     goes in, images/<distribution>/ comes out
#   - on macOS Podman runs containers in its own Linux VM ("podman machine");
#     it is created and started here if needed
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
case "${1:-}" in
  debian | alpine) DISTRIBUTION=$1; shift ;;
  *) DISTRIBUTION=debian ;;
esac
IMAGE=localhost/risc-emulator-$DISTRIBUTION
CONTEXT=$ROOT/linux/$DISTRIBUTION
SCRIPT=linux/$DISTRIBUTION/build.sh

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

command -v podman >/dev/null || die "the $DISTRIBUTION build runs in a Podman container; install Podman first:
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

step "Running $SCRIPT in the container"
# No SELinux separation (the podman machine, Fedora, ... enforce it): this is
# our own build tool, and it leaves the project directory's labels alone.
exec podman run --rm \
  --security-opt label=disable \
  --volume "$ROOT:/work" \
  --workdir /work \
  "$IMAGE" bash "$SCRIPT" "$@"
