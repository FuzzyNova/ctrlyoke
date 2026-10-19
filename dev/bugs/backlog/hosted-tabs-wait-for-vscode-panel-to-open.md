# Hosted dashboard tabs sit on "Loading ctrlyoke…" until the VS Code panel is opened

- **Found:** 2026-10-18 by Claude Code (media capture automation, phase 1)
- **Area:** `src/ui/WebviewMessageRouter.ts`, `src/core/WorkflowOrchestrator.ts`
- **Severity:** medium

## Symptom

In the VS Code host, a hosted dashboard tab shows the "Loading ctrlyoke…" startup overlay until
something opens the ctrlyoke panel in VS Code. If the panel stays closed, the overlay only
clears after its 45 s safety timeout (`STARTUP_TIMEOUT_MS` in
`src/ui/webview-react/components/layout/StartupOverlay.tsx`), and STARTUP_COMPLETE never arrives.
A user with `server.autoStart` on who keeps the panel closed, or who opens the dashboard from
their phone, waits 45 s and gets a dashboard whose startup never ran.

## Steps to Reproduce

1. Open a workspace with an initialized `.ctrlyoke/` and `server.autoStart: true` in a fresh
   VS Code profile, where the ctrlyoke view in the secondary side bar is not visible
   (`npm run dev:host:start:onboarding`-style isolation, minus the onboarding reset).
2. Open the hosted dashboard URL in a browser.
3. The overlay stays up. The session log shows `WebSocket READY clientId=browser:…` but no
   STARTUP_COMPLETE for that client.
4. Run `ctrlyoke.dashboard.focus` in VS Code: the tab finishes startup within a second.

## Root Cause

The startup auto-load only starts when the VS Code panel sends READY:
`WebviewMessageRouter` calls `orchestrator.setDashboardReady(ctx.postMessage)` only for
`PANEL_CLIENT_ID`. A browser READY runs `completeBrowserReadyAfterStartup()`
(`src/ui/WebviewMessageRouter.ts:479`), which awaits `orchestrator.awaitStartupAutoLoad()`, so it
waits for a panel that may never load. The standalone host avoids this by calling
`setDashboardReady()` itself (`src/platform/NodeHostServices.ts:345`), because it has no panel.
The comment at the browser READY site explains why browser READY can't simply trigger startup:
during extension reloads a browser READY can arrive before the panel's.

## Suggested Fix

Let startup proceed without the panel when no panel is coming: for example, after
`initialize()` settles and the panel's view hasn't resolved within a short grace period, call
`setDashboardReady()` without a panel send function, as the standalone host does. Then a panel
that opens later takes the existing "auto-load already settled" fast path. The media capture
host works around this with `media/vscode-helper/`, which runs `ctrlyoke.dashboard.focus` at
startup. Remove that helper once this is fixed.
