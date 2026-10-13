/**
 * Linux's key codes (KEY_*) for X keysyms, as VNC viewers send keys: what a
 * key types, not where it is. So which key that was depends on the layout:
 * this is a US keyboard's, with the shifted characters on their keys (the
 * viewer sends Shift itself, as a key of its own). Keysyms it doesn't have
 * (other layouts' letters, say) aren't keys here.
 */
const PLAIN = '1234567890-=qwertyuiop[]asdfghjkl;\'`\\zxcvbnm,./ '
const SHIFTED = '!@#$%^&*()_+QWERTYUIOP{}ASDFGHJKL:"~|ZXCVBNM<>? '
/** KEY_* of PLAIN's (and SHIFTED's) characters, in order. */
const CODES = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
  43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  57,
]

/** The keysyms of keys that don't type characters (X11/keysymdef.h). */
const SPECIAL: [keysym: number, key: number][] = [
  [0xff08, 14], // BackSpace
  [0xff09, 15], // Tab
  [0xff0d, 28], // Return
  [0xff13, 119], // Pause
  [0xff14, 70], // Scroll_Lock
  [0xff1b, 1], // Escape
  [0xff50, 102], // Home
  [0xff51, 105], // Left
  [0xff52, 103], // Up
  [0xff53, 106], // Right
  [0xff54, 108], // Down
  [0xff55, 104], // Prior (Page Up)
  [0xff56, 109], // Next (Page Down)
  [0xff57, 107], // End
  [0xff61, 99], // Print
  [0xff63, 110], // Insert
  [0xff67, 127], // Menu
  [0xff7f, 69], // Num_Lock
  [0xff8d, 96], // KP_Enter
  [0xffaa, 55], // KP_Multiply
  [0xffab, 78], // KP_Add
  [0xffad, 74], // KP_Subtract
  [0xffae, 83], // KP_Decimal
  [0xffaf, 98], // KP_Divide
  [0xffb0, 82], // KP_0
  [0xffb1, 79], [0xffb2, 80], [0xffb3, 81], // KP_1..3
  [0xffb4, 75], [0xffb5, 76], [0xffb6, 77], // KP_4..6
  [0xffb7, 71], [0xffb8, 72], [0xffb9, 73], // KP_7..9
  [0xffbd, 117], // KP_Equal
  [0xffbe, 59], [0xffbf, 60], [0xffc0, 61], [0xffc1, 62], [0xffc2, 63], [0xffc3, 64], // F1..F6
  [0xffc4, 65], [0xffc5, 66], [0xffc6, 67], [0xffc7, 68], [0xffc8, 87], [0xffc9, 88], // F7..F12
  [0xffe1, 42], // Shift_L
  [0xffe2, 54], // Shift_R
  [0xffe3, 29], // Control_L
  [0xffe4, 97], // Control_R
  [0xffe5, 58], // Caps_Lock
  [0xffe7, 125], // Meta_L
  [0xffe8, 126], // Meta_R
  [0xffe9, 56], // Alt_L
  [0xffea, 100], // Alt_R
  [0xffeb, 125], // Super_L
  [0xffec, 126], // Super_R
  [0xfe03, 100], // ISO_Level3_Shift (AltGr)
  [0xffff, 111], // Delete
]

const KEYS = new Map<number, number>([
  ...[...PLAIN].map((char, i) => [char.charCodeAt(0), CODES[i]!] as [number, number]),
  ...[...SHIFTED].map((char, i) => [char.charCodeAt(0), CODES[i]!] as [number, number]),
  ...SPECIAL,
])

/** The KEY_* code of the key that types `keysym` (on a US keyboard), if any. */
export function linuxKey(keysym: number): number | undefined {
  return KEYS.get(keysym)
}
