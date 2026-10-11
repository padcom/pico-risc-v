#!/usr/bin/env bash
#
# Installs everything needed to build and run the emulator on Linux, so that
# after a fresh clone:
#
#   scripts/setup-linux.sh
#   npm start
#
# boots Debian. It installs (whatever is missing):
#
#   - git, curl, Podman (Debian's image is prepared in a Podman container),
#     ping (the emulator's network relays pings through it) and a C compiler
#     (the linker for the CPU core's native Rust tests, npm test), with the
#     distribution's package manager: apt (Debian, Ubuntu), dnf (Fedora),
#     pacman (Arch) or zypper (openSUSE); this needs sudo
#   - Node.js 24 with fnm (https://github.com/Schniz/fnm), unless a Node.js
#     of at least $NODE_MIN is already there; distributions' are often older
#   - Rust with the WebAssembly target, with rustup (https://rustup.rs), for
#     the CPU core
#   - the project's npm packages
#
# and then builds the emulator once to check it all works. fnm and rustup go
# into your home directory and add themselves to your shell's startup file:
# open a new terminal afterwards.
#
# Safe to run again: what's already installed is left alone.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NODE_MIN=22.18 # runs TypeScript (scripts/*.ts) without flags
NODE_INSTALL=24 # the current LTS

step() { echo; echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "this is for Linux; on macOS use scripts/setup-macos.sh"
SUDO=()
[ "$(id -u)" -eq 0 ] || SUDO=(sudo)

step "System packages"
if have apt-get; then
  packages=(git curl ca-certificates unzip podman iputils-ping gcc)
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
elif have dnf; then
  packages=(git curl unzip podman iputils gcc)
  "${SUDO[@]}" dnf install -y "${packages[@]}"
elif have pacman; then
  packages=(git curl unzip podman iputils gcc)
  "${SUDO[@]}" pacman -S --needed --noconfirm "${packages[@]}"
elif have zypper; then
  packages=(git curl unzip podman iputils gcc)
  "${SUDO[@]}" zypper --non-interactive install "${packages[@]}"
else
  die "no supported package manager (apt, dnf, pacman, zypper); install git, curl, unzip, podman, ping and gcc yourself, then run this again"
fi

# Rootless Podman maps container users to a range of the user's subordinate
# IDs; accounts created before Podman was installed may not have any.
if [ "$(id -u)" -ne 0 ] && ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  step "Subordinate user and group IDs for rootless Podman"
  "${SUDO[@]}" usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(id -un)"
  podman system migrate
fi

step "Node.js"
node_ok() {
  have node || return 1
  local version major minor min_major=${NODE_MIN%%.*} min_minor=${NODE_MIN#*.}
  version=$(node --version) # v24.1.0
  major=${version#v}; major=${major%%.*}
  minor=${version#v*.}; minor=${minor%%.*}
  [ "$major" -gt "$min_major" ] || { [ "$major" -eq "$min_major" ] && [ "$minor" -ge "$min_minor" ]; }
}
FNM_DIR=${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}
[ -x "$FNM_DIR/fnm" ] && export PATH="$FNM_DIR:$PATH" && eval "$(fnm env --shell bash)"
if node_ok; then
  echo "Node.js $(node --version) is fine"
else
  if ! have fnm; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_DIR"
    export PATH="$FNM_DIR:$PATH"
  fi
  eval "$(fnm env --shell bash)"
  fnm install "$NODE_INSTALL"
  fnm default "$NODE_INSTALL"
  fnm use "$NODE_INSTALL"
  node_ok || die "Node.js $NODE_INSTALL didn't install"
fi

step "Rust (rustup) with the WebAssembly target"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! have rustup; then
  # (RUSTUP_INIT_SKIP_PATH_CHECK: a distribution's Rust may already be there;
  # rustup's comes first on PATH.)
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    RUSTUP_INIT_SKIP_PATH_CHECK=yes sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi
rustup toolchain list | grep -q . || rustup default stable
rustup target add wasm32-unknown-unknown

step "npm packages"
cd "$ROOT"
npm ci

step "Building the emulator (a check that it all works)"
npm run build

if ! podman info >/dev/null 2>&1; then
  echo
  echo "warning: Podman is installed but doesn't work yet (podman info fails):" >&2
  podman info 2>&1 | tail -3 >&2 || true
fi

cat <<EOF

==> Done. Open a new terminal (for Node.js and Rust on PATH), then:

  npm start

The first run sets Debian up (it downloads Debian's cloud image and
firmware, a few minutes), then boots it; that takes under a minute. Log in
as root, no password; poweroff quits. See linux/README.md for more.
EOF
