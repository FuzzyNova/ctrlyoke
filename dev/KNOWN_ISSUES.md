# Known Issues

Race conditions and edge cases that were investigated and deliberately left open.
Each entry explains the window, why it's acceptable, and what a proper fix would look like.

---

## 1. Workflow properties undo shadow not reset during workflow switch (~16 ms window)

**Symptom:** When switching workflows, there is a brief window where triggering undo
operates against the _previous_ workflow's property baseline rather than the new one.
A user who managed to undo during this window could have the previous workflow's property
values (harness, model, endCondition, etc.) applied to the new workflow.

**Root cause:** The undo system for workflow properties uses a shadow copy
(`undoWorkflowProperties` in `workflowStore`) as its baseline. Two functions update it:

- `setUndoWorkflowProperties(props)` — records a user-initiated change (creates undo entry)
- `syncIncomingWorkflowProperties(props)` — silently resets the shadow without creating an
  undo entry (used for incoming extension messages)

Previously, `applyWorkflowChange` (called on `SESSION_RESTORED`) called
`syncIncomingWorkflowProperties({})` to reset the shadow immediately. This was removed in
commit `7b30509` to fix a visible flash: clearing the shadow caused the PropertiesPanel to
render once with global defaults before `WORKFLOW_PROPERTIES_UPDATE` arrived with the real
values. The fix retains the previous workflow's shadow until `WORKFLOW_PROPERTIES_UPDATE`
arrives (sent by `sendWorkflowPropertiesToSettings` right after replay), at which point
`syncIncomingWorkflowProperties(normalized)` resets it correctly.

The window is the gap between `SESSION_RESTORED` (clears prompts/history) and
`WORKFLOW_PROPERTIES_UPDATE` (resets undo shadow) — two sequential `postMessage` calls with
no `await` between them, processed in the same event-loop turn in practice.

**Why we're not fixing it:** The two messages are issued back-to-back synchronously, so
the JS message pump delivers them in the same turn and React batches both updates into one
render. Interacting with the undo stack between those two messages is not physically possible
under normal operating conditions. The ~16 ms figure assumes one full render cycle elapses
between the two messages, which does not happen on any current platform.

**Proper fix if it ever becomes observable:** Combine `SESSION_RESTORED` and
`WORKFLOW_PROPERTIES_UPDATE` into a single atomic message. `applyWorkflowChange` would then
receive both the session state and the new workflow properties simultaneously, allowing it to
call `syncIncomingWorkflowProperties(normalized)` in the same handler with no intervening
render cycle.

---

## 2. Browser client stuck on "No workflow loaded" during startup auto-load race

> **Resolved** — fixed as part of `dev/backlog/STARTUP_LOADING_OVERLAY_PLAN.md`.

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
