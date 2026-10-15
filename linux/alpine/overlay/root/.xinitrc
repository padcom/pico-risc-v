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
# The keyboard's map, X's core one too (the one programs ask which key is
# where): until the keyboard's first key it's X's own default, numbered as
# old X servers did, not as evdev does, and SDL3 (Doom's) goes by what it
# sees when it starts: its arrow keys would be other keys.
setxkbmap -rules evdev -model pc105 -layout us
fluxbox &
exec xterm -geometry 100x30+40+40
