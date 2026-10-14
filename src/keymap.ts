/**
 * Linux's key codes (KEY_*, include/uapi/linux/input-event-codes.h) of the
 * browser's keys, by KeyboardEvent.code: the key's place on the keyboard,
 * not what it types (the guest's keyboard layout decides that, as on a PC).
 */
export const LINUX_KEYS: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111, NumpadEqual: 117, Pause: 119, NumpadComma: 121, IntlYen: 124,
  MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
}

/**
 * KeyboardEvent.code of USB keyboard scancodes (HID usage page 7), as SDL has
 * them (SDL_Scancode): keys by place too.
 */
const USB_CODES: Readonly<Record<number, string>> = {
  ...Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, i) => [4 + i, `Key${letter}`])),
  ...Object.fromEntries([...'1234567890'].map((digit, i) => [30 + i, `Digit${digit}`])),
  40: 'Enter', 41: 'Escape', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: 'Minus', 46: 'Equal',
  47: 'BracketLeft', 48: 'BracketRight', 49: 'Backslash', 50: 'Backslash', // (non-US #: where \ is)
  51: 'Semicolon', 52: 'Quote', 53: 'Backquote', 54: 'Comma', 55: 'Period', 56: 'Slash', 57: 'CapsLock',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [58 + i, `F${i + 1}`])),
  70: 'PrintScreen', 71: 'ScrollLock', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'PageUp', 76: 'Delete',
  77: 'End', 78: 'PageDown', 79: 'ArrowRight', 80: 'ArrowLeft', 81: 'ArrowDown', 82: 'ArrowUp', 83: 'NumLock',
  84: 'NumpadDivide', 85: 'NumpadMultiply', 86: 'NumpadSubtract', 87: 'NumpadAdd', 88: 'NumpadEnter',
  ...Object.fromEntries([...'1234567890'].map((digit, i) => [89 + i, `Numpad${digit}`])),
  99: 'NumpadDecimal', 100: 'IntlBackslash', 101: 'ContextMenu', 103: 'NumpadEqual', 133: 'NumpadComma',
  135: 'IntlRo', 137: 'IntlYen',
  224: 'ControlLeft', 225: 'ShiftLeft', 226: 'AltLeft', 227: 'MetaLeft',
  228: 'ControlRight', 229: 'ShiftRight', 230: 'AltRight', 231: 'MetaRight',
}

/** Linux's key code of a USB keyboard scancode, if it's a key Linux has here. */
export function linuxKeyOfScancode(scancode: number): number | undefined {
  const code = USB_CODES[scancode]
  return code === undefined ? undefined : LINUX_KEYS[code]
}
