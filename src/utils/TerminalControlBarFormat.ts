import type { TerminalMobileBarLayout } from "../types/CtrlYokeSettings";

/** Closed vocabulary of primary terminal keys. */
export const TERMINAL_BAR_KEY_IDS = {
  ESC: "key:esc",
  TAB: "key:tab",
  UP: "key:up",
  DOWN: "key:down",
  LEFT: "key:left",
  RIGHT: "key:right",
  ENTER: "key:enter",
} as const;

export type TerminalBarKeyId =
  (typeof TERMINAL_BAR_KEY_IDS)[keyof typeof TERMINAL_BAR_KEY_IDS];

/** Closed vocabulary of built-in terminal shortcuts. */
export const TERMINAL_BAR_SHORTCUT_IDS = {
  SHIFT_TAB: "shortcut:shift-tab",
  CTRL_C: "shortcut:ctrl-c",
  CTRL_Z: "shortcut:ctrl-z",
  CTRL_L: "shortcut:ctrl-l",
  CTRL_R: "shortcut:ctrl-r",
  CTRL_A: "shortcut:ctrl-a",
} as const;

export type TerminalBarShortcutId =
  (typeof TERMINAL_BAR_SHORTCUT_IDS)[keyof typeof TERMINAL_BAR_SHORTCUT_IDS];

/** The modifier toggle is a bar control, not a fixed-sequence shortcut. */
export const TERMINAL_BAR_CTRL_ID = "modifier:ctrl";

export type TerminalBarRegistryId = TerminalBarKeyId | TerminalBarShortcutId;

/** Metadata shared by the runtime bar and its settings editor. */
export const TERMINAL_BAR_ITEM_REGISTRY = {
  [TERMINAL_BAR_KEY_IDS.ESC]: { label: "Esc", sequence: "\x1b" },
  [TERMINAL_BAR_KEY_IDS.TAB]: { label: "Tab", sequence: "\x09" },
  [TERMINAL_BAR_KEY_IDS.UP]: {
    label: "Up",
    glyph: "↑",
    sequence: "\x1b[A",
  },
  [TERMINAL_BAR_KEY_IDS.DOWN]: {
    label: "Down",
    glyph: "↓",
    sequence: "\x1b[B",
  },
  [TERMINAL_BAR_KEY_IDS.LEFT]: {
    label: "Left",
    glyph: "←",
    sequence: "\x1b[D",
  },
  [TERMINAL_BAR_KEY_IDS.RIGHT]: {
    label: "Right",
    glyph: "→",
    sequence: "\x1b[C",
  },
  [TERMINAL_BAR_KEY_IDS.ENTER]: {
    label: "Enter",
    glyph: "⏎",
    sequence: "\r",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.SHIFT_TAB]: {
    label: "Shift+Tab",
    sequence: "\x1b[Z",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C]: {
    label: "Ctrl+C",
    sequence: "\x03",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.CTRL_Z]: {
    label: "Ctrl+Z",
    sequence: "\x1a",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.CTRL_L]: {
    label: "Ctrl+L",
    sequence: "\x0c",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.CTRL_R]: {
    label: "Ctrl+R",
    sequence: "\x12",
  },
  [TERMINAL_BAR_SHORTCUT_IDS.CTRL_A]: {
    label: "Ctrl+A",
    sequence: "\x01",
  },
} as const satisfies Record<
  TerminalBarRegistryId,
  { label: string; glyph?: string; sequence: string; description?: string }
>;

/** The default layout preserves the current control-bar order and placement. */
export const DEFAULT_TERMINAL_BAR_LAYOUT = {
  bar: [
    TERMINAL_BAR_CTRL_ID,
    TERMINAL_BAR_KEY_IDS.ESC,
    TERMINAL_BAR_KEY_IDS.TAB,
    TERMINAL_BAR_KEY_IDS.UP,
    TERMINAL_BAR_KEY_IDS.DOWN,
    TERMINAL_BAR_KEY_IDS.LEFT,
    TERMINAL_BAR_KEY_IDS.RIGHT,
    TERMINAL_BAR_KEY_IDS.ENTER,
  ],
  popup: [
    TERMINAL_BAR_SHORTCUT_IDS.SHIFT_TAB,
    TERMINAL_BAR_SHORTCUT_IDS.CTRL_C,
    TERMINAL_BAR_SHORTCUT_IDS.CTRL_Z,
    TERMINAL_BAR_SHORTCUT_IDS.CTRL_L,
    TERMINAL_BAR_SHORTCUT_IDS.CTRL_R,
    TERMINAL_BAR_SHORTCUT_IDS.CTRL_A,
  ],
  hidden: [],
} as const satisfies {
  readonly bar: readonly string[];
  readonly popup: readonly string[];
  readonly hidden: readonly string[];
};

/**
 * Remove stale ids and reconcile ids introduced before this layout was saved.
 * The returned layout is a new value and the input is never mutated.
 */
export function reconcileTerminalBarLayout(
  layout: TerminalMobileBarLayout,
  knownCustomShortcutIds: readonly string[]
): TerminalMobileBarLayout {
  const knownIds = new Set<string>([
    ...Object.keys(TERMINAL_BAR_ITEM_REGISTRY),
    ...knownCustomShortcutIds,
    TERMINAL_BAR_CTRL_ID,
  ]);
  const isKnownId = (id: string): boolean => knownIds.has(id);
  const filterKnownIds = (ids: readonly string[]): string[] =>
    ids.filter(isKnownId);

  const bar = filterKnownIds(layout.bar);
  const popup = filterKnownIds(layout.popup);
  const hidden = filterKnownIds(layout.hidden);

  if (popup.includes(TERMINAL_BAR_CTRL_ID)) {
    bar.push(TERMINAL_BAR_CTRL_ID);
    for (let index = popup.length - 1; index >= 0; index -= 1) {
      if (popup[index] === TERMINAL_BAR_CTRL_ID) {
        popup.splice(index, 1);
      }
    }
  }

  if (
    !bar.includes(TERMINAL_BAR_CTRL_ID) &&
    !hidden.includes(TERMINAL_BAR_CTRL_ID)
  ) {
    bar.unshift(TERMINAL_BAR_CTRL_ID);
  }

  const presentIds = new Set([...bar, ...popup, ...hidden]);
  for (const id of knownIds) {
    if (!presentIds.has(id)) {
      popup.push(id);
    }
  }

  return { bar, popup, hidden };
}
