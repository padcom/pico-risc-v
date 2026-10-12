#!/usr/bin/env bash
#
# Prints a fingerprint (SHA-256) of everything a distribution's image is
# built from (linux/<distribution>/):
#
#   linux/inputs-hash.sh [<distribution>]   (debian, the default; alpine)
#
# linux/<distribution>/build.sh stores it next to the image; `npm start`
# rebuilds the image when it no longer matches. Works on the host (macOS:
# shasum) and in the build container (sha256sum); paths are relative to the
# project, so both see the same thing.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if command -v sha256sum >/dev/null; then
  hasher=(sha256sum)
else
  hasher=(shasum -a 256)
fi

# A hash of the per-file "hash  path" lines (same format from both tools).
DISTRIBUTION=${1:-debian}
find "linux/$DISTRIBUTION" -type f ! -name .DS_Store -print0 |
  LC_ALL=C sort -z |
  xargs -0 "${hasher[@]}" |
  "${hasher[@]}" | cut -d' ' -f1
