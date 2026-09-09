import { UI_PLATFORMS, type UiPlatform } from "@root/types/DashboardConstants";

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

/**
 * Joins modifier/key parts into a shortcut label, swapping "Ctrl" for "Cmd"
 * on macOS. Only use this for shortcuts whose handler actually checks
 * `e.ctrlKey || e.metaKey` (so Cmd genuinely triggers the action there) —
 * it must NOT be applied to the deliberately-literal-Ctrl Run/Queue shortcuts
 * (see dev/reference/KEYBOARD_SHORTCUTS.md) or to terminal control-key
 * labels in `TerminalControlBarEditor.tsx`, which represent PTY byte
 * sequences that stay literal Ctrl on every OS.
 */
export function formatShortcut(...parts: string[]): string {
  const isMac = detectPlatform() === UI_PLATFORMS.MAC;
  return parts
    .map((part) => (isMac && part === "Ctrl" ? "Cmd" : part))
    .join("+");
}
