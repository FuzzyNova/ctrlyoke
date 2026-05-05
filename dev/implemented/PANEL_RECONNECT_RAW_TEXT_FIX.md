# Panel Reconnect Raw Text Fix

## Bug

When both the hosted browser dashboard and the VS Code panel were open, running the developer rebuild/reload flow could leave the VS Code panel in a broken state:

- the panel sometimes showed raw text/HTML instead of the React app
- the browser often reconnected first
- the panel `READY` handshake was delayed or never completed
- repeated `RECONNECT` nudges from the extension made the failure worse

The issue was intermittent at first, then became reproducible when both clients were active during extension reload.

## Root Cause

There were two overlapping problems.

### 1. Missing visibility during panel startup

Early failures happened before normal React-side `WebviewLog` messages were available, so the session log only showed extension-side `RECONNECT` attempts. That hid whether the panel failed in:

- `acquireVsCodeApi()`
- module import
- React entry
- the `READY` handshake

To diagnose that path, we added injected bootstrap/module-loader logging plus page lifecycle logging.

### 2. Browser `READY` deadlocked panel `READY`

The real logic bug was in `WebviewMessageRouter`.

The browser client's `READY` handler ran on the shared serialized `routeQueue` and then awaited startup auto-load completion:

- browser `READY` entered first
- browser `READY` awaited `awaitStartupAutoLoad()`
- startup auto-load required the panel `READY` path to reach `setDashboardReady()`
- panel `READY` could not run because it was queued behind the browser `READY` handler

That created a startup deadlock:

- browser `READY` held the queue
- panel `READY` stayed queued
- extension-side `RECONNECT` retries kept firing
- the panel re-sent `READY` multiple times
- the panel could drift into the raw-text failure state

## Fix

### Logging / diagnostics

Added startup instrumentation in:

- `src/ui/webview-react/scripts/bootstrapScript.ts`
- `src/ui/webview-react/scripts/moduleLoaderScript.ts`
- `src/ui/webview-react/main.tsx`
- `src/ui/webview-react/BootstrapApp.tsx`
- `src/ui/webview-react/utils/logger.ts`
- `src/ui/webview-react/hooks/useVsCodeApi.ts`
- `src/ui/FlightPathWebviewProvider.ts`
- `src/ui/WebviewMessageRouter.ts`

This covered:

- early bootstrap logging before React mounts
- `window.error` and `unhandledrejection`
- module-loader progress and watchdogs
- page lifecycle events (`DOMContentLoaded`, `load`, `pageshow`, etc.)
- extension-side panel message receipt and `READY` queue timing

### Behavioral fix

Implemented two changes:

1. Cancel pending panel reconnect retries immediately when a raw panel `READY` message is received, instead of waiting for the queued `READY` handler to run.
2. Move the browser-only startup follow-up out of the synchronous `READY` route handler. The browser `READY` path now returns quickly, and the `awaitStartupAutoLoad()` continuation runs asynchronously so it does not block panel `READY`.

This breaks the deadlock and lets:

- browser `READY` finish
- panel `READY` reach `setDashboardReady()`
- deferred auto-load complete
- browser follow-up resume afterward

## Verification

The confirming log was `flightpath-1777948958008.log`.

Key healthy signals:

- browser `READY` starts at `02:42:38.988Z` and **finishes** at `02:42:39.579Z`
- panel `READY` begins processing at `02:42:39.585Z` instead of waiting forever
- panel `READY` finishes at `02:42:40.024Z`
- module import resolves successfully
- `main.tsx` and `BootstrapApp` both run normally
- the deferred browser follow-up completes at `02:42:47.936Z`
- the reconnect retry loop logs `RECONNECT retry cancelled`

Most importantly, the failure no longer reproduced after the deadlock fix.

## Notes

- Duplicate panel `READY` messages can still appear during startup, but they no longer wedge the queue.
- The extra logging was intentionally kept during the investigation and can be trimmed later once startup behavior is considered stable.
