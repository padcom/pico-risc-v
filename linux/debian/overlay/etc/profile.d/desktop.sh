# Logged in on the screen (tty1): the desktop (Xfce), once. When it's
# closed, or if it doesn't start, the shell is still there.
if [ "$(tty)" = /dev/tty1 ] && [ -z "${DISPLAY:-}" ] && [ -e /dev/fb0 ] && [ -z "${DESKTOP_STARTED:-}" ]; then
  export DESKTOP_STARTED=1
  startx
fi
