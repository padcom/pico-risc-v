# What startx starts: Fluxbox (~/.fluxbox), and a terminal; closing that ends X.
# And when the screen's size changes (the emulator's window or page: its
# GPU's display's preferred size), X takes it (no udev here to say so: it
# looks every 2 seconds).
(
  while sleep 2; do
    state=$(xrandr 2>/dev/null) || exit
    output=$(echo "$state" | awk '/ connected/ { print $1; exit }')
    current=$(echo "$state" | awk '/^ / && /\*/ { print $1; exit }')
    preferred=$(echo "$state" | awk '/^ / && /\+/ { print $1; exit }')
    [ -n "$preferred" ] && [ "$preferred" != "$current" ] && xrandr --output "$output" --auto
  done
) &
fluxbox &
exec xterm -geometry 100x30+40+40
