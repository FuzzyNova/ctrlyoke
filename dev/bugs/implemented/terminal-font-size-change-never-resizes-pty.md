# Changing the terminal font size never resizes the PTY

- **Found:** 2026-10-11 by Claude while trying to capture the D13 terminal screenshot
- **Area:** `src/ui/webview-react/terminalRegistry.ts`, `src/ui/webview-react/components/output/TerminalInstance.tsx`
- **Resolution:** fixed in this commit

## Symptom

After the **-** / **+** terminal font-size buttons (or a terminal-settings change such as line
height), xterm shows a different column and row count, but the harness or shell behind it keeps
drawing at the old size until something else resizes the container. On the controlling client
the session log shows the gap directly. Lowering the font from 14 to 12 refit xterm locally to
122 columns while the PTY stayed at 108×26. The next real resize then logged
`TERMINAL_RESIZE (resize-observer) … previous=122x32`, and the PTY jumped from `108x26` to
`117x32`.

A viewer was also affected: the same refit dropped its lock on the controller's column count.

## Steps to Reproduce

1. Run an interactive step so a harness TUI is in the Terminal tab.
2. Click the terminal font **-** button twice.
3. The TUI keeps wrapping at the old width (lines end early, or run past the pane when the font
   grows) until the window or panel is resized.

## Root Cause

`terminalRegistry.updateFontSize` and `updateTerminalOptions` applied the new option and then
called `entry.fitAddon.fit()` on every entry. That changes xterm's grid locally, and two things
were missing:

- Only `TerminalInstance.syncControllerTerminalSize` sends `TERMINAL_RESIZE`, and it runs from
  the container `ResizeObserver` and visibility refreshes. A font change doesn't resize the
  container, so the PTY was never told.
- `fitAddon.fit()` ignores `entry.controllerCols`, so a viewer was refit to its own columns
  instead of mirroring the controller.

## Fix

The registry now refits each rendered entry through `fitRegistryEntry` in its own mode (viewers
keep the controller's grid). It skips detached or collapsed entries, which refit when they are
shown again. Then it notifies `onMetricsChanged` subscribers. Each mounted `TerminalInstance`
subscribes, and a controller calls `syncControllerTerminalSize("metrics-changed",
{ forceResize: true })`, so the PTY gets the new size. Tests are in `terminalRegistry.test.ts`.

## Related findings (not bugs in ctrlyoke)

- **The clipped Claude TUI in the D13 capture attempt was a Playwright artifact.** In headless
  Chromium with an emulated `deviceScaleFactor` of 1.25 or 2, the WebGL renderer draws the
  terminal about DPR× too large: text runs off the right edge, the top row hides under the
  toolbar, and the canvas stops repainting. At `deviceScaleFactor: 1` the same shell renders
  correctly. Capture terminal shots at scale 1.
- When a terminal opens, the first fit runs before the WebGL addon has loaded and measures
  unrounded DOM cell widths. About 20 ms later WebGL's device-pixel-floored cells give a few more
  columns (101 → 108 at 14 px, 118 → 122 at 12 px, at 125 % scaling). So the PTY gets two
  resizes right after spawn. That is harmless today. If a harness ever draws its first frame in
  that window, fitting once more after `ensureWebglAddonLoaded` resolves would remove it.
