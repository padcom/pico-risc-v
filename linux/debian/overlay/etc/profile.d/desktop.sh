# Logged in on the screen (tty1): the desktop (Xfce), once. When it's
# closed, or if it doesn't start, the shell is still there.
if [ "$(tty)" = /dev/tty1 ] && [ -z "${DISPLAY:-}" ] && [ -e /dev/fb0 ] && [ -z "${DESKTOP_STARTED:-}" ]; then
  export DESKTOP_STARTED=1
  # (X runs on the GPU, whose driver may still be loading: a while, at most.)
  for i in $(seq 1 60); do [ -e /dev/dri/card0 ] && break; sleep 0.5; done
  startx
fi
