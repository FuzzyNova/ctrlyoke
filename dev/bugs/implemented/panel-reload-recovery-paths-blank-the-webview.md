# Panel recovery paths that call `location.reload()` blank the webview

- **Found:** 2026-10-14 by Claude, while fixing `panel-blank-after-handshake-watchdog-reload.md`
- **Area:** `src/ui/webview-react/hooks/reconnectWatchdog.ts`, `src/ui/webview-react/scripts/moduleLoaderScript.ts`
- **Resolution:** fixed in this commit

## Symptom

When either recovery path fires in the VS Code panel, the panel goes blank and stays blank, which
is worse than the stuck state it was meant to repair.

## Steps to Reproduce

1. Restart the extension host while VS Code keeps the panel's iframe. If the panel never gets
   `CLIENT_ID_ASSIGNED` after `RECONNECT`, `reconnectWatchdog` reloads it 1.5 s later.
2. Or make the Vite bundle fail to mount within 30 s. The module-mount watchdog in
   `moduleLoaderScript.ts` reloads the panel.
3. Either way, the panel is blank afterwards.

## Root Cause

`window.location.reload()` does not work in a VS Code webview. VS Code navigates the content
iframe to its empty `pre/fake.html` and `document.write()`s the dashboard HTML into it, hooking
only that first navigation (see `onFrameLoaded` in VS Code's
`out/vs/workbench/contrib/webview/browser/pre/index.html`). A reload loads the empty
`fake.html` again, and nothing writes the dashboard back in. The existing comments blame the
"raw HTML" symptom on `acquireVsCodeApi()` being called twice. That may also happen, but even
without it the reload cannot restore the page.

## Suggested Fix

Replace both reloads with a recovery the extension owns. The panel posts a message such as
`PANEL_RELOAD_REQUEST`, and `CtrlYokeWebviewProvider` resets `panelReady`/`readyPageLoadId` and
reassigns `webview.html`. `ui.instructions.md` warns against reassigning `webview.html` during
reconnect, because doing it while the first load was still in flight caused raw-HTML
regressions. A request from a page that has already mounted (or has given up for 30 s) is not
that case, but verify it in the dev host before relying on it. For the retained-context
reconnect, a READY retry under a fresh `pageLoadId` (as the handshake watchdog now does) may be
enough on its own.

## Resolution

No panel code calls `location.reload()` any more.

- **Reconnect watchdog:** this page is still alive, so it re-runs the handshake in place.
  `reconnectWatchdog.ts` calls `retryPanelHandshake()` (`hooks/panelHandshake.ts`), which re-sends
  READY under a derived `pageLoadId`. The HTML handshake watchdog uses the same function.
- **Module-mount watchdog:** React never mounted, so the page itself is broken. The watchdog posts
  `PANEL_RELOAD_REQUEST`, and `CtrlYokeWebviewProvider.rebuildPanelHtml` resets
  `panelReady`/`readyPageLoadId` and reassigns `webview.html`; the fresh nonce guarantees a new
  document. The provider allows two rebuilds until a READY is accepted, so a bundle that can never
  mount cannot rebuild the panel in a loop.

The rebuild was not exercised in a live dev host; `CtrlYokeWebviewProviderPanelRebuild.test.ts`
covers the provider side with a fake `WebviewView`.
