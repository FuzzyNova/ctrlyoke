# Opening a folder lands on a blank New Workflow instead of the most recent session

- **Found:** 2026-10-21 by Nathan (session log `ctrlyoke-1792636462765.log`, analysed by Claude Code)
- **Area:** `src/core/WorkflowOrchestrator.ts` startup gating (`initialize`, `setDashboardReady`, `triggerAutoLoad`), `src/ui/WebviewMessageRouter.ts` panel READY
- **Resolution:** fixed in this commit

## Symptom

With `general.autoLoadRecentSession` on, opening a folder in a new VS Code window briefly
showed a workflow and then switched to an empty "New Workflow". Neither the most recent session
nor the panel's previously viewed workflow stayed on screen.

## Steps to Reproduce

Timing-dependent. It needs a cold start where the panel's first READY is still being handled
when `initialize()` has been finished for `PANEL_READY_GRACE_PERIOD_MS` (1 s). Busy harness
probes made that happen in the reported log: READY was handled for 6.2 s.

1. Open a workspace whose panel last showed workflow A, while workflow B is the most recent
   session in run storage.
2. Restart VS Code. The panel READY (carrying A's persisted `preferredViewAddress`) is slow.
3. The panel ends on a blank New Workflow.

## Root Cause

`initialize()` arms a grace timer so hosted browsers can start without the VS Code panel. It
treated "the dashboard is not marked ready yet" as "no panel". The panel READY marks the
dashboard ready only at its end, after `handleClientReady` hydrates the persisted view. A READY
still in progress therefore looked absent, and the timer called `setDashboardReady()` with no
panel sink while it ran. The two paths then raced:

1. `triggerAutoLoad` loaded B into the panel's startup instance. B is completed, so the instance
   retired immediately. With no panel sink, nothing was replayed to the panel.
2. At the same time `handleClientReady` loaded A into a fresh instance and rebound the panel
   to it.
3. `STARTUP_COMPLETE` was broadcast before A's run view reached the webview. The webview's
   `STARTUP_COMPLETE` handler saw nothing displayed and sent `CLEAR_WORKFLOW`, which replaced A
   with a blank workflow.

The log shows two instances loading different workflows (`DataRep reply`, then
`gmail integration`), `Broadcasting STARTUP_COMPLETE` before `deliverRunView … snapshot sent`,
and then a `clearWorkflow` route.

## Fix

The router calls `WorkflowOrchestrator.notePanelReadyStarted()` before the panel READY's first
await. While that READY is in flight, the grace timer re-arms instead of firing, for up to
`PANEL_READY_IN_FLIGHT_MAX_WAIT_MS` so a READY that throws cannot hold startup forever.
`setDashboardReady(panelSend)` clears the flag. The auto-load now runs only after the panel's
hydration, so `triggerAutoLoad` sees the hydrated view and `STARTUP_COMPLETE` stays last.

The same log had two smaller problems, fixed in this commit too:

- `Log.trace/debug/info/warn` serialized `Error` arguments as `{}`. The worktree failure was
  logged as `[{}]`, and so was every other `Log.warn("…", error)` call. Errors in arguments are
  now written as their message.
- `[WorktreeRecovery] activation discovery failed` was logged on every activation in a folder
  outside a Git repository. Discovery now skips such folders with a debug line.
