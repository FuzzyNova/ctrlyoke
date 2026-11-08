/**
 * Converts a captured key press into the byte sequence a terminal would send
 * for it, and back into a human label.
 *
 * Sequences are written in the literal escape notation that
 * `TerminalControlBar`'s `decodeEscapeSequence` reads ("\\x1b[A", "\\r"), so
 * they can be stored in settings and edited by hand.
 *
 * Encoding follows xterm: the legacy form wherever one exists (control bytes,
 * an ESC prefix for Alt, `CSI 1;<mod>A` for modified cursor keys), and the
 * CSI u form (`CSI <codepoint>;<mod>u`, as used by kitty, Claude Code and
 * other modern TUIs) for combinations the legacy encoding cannot express,
 * such as Shift+Enter or Ctrl+Shift+letter.
 *
 * Labels here describe literal PTY key sequences, not app-level shortcuts —
 * terminals never remap these to Cmd on macOS, so do not run them through
 * @utils/platform's formatShortcut.
 */

const ESC = "\\x1b";

interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface CapturedKey {
  sequence: string;
  humanLabel: string;
}

/** Keys encoded as `CSI <final>` (or `SS3 <final>`), `CSI 1;<mod><final>` when modified. */
const CSI_FINAL_KEYS: Record<
  string,
  { final: string; name: string; ss3?: true }
> = {
  ArrowUp: { final: "A", name: "↑" },
  ArrowDown: { final: "B", name: "↓" },
  ArrowRight: { final: "C", name: "→" },
  ArrowLeft: { final: "D", name: "←" },
  Home: { final: "H", name: "Home" },
  End: { final: "F", name: "End" },
  F1: { final: "P", name: "F1", ss3: true },
  F2: { final: "Q", name: "F2", ss3: true },
  F3: { final: "R", name: "F3", ss3: true },
  F4: { final: "S", name: "F4", ss3: true },
};

/** Keys encoded as `CSI <n>~`, `CSI <n>;<mod>~` when modified. */
const CSI_TILDE_KEYS: Record<string, { n: number; name: string }> = {
  Insert: { n: 2, name: "Ins" },
  Delete: { n: 3, name: "Del" },
  PageUp: { n: 5, name: "PgUp" },
  PageDown: { n: 6, name: "PgDn" },
  F5: { n: 15, name: "F5" },
  F6: { n: 17, name: "F6" },
  F7: { n: 18, name: "F7" },
  F8: { n: 19, name: "F8" },
  F9: { n: 20, name: "F9" },
  F10: { n: 21, name: "F10" },
  F11: { n: 23, name: "F11" },
  F12: { n: 24, name: "F12" },
};

/**
 * Keys with a single-byte legacy form. Modified combinations the legacy form
 * cannot express fall back to `CSI <codepoint>;<mod>u`.
 */
const CSI_U_KEYS: Record<
  string,
  { codepoint: number; name: string; plain: string; ctrl?: string }
> = {
  Enter: { codepoint: 13, name: "Enter", plain: "\\r" },
  Tab: { codepoint: 9, name: "Tab", plain: "\\t" },
  Backspace: {
    codepoint: 127,
    name: "Backspace",
    plain: "\\x7f",
    ctrl: "\\x08",
  },
  Escape: { codepoint: 27, name: "Esc", plain: ESC },
  " ": { codepoint: 32, name: "Space", plain: " ", ctrl: "\\x00" },
};

/** Non-letter keys xterm maps to a control byte when Ctrl is held. */
const CTRL_SYMBOL_BYTES: Record<string, number> = {
  "@": 0x00,
  "2": 0x00,
  "[": 0x1b,
  "3": 0x1b,
  "\\": 0x1c,
  "4": 0x1c,
  "]": 0x1d,
  "5": 0x1d,
  "^": 0x1e,
  "6": 0x1e,
  _: 0x1f,
  "-": 0x1f,
  "/": 0x1f,
  "7": 0x1f,
};

/** Canonical label for each control byte that is not Ctrl+<letter>. */
const CTRL_SYMBOL_NAMES: Record<number, string> = {
  0x00: "Space",
  0x1b: "[",
  0x1c: "\\",
  0x1d: "]",
  0x1e: "^",
  0x1f: "_",
};

/** Keys that never produce a sequence on their own. */
const NON_CAPTURABLE_KEYS = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Process",
  "Unidentified",
]);

/** xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
function modifierParam({ ctrl, alt, shift }: KeyModifiers): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

function modifiersFromParam(param: number): KeyModifiers {
  const bits = param - 1;
  return {
    ctrl: (bits & 4) !== 0,
    alt: (bits & 2) !== 0,
    shift: (bits & 1) !== 0,
  };
}

function hasModifier(mods: KeyModifiers): boolean {
  return mods.ctrl || mods.alt || mods.shift;
}

function isOnly(mods: KeyModifiers, key: keyof KeyModifiers): boolean {
  return (
    mods[key] &&
    (["ctrl", "alt", "shift"] as const).every((k) => k === key || !mods[k])
  );
}

function formatLabel(mods: KeyModifiers, keyName: string): string {
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(keyName);
  return parts.join("+");
}

function hexByte(byte: number): string {
  return `\\x${byte.toString(16).padStart(2, "0")}`;
}

/** A printable character in escape notation (only the backslash needs escaping). */
function encodeChar(char: string): string {
  return char === "\\" ? "\\\\" : char;
}

function csiU(codepoint: number, mods: KeyModifiers): string {
  return `${ESC}[${codepoint};${modifierParam(mods)}u`;
}

/**
 * The character for a key press. With Ctrl or Alt held, a key that did not
 * produce a plain ASCII character falls back to its physical key
 * (`event.code`): macOS Option composes `event.key` into another character
 * (Option+M is "µ") and Windows AltGr (Ctrl+Alt) does the same on many
 * layouts. `event.key` stays first so non-QWERTY layouts keep their letters.
 */
function baseCharacter(e: KeyboardEvent, mods: KeyModifiers): string {
  if (!(mods.ctrl || mods.alt) || /^[ -~]$/.test(e.key)) return e.key;
  const letter = /^Key([A-Z])$/.exec(e.code ?? "");
  if (letter) return mods.shift ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(e.code ?? "");
  if (digit && !mods.shift) return digit[1];
  return e.key;
}

function captureCharacter(
  char: string,
  mods: KeyModifiers
): CapturedKey | null {
  const isLetter = /^[a-z]$/i.test(char);
  const upper = char.toUpperCase();

  if (mods.ctrl) {
    if (isLetter) {
      if (mods.shift) {
        return {
          sequence: csiU(upper.toLowerCase().charCodeAt(0), mods),
          humanLabel: formatLabel(mods, upper),
        };
      }
      const byte = hexByte(upper.charCodeAt(0) - 64);
      return {
        sequence: mods.alt ? `${ESC}${byte}` : byte,
        humanLabel: formatLabel(mods, upper),
      };
    }
    const byte = CTRL_SYMBOL_BYTES[char];
    if (byte === undefined) return null;
    const ctrlMods = { ctrl: true, alt: mods.alt, shift: false };
    return {
      sequence: mods.alt ? `${ESC}${hexByte(byte)}` : hexByte(byte),
      humanLabel: formatLabel(ctrlMods, CTRL_SYMBOL_NAMES[byte]),
    };
  }

  // Shift is already folded into the character ("A", "!"), so it is labelled
  // only where it is not visible in the character itself.
  const shownMods = {
    ctrl: false,
    alt: mods.alt,
    shift: mods.shift && isLetter,
  };
  const keyName = isLetter ? upper : char;
  if (mods.alt) {
    return {
      sequence: `${ESC}${encodeChar(char)}`,
      humanLabel: formatLabel(shownMods, keyName),
    };
  }
  return { sequence: encodeChar(char), humanLabel: char };
}

/**
 * The terminal sequence for a key press, or `null` when the press is a bare
 * modifier or cannot be sent to a terminal (any Meta/Cmd/Windows-key
 * combination — terminals have no encoding for it, and the OS usually
 * swallows the Windows key first).
 */
export function keyEventToCapture(e: KeyboardEvent): CapturedKey | null {
  if (NON_CAPTURABLE_KEYS.has(e.key) || e.metaKey) return null;

  const mods: KeyModifiers = {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  };
  const param = modifierParam(mods);

  const finalKey = CSI_FINAL_KEYS[e.key];
  if (finalKey) {
    const plainPrefix = finalKey.ss3 ? `${ESC}O` : `${ESC}[`;
    return {
      sequence: hasModifier(mods)
        ? `${ESC}[1;${param}${finalKey.final}`
        : `${plainPrefix}${finalKey.final}`,
      humanLabel: formatLabel(mods, finalKey.name),
    };
  }

  const tildeKey = CSI_TILDE_KEYS[e.key];
  if (tildeKey) {
    return {
      sequence: hasModifier(mods)
        ? `${ESC}[${tildeKey.n};${param}~`
        : `${ESC}[${tildeKey.n}~`,
      humanLabel: formatLabel(mods, tildeKey.name),
    };
  }

  const uKey = CSI_U_KEYS[e.key];
  if (uKey) {
    return {
      sequence: legacyOrCsiU(uKey, mods),
      humanLabel: formatLabel(mods, uKey.name),
    };
  }

  const char = baseCharacter(e, mods);
  if (char.length !== 1) return null;
  return captureCharacter(char, mods);
}

function legacyOrCsiU(
  key: (typeof CSI_U_KEYS)[string],
  mods: KeyModifiers
): string {
  if (!hasModifier(mods)) return key.plain;
  if (key.codepoint === CSI_U_KEYS.Tab.codepoint && isOnly(mods, "shift"))
    return `${ESC}[Z`;
  if (isOnly(mods, "alt")) return `${ESC}${key.plain}`;
  if (key.ctrl && mods.ctrl && !mods.shift)
    return mods.alt ? `${ESC}${key.ctrl}` : key.ctrl;
  return csiU(key.codepoint, mods);
}

const CSI_FINAL_BY_CHAR = new Map(
  Object.values(CSI_FINAL_KEYS).map((key) => [key.final, key.name])
);
const CSI_TILDE_BY_NUMBER = new Map(
  Object.values(CSI_TILDE_KEYS).map((key) => [key.n, key.name])
);
const CSI_U_BY_CODEPOINT = new Map(
  Object.values(CSI_U_KEYS).map((key) => [key.codepoint, key.name])
);
const LEGACY_KEY_NAMES = new Map(
  Object.values(CSI_U_KEYS).map((key) => [key.plain, key.name])
);

/** Labels one key unit (no ESC prefix) of a legacy sequence. */
function legacyUnitLabel(unit: string, alt: boolean): string | null {
  const named = LEGACY_KEY_NAMES.get(unit);
  if (named) return formatLabel({ ctrl: false, alt, shift: false }, named);

  const control = /^\\x([01][0-9a-fA-F])$/.exec(unit);
  if (control) {
    const byte = Number.parseInt(control[1], 16);
    const keyName =
      byte >= 1 && byte <= 26
        ? String.fromCharCode(byte + 64)
        : CTRL_SYMBOL_NAMES[byte];
    return keyName
      ? formatLabel({ ctrl: true, alt, shift: false }, keyName)
      : null;
  }

  const char = unit === "\\\\" ? "\\" : unit;
  if (char.length !== 1 || char < " " || char > "~") return null;
  if (!alt) return char;
  const isUpper = /^[A-Z]$/.test(char);
  return formatLabel(
    { ctrl: false, alt: true, shift: isUpper },
    char.toUpperCase()
  );
}

/** The human label for a stored sequence, or `null` when it is not a single recognized key. */
export function sequenceToHumanLabel(sequence: string): string | null {
  if (!sequence) return null;
  if (sequence === ESC) return CSI_U_KEYS.Escape.name;
  if (sequence === `${ESC}[Z`) return "Shift+Tab";

  const plainFinal = /^\\x1b(\[|O)([A-Z])$/.exec(sequence);
  if (plainFinal) return CSI_FINAL_BY_CHAR.get(plainFinal[2]) ?? null;

  const modFinal = /^\\x1b\[1;(\d+)([A-Z])$/.exec(sequence);
  if (modFinal) {
    const name = CSI_FINAL_BY_CHAR.get(modFinal[2]);
    return name
      ? formatLabel(modifiersFromParam(Number(modFinal[1])), name)
      : null;
  }

  const tilde = /^\\x1b\[(\d+)(?:;(\d+))?~$/.exec(sequence);
  if (tilde) {
    const name = CSI_TILDE_BY_NUMBER.get(Number(tilde[1]));
    if (!name) return null;
    return tilde[2]
      ? formatLabel(modifiersFromParam(Number(tilde[2])), name)
      : name;
  }

  const u = /^\\x1b\[(\d+);(\d+)u$/.exec(sequence);
  if (u) {
    const codepoint = Number(u[1]);
    const name =
      CSI_U_BY_CODEPOINT.get(codepoint) ??
      (codepoint > 32 && codepoint < 127
        ? String.fromCharCode(codepoint).toUpperCase()
        : null);
    return name ? formatLabel(modifiersFromParam(Number(u[2])), name) : null;
  }

  if (sequence.startsWith(ESC) && sequence.length > ESC.length) {
    return legacyUnitLabel(sequence.slice(ESC.length), true);
  }
  return legacyUnitLabel(sequence, false);
}
