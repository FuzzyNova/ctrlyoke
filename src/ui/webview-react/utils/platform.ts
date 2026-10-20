import {
  PICKER_SHORTCUT_BINDINGS,
  UI_PLATFORMS,
  type PickerShortcutTarget,
  type UiPlatform,
} from "@root/types/DashboardConstants";

/** Friendly host-OS tag detected client-side from `navigator`. Single source for
 * this check — do not re-implement `navigator.platform`/`navigator.userAgent`
 * sniffing locally. */
export function detectPlatform(): UiPlatform {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) {
    return UI_PLATFORMS.WINDOWS;
  }
  if (platform.includes("mac")) {
    return UI_PLATFORMS.MAC;
  }
  return UI_PLATFORMS.LINUX;
}

/** True on iPhone/iPod/iPad, including iPadOS Safari, which reports itself as
 * desktop macOS ("MacIntel") but has a touch screen. Every iOS browser is
 * WebKit underneath, so this also identifies iOS WebKit behavior. */
export function isIosDevice(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

const MAC_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Ctrl: "Cmd",
  Alt: "Option",
};

/**
 * Joins modifier/key parts into a shortcut label, swapping "Ctrl" for "Cmd"
 * and "Alt" for "Option" on macOS. Only use this for shortcuts whose handler
 * actually checks `e.ctrlKey || e.metaKey` (so Cmd genuinely triggers the
 * action there) — it must NOT be applied to the deliberately-literal-Ctrl Run/Queue shortcuts
 * (see dev/reference/KEYBOARD_SHORTCUTS.md) or to terminal control-key
 * labels in `TerminalControlBarEditor.tsx`, which represent PTY byte
 * sequences that stay literal Ctrl on every OS. "Alt" is always safe to pass:
 * `e.altKey` is the Option key on macOS.
 */
export function formatShortcut(...parts: string[]): string {
  const isMac = detectPlatform() === UI_PLATFORMS.MAC;
  return parts
    .map((part) => (isMac ? (MAC_MODIFIER_LABELS[part] ?? part) : part))
    .join("+");
}

/** Label for a picker shortcut, e.g. "Alt+Shift+M" ("Option+Shift+M" on macOS). */
export function formatPickerShortcut(target: PickerShortcutTarget): string {
  const { shift, letter } = PICKER_SHORTCUT_BINDINGS[target];
  return formatShortcut("Alt", ...(shift ? ["Shift"] : []), letter);
}

/** Append a picker's shortcut to its tooltip as a final paragraph. */
export function withPickerShortcutHint(
  title: string | undefined,
  target: PickerShortcutTarget | undefined
): string | undefined {
  if (!target) return title;
  const hint = `Shortcut: ${formatPickerShortcut(target)}`;
  return title ? `${title}\n\n${hint}` : hint;
}
