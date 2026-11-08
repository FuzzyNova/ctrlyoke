import { describe, expect, it } from "vitest";
import {
  keyEventToCapture,
  sequenceToHumanLabel,
} from "@utils/terminalKeyCapture";

interface PressInit {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

function press(init: PressInit) {
  return keyEventToCapture(new KeyboardEvent("keydown", init));
}

describe("keyEventToCapture", () => {
  it.each<[string, PressInit, string, string]>([
    [
      "Shift+Enter",
      { key: "Enter", shiftKey: true },
      "\\x1b[13;2u",
      "Shift+Enter",
    ],
    [
      "Ctrl+Enter",
      { key: "Enter", ctrlKey: true },
      "\\x1b[13;5u",
      "Ctrl+Enter",
    ],
    ["Alt+Enter", { key: "Enter", altKey: true }, "\\x1b\\r", "Alt+Enter"],
    ["Enter", { key: "Enter" }, "\\r", "Enter"],
    ["Shift+Tab", { key: "Tab", shiftKey: true }, "\\x1b[Z", "Shift+Tab"],
    ["Ctrl+Tab", { key: "Tab", ctrlKey: true }, "\\x1b[9;5u", "Ctrl+Tab"],
    [
      "Ctrl+Backspace",
      { key: "Backspace", ctrlKey: true },
      "\\x08",
      "Ctrl+Backspace",
    ],
    [
      "Alt+Backspace",
      { key: "Backspace", altKey: true },
      "\\x1b\\x7f",
      "Alt+Backspace",
    ],
    [
      "Shift+Backspace",
      { key: "Backspace", shiftKey: true },
      "\\x1b[127;2u",
      "Shift+Backspace",
    ],
    [
      "Ctrl+Space",
      { key: " ", code: "Space", ctrlKey: true },
      "\\x00",
      "Ctrl+Space",
    ],
    ["Ctrl+C", { key: "c", code: "KeyC", ctrlKey: true }, "\\x03", "Ctrl+C"],
    [
      "Ctrl+Shift+C",
      { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true },
      "\\x1b[99;6u",
      "Ctrl+Shift+C",
    ],
    [
      "Ctrl+Alt+V",
      { key: "v", code: "KeyV", ctrlKey: true, altKey: true },
      "\\x1b\\x16",
      "Ctrl+Alt+V",
    ],
    [
      "Ctrl+]",
      { key: "]", code: "BracketRight", ctrlKey: true },
      "\\x1d",
      "Ctrl+]",
    ],
    [
      "Ctrl+\\",
      { key: "\\", code: "Backslash", ctrlKey: true },
      "\\x1c",
      "Ctrl+\\",
    ],
    ["Alt+B", { key: "b", code: "KeyB", altKey: true }, "\\x1bb", "Alt+B"],
    [
      "Alt+Shift+B",
      { key: "B", code: "KeyB", altKey: true, shiftKey: true },
      "\\x1bB",
      "Alt+Shift+B",
    ],
    [
      "macOS Option+M",
      { key: "µ", code: "KeyM", altKey: true },
      "\\x1bm",
      "Alt+M",
    ],
    ["Shift+↑", { key: "ArrowUp", shiftKey: true }, "\\x1b[1;2A", "Shift+↑"],
    ["Shift+Home", { key: "Home", shiftKey: true }, "\\x1b[1;2H", "Shift+Home"],
    ["Ctrl+End", { key: "End", ctrlKey: true }, "\\x1b[1;5F", "Ctrl+End"],
    [
      "Shift+PgUp",
      { key: "PageUp", shiftKey: true },
      "\\x1b[5;2~",
      "Shift+PgUp",
    ],
    ["F1", { key: "F1" }, "\\x1bOP", "F1"],
    ["Shift+F1", { key: "F1", shiftKey: true }, "\\x1b[1;2P", "Shift+F1"],
    ["F5", { key: "F5" }, "\\x1b[15~", "F5"],
    ["Ctrl+F12", { key: "F12", ctrlKey: true }, "\\x1b[24;5~", "Ctrl+F12"],
    ["backslash", { key: "\\" }, "\\\\", "\\"],
  ])("captures %s", (_name, init, sequence, humanLabel) => {
    expect(press(init)).toEqual({ sequence, humanLabel });
  });

  it.each<[string, PressInit]>([
    ["a bare Shift", { key: "Shift", shiftKey: true }],
    ["a bare Control", { key: "Control", ctrlKey: true }],
    [
      "Meta/Cmd/Windows combinations",
      { key: "c", code: "KeyC", metaKey: true },
    ],
    ["a dead key", { key: "Dead" }],
  ])("ignores %s", (_name, init) => {
    expect(press(init)).toBeNull();
  });

  it("keeps non-QWERTY letters from event.key under Ctrl", () => {
    // AZERTY: the A key sits where QWERTY has Q.
    expect(press({ key: "a", code: "KeyQ", ctrlKey: true })?.humanLabel).toBe(
      "Ctrl+A"
    );
  });
});

describe("sequenceToHumanLabel", () => {
  it.each([
    ["\\x1b[13;2u", "Shift+Enter"],
    ["\\x1b[99;6u", "Ctrl+Shift+C"],
    ["\\x1b\\r", "Alt+Enter"],
    ["\\x1b[1;5A", "Ctrl+↑"],
    ["\\x1b[3;2~", "Shift+Del"],
    ["\\x1bOP", "F1"],
    ["\\x1b[24;5~", "Ctrl+F12"],
    ["\\x1b\\x16", "Ctrl+Alt+V"],
    ["\\x1b", "Esc"],
    ["\\x7f", "Backspace"],
  ])("labels %s as %s", (sequence, label) => {
    expect(sequenceToHumanLabel(sequence)).toBe(label);
  });

  it("returns null for sequences that are not a single key", () => {
    expect(sequenceToHumanLabel("hello")).toBeNull();
    expect(sequenceToHumanLabel("\\x1b[999~")).toBeNull();
  });

  it("labels every captured sequence the same way capture did", () => {
    // Ctrl+Backspace and Ctrl+[ share bytes with Ctrl+H and Esc, so the
    // stored sequence alone cannot tell them apart.
    const presses: PressInit[] = [
      { key: "Enter", shiftKey: true },
      { key: "Enter", altKey: true, ctrlKey: true },
      { key: "Tab", ctrlKey: true, shiftKey: true },
      { key: " ", shiftKey: true },
      { key: "x", code: "KeyX", ctrlKey: true },
      { key: "X", code: "KeyX", ctrlKey: true, altKey: true, shiftKey: true },
      { key: "!", code: "Digit1", altKey: true, shiftKey: true },
      { key: "ArrowLeft", ctrlKey: true, altKey: true },
      { key: "Insert", shiftKey: true },
      { key: "F4", altKey: true },
      { key: "F9" },
      { key: "^", code: "Digit6", ctrlKey: true, shiftKey: true },
    ];
    for (const init of presses) {
      const captured = press(init);
      expect(captured, JSON.stringify(init)).not.toBeNull();
      expect(sequenceToHumanLabel(captured!.sequence)).toBe(
        captured!.humanLabel
      );
    }
  });
});
