#!/usr/bin/env bash
#
# Installs everything needed to build and run the emulator on macOS, so that
# after a fresh clone:
#
#   scripts/setup-macos.sh
#   npm run start:debian
#
# boots Debian. It installs (whatever is missing), with Homebrew
# (https://brew.sh, installed first if needed; that asks for your password):
#
#   - Podman: the Linux images are built in Podman containers, in a small
#     Linux VM Podman runs (linux/podman.sh creates it on first use)
#   - Node.js, unless a Node.js of at least $NODE_MIN is already there
#   - rustup, then Rust with the WebAssembly target, for the CPU core
#
# then the project's npm packages, and builds the emulator once to check it
# all works.
#
# Safe to run again: what's already installed is left alone.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE_MIN=22.18 # runs TypeScript (scripts/*.ts) without flags

step() { echo; echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Darwin ] || die "this is for macOS; on Linux use scripts/setup-linux.sh"
# Podman's VM only sees the home directory (see linux/podman.sh).
case "$ROOT" in
  "$HOME"/*) ;;
  *) die "the project must live under your home directory ($HOME): that's all Podman's VM can see. Move it, then run this again." ;;
esac

step "Homebrew"
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done
if ! have brew; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
  done
  have brew || die "Homebrew didn't install"
fi
echo "$(brew --version | head -1)"

step "Podman, rustup and Node.js"
node_ok() {
  have node || return 1
  local version major minor min_major=${NODE_MIN%%.*} min_minor=${NODE_MIN#*.}
  version=$(node --version) # v24.1.0
  major=${version#v}; major=${major%%.*}
  minor=${version#v*.}; minor=${minor%%.*}
  [ "$major" -gt "$min_major" ] || { [ "$major" -eq "$min_major" ] && [ "$minor" -ge "$min_minor" ]; }
}
formulas=(podman rustup)
if node_ok; then
  echo "Node.js $(node --version) is fine"
else
  formulas+=(node)
fi
for formula in "${formulas[@]}"; do
  brew list --formula "$formula" >/dev/null 2>&1 || brew install "$formula"
done
node_ok || die "Node.js is still older than $NODE_MIN; check which node is first on PATH ($(command -v node))"

step "Rust with the WebAssembly target"
# Homebrew's rustup keeps cargo and rustc off PATH (scripts/build-wasm.ts
# finds them there).
export PATH="$(brew --prefix rustup)/bin:$PATH"
rustup toolchain list | grep -q . || rustup default stable
rustup target add wasm32-unknown-unknown

step "npm packages"
cd "$ROOT"
npm ci

step "Building the emulator (a check that it all works)"
npm run build

cat <<EOF

==> Done. Now:

  npm run start:debian

The first run creates Podman's Linux VM, builds the 64-bit Linux kernel
(with Buildroot, in a Podman container: a cross toolchain, the kernel and
firmware, so it takes a while) and the Debian disk, then boots it. Log in as
root, no password; poweroff quits. See linux/README.md for more.
EOF
