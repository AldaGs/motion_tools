// src/utils/hotkey.ts
//
// Layout-independent hotkey formatting. We derive the key name from
// KeyboardEvent.code (the physical key) instead of KeyboardEvent.key, so
// Shift+1 doesn't record as "Shift+!" and AZERTY/QWERTZ users get the same
// combo string as QWERTY users for the same physical key.
//
// The string format is unchanged for the common cases ("Ctrl+Z", "Alt+S",
// "Ctrl+Shift+1") so existing saved hotkeys keep working.

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight',
]);

const SPECIAL_CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Escape: 'Esc',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Insert: 'Insert', Delete: 'Delete',
  Minus: '-', Equal: '=', Backslash: '\\', Slash: '/',
  Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.',
  BracketLeft: '[', BracketRight: ']',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-',
  NumpadMultiply: 'Num*', NumpadDivide: 'Num/',
  NumpadDecimal: 'Num.', NumpadEnter: 'NumEnter',
};

/** Returns the printable key name for a `KeyboardEvent.code`, or null if the
 * event is just a modifier press on its own. */
export function keyNameFromCode(code: string): string | null {
  if (MODIFIER_CODES.has(code)) return null;
  // KeyA..KeyZ → A..Z
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3);
  // Digit0..Digit9 → 0..9
  if (code.length === 6 && code.startsWith('Digit')) return code.slice(5);
  // Numpad0..Numpad9 → Num0..Num9
  if (code.startsWith('Numpad') && code.length === 7) return 'Num' + code.slice(6);
  // F1..F24
  if (/^F\d{1,2}$/.test(code)) return code;
  if (SPECIAL_CODE_MAP[code]) return SPECIAL_CODE_MAP[code];
  return code; // fallback — rare; keeps things working for IntlBackslash etc.
}

/** Formats a KeyboardEvent into a stable combo string ("Ctrl+Shift+A") or
 * returns "" when only modifiers are pressed. */
export function formatHotkey(e: KeyboardEvent | React.KeyboardEvent): string {
  const name = keyNameFromCode(e.code);
  if (!name) return '';
  const parts = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Meta',
    name,
  ].filter(Boolean);
  return parts.join('+');
}
