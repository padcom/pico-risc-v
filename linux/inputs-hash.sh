#!/usr/bin/env bash
#
# Prints a fingerprint (SHA-256) of everything a Linux image is built from.
#
#   linux/inputs-hash.sh [mmu|rv64|debian]   (default mmu)
#
# linux/build.sh stores it next to the image; `npm start` rebuilds the
# image when it no longer matches. Works on the host (macOS: shasum) and in
# the build container (sha256sum); paths are relative to the project, so both
# see the same thing.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if command -v sha256sum >/dev/null; then
  hasher=(sha256sum)
else
  hasher=(shasum -a 256)
fi

# A hash of the per-file "hash  path" lines (same format from both tools).
case "${1:-mmu}" in
  mmu) inputs=(linux/mmu) ;;
  rv64) inputs=(linux/mmu linux/rv64) ;;
  debian) inputs=(linux/debian) ;; # a Debian disk; the kernel is rv64's
esac
[ "${1:-mmu}" = debian ] || inputs+=(linux/overlay linux/programs linux/build.sh linux/post-build.sh linux/Containerfile)
find "${inputs[@]}" -type f ! -name .DS_Store -print0 |
  LC_ALL=C sort -z |
  xargs -0 "${hasher[@]}" |
  "${hasher[@]}" | cut -d' ' -f1
