/**
 * Recognizes terminal input that xterm.js sends on its own rather than because
 * a person typed or clicked.
 *
 * A harness TUI queries the terminal at startup and while running (cursor
 * position, device attributes, colors, mode and keyboard-protocol state), and
 * xterm answers through the same `onData` stream as keystrokes. A TUI with
 * focus tracking on also gets focus-in/out reports whenever the dashboard
 * window gains or loses focus, which happens when someone walks away. None of
 * that means a person is using the terminal, so callers that need to know
 * whether the controller is actually present use this to ignore it.
 *
 * Covered replies: CPR and DSR (`ESC [ … R` / `n`), primary and secondary DA
 * (`ESC [ ? … c`, `ESC [ > … c`), window reports (`ESC [ … t`), DECRPM
 * (`ESC [ ? … $ y`), kitty keyboard flags (`ESC [ ? … u`), focus reports
 * (`ESC [ I` / `ESC [ O`), OSC replies (color queries) and DCS replies
 * (DECRQSS, XTGETTCAP, XTVERSION).
 */
const TERMINAL_AUTO_RESPONSE_PATTERN = new RegExp(
  "^(?:" +
    [
      "\\x1b\\[[?>]?[\\d;]*(?:R|n|c|t|\\$y)",
      "\\x1b\\[\\?[\\d;]*u",
      "\\x1b\\[[IO]",
      "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
      "\\x1bP[^\\x1b]*\\x1b\\\\",
    ].join("|") +
    ")+$"
);

/** True when `data` consists only of xterm's automatic replies to the TUI. */
export function isTerminalAutoResponse(data: string): boolean {
  return TERMINAL_AUTO_RESPONSE_PATTERN.test(data);
}
