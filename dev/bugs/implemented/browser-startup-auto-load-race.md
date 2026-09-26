# Browser client stuck on "No workflow loaded" during startup auto-load race

- **Found:** before 2026-09 (migrated from `dev/KNOWN_ISSUES.md` #2)
- **Area:** `src/ui/WebviewMessageRouter.ts` READY handling, startup auto-load
- **Resolution:** fixed by `dev/implemented/STARTUP_LOADING_OVERLAY_PLAN.md` (commit 7449f6e1)

**Symptom:** A browser tab that opens at the exact moment the VS Code extension is initializing
(after `startupAutoLoadTriggered` is set to `true` but before `triggerAutoLoad` has finished
loading the session) will land in an unrecoverable state: it shows "No workflow loaded" and
no recovery replay is ever sent.

**Root cause:** Two separate recovery paths exist for browser clients:

- **After auto-load:** `handleClientReady` falls back to the panel's viewed workflow ID and
  replays it directly.
- **Before auto-load:** `addBrowserAutoLoadCallback` registers a recovery callback that fires
  once `triggerAutoLoad` completes.

The gap is the brief window _during_ auto-load, after `startupAutoLoadTriggered = true` but
before `triggerAutoLoad`'s inner callback has fired. A browser connecting in this window
sees `isAutoLoadTriggered === true` (skips registering a callback) but also sees the panel's
`viewedId === null` (no replay yet). Both recovery paths are missed simultaneously.

**Note on original "sub-millisecond" characterization:** `autoLoadRecentSession` contains
multiple real async I/O awaits (`fs.stat`, directory read, JSON file read). The actual race
window is 100–500ms, not sub-millisecond. The race is real and reproducible.

**Fix:** Replace `startupAutoLoadTriggered: boolean` with a `Promise<string | null>` that
resolves to the loaded workflow ID (or `null`) in `triggerAutoLoad()`'s `finally` block.
Browser clients in `WebviewMessageRouter`'s READY handler `await` this promise regardless of
when they connect, then receive a targeted replay if needed. The `pendingBrowserAutoLoadCallbacks`
mechanism is removed as it is fully subsumed by the promise approach.
