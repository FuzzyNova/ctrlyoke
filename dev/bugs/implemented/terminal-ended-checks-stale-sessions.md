# `TERMINAL_ENDED` checks a stale store snapshot, so the terminal never goes inactive

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/hooks/terminalMessageHandlers.ts`
- **Resolution:** fixed in this commit

## Symptom

When the last running PTY session of a workflow ends, the dashboard should clear the
live-terminal state (`setTerminalSessionActive(workflowId, false)`) and switch back to the Output
tab. It never does. The live-terminal indicator stays on after the session has exited.

## Steps to Reproduce

In a vitest test: add one RUNNING session for `wf-1` to `useTerminalStore`, then dispatch
`TERMINAL_ENDED {workflowId: "wf-1", sessionId, status: exited}`. `setTerminalSessionActive` is
never called with `false`.

## Root Cause

The handler (around lines 389-400) captures `const termStore = useTerminalStore.getState()` and
calls `termStore.endSession(...)`. `endSession` updates the store immutably, but the handler then
reads `termStore.sessions[workflowId]` from the snapshot captured before the update. That
snapshot still shows the session as RUNNING, so `hasRunningSessions` is always true.

## Suggested Fix

Re-read `useTerminalStore.getState().sessions[workflowId]` after `endSession`. Add a vitest test
that ends the last running session and asserts the UI store goes inactive.
