# Logged in on the screen (tty1): X, once. When it's closed, or if it
# doesn't start, the shell is still there.
if [ "$(tty)" = /dev/tty1 ] && [ -z "${DISPLAY:-}" ] && [ -e /dev/fb0 ] && [ -z "${DESKTOP_STARTED:-}" ]; then
  export DESKTOP_STARTED=1
  # X on the GPU (virtio_gpu, through the modesetting driver: card0 is the
  # boot framebuffer's), once its driver is there (a while, at most), its
  # cursor drawn by X (the GPU's isn't shown); without one, on the framebuffer.
  gpu=
  for i in $(seq 1 60); do
    for card in /sys/class/drm/card[0-9]; do
      case "$(readlink "$card/device")" in *virtio_mmio) gpu=/dev/dri/${card##*/} ;; esac
    done
    [ -n "$gpu" ] && [ -e "$gpu" ] && break
    sleep 0.5
  done
  if [ -n "$gpu" ]; then
    printf 'Section "Device"\n    Identifier "gpu"\n    Driver "modesetting"\n    Option "kmsdev" "%s"\n    Option "SWcursor" "on"\nEndSection\n' "$gpu"
  else
    printf 'Section "Device"\n    Identifier "screen"\n    Driver "fbdev"\n    Option "fbdev" "/dev/fb0"\nEndSection\n'
  fi >/etc/X11/xorg.conf.d/20-gpu.conf
  startx
fi
