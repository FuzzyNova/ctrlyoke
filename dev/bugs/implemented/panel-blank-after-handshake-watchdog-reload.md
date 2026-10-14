# Panel goes permanently blank after the handshake watchdog reloads it

- **Found:** 2026-10-14 by the user, diagnosed by Claude
- **Area:** `src/ui/webview-react/BootstrapApp.tsx`, `src/ui/webview-react/scripts/moduleLoaderScript.ts`
- **Resolution:** fixed in this commit

## Symptom

Sometimes, about 20 seconds after the VS Code panel loads, the dashboard goes completely blank and
never comes back. The session log always ends with:

```
WARN: [panel] [bootstrap] [moduleLoader] handshake watchdog fired after React mount without CLIENT_ID_ASSIGNED; reloading panel
```

and no further `[panel]` line is written until the extension deactivates.

## Steps to Reproduce

Intermittent. It happens when the extension answers BootstrapApp's early `READY` before the panel
has finished lazy-importing `App` (a busy panel or a fast extension host makes it more likely).

1. Open the panel.
2. The extension handles the first `READY` and posts `INIT` and `CLIENT_ID_ASSIGNED`.
3. `App` mounts after that; its own `READY` is logged as `Ignoring duplicate panel READY for the current webview`.
4. 20 s later the handshake watchdog fires and the panel goes blank.

## Root Cause

Two defects combine.

1. **Lost handshake.** `BootstrapApp` posts `READY` before it imports `App`. The only full
   message listener is `useMessageHandler`, which `App` mounts. VS Code buffers `postMessage`
   only until the iframe loads, not until a listener exists, so replies that arrive in that
   window are dropped. Since `9dc6b43c6` the extension discards `App`'s second `READY` as an
   in-page duplicate (same `pageLoadId`), so nothing re-sends `CLIENT_ID_ASSIGNED` and
   `__ctrlyokePanelHandshakeDone` never becomes true.
2. **Destructive recovery.** The watchdog then called `window.location.reload()`. A VS Code
   webview's content iframe is navigated to VS Code's empty `pre/fake.html`, and the dashboard
   HTML is `document.write()`n into it. VS Code hooks the load only for that first navigation, so
   a reload loads the empty `fake.html` and nothing writes the dashboard back in. The panel stays
   blank until the view is disposed and resolved again.

## Fix

- `hooks/panelInboundBuffer.ts` buffers inbound panel messages from just before BootstrapApp's
  `READY` until `useMessageHandler` attaches, and the hook replays them in order. The standalone
  shim already buffered this way, so the buffer is panel-only.
- The handshake watchdog no longer reloads. It calls `window.__ctrlyokeRetryPanelHandshake`,
  which BootstrapApp installs. That function re-sends `READY` under a derived `pageLoadId`, so the
  extension runs the full handshake again instead of discarding it as a duplicate.

The other two `location.reload()` recovery paths have the same blank-panel problem and are
fixed alongside this one; see `dev/bugs/implemented/panel-reload-recovery-paths-blank-the-webview.md`.
