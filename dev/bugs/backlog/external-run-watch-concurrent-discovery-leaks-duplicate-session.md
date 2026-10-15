# Concurrent external-run discovery can start two watch sessions for the same run and leak one forever

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Severity:** medium

## Symptom

When an external CLI run starts, two `ExternalRunWatchSession` objects can be created for the same workflow. One of them is overwritten in, or dropped from, `externalRunSessions` without `dispose()` being called. It keeps its working-file, lock and history directory watchers and its heartbeat interval for the life of the extension host. On Windows those directory handles can block renaming or deleting the run and lineage directories. Its update and finish callbacks still fire against the live entry for that `workflowId`. That causes duplicate summary and step-status broadcasts, and it can finish the live session early.

## Steps to Reproduce

1. Open a workspace in VS Code with ctrlyoke active, so `setupRunnerJsonCreateWatcher` has installed the `*/runner.json` watcher and the 1 s discovery poll.
2. From a terminal, start a workflow with the ctrlyoke CLI. `WorkflowLockManager.acquireLock` creates `runner.json` with `open(wx)` and then writes to it. That fires `onDidCreate` and then `onDidChange`, and the 1 s poll may also see a new mtime.
3. Both `handleRunnerJsonEvent` invocations await the lock inspection and `resolveExternalExecutionForPath`. Both then pass the `externalRunSessions.has(workflowId)` check at `ExternalRunWatchCoordinator.ts:410` before either has called `set`.
4. Both enter `startExternalRunWatchSession`. Each awaits the second resolution (L463) and `readWorkflowDisplayName` (L532), constructs a session, and calls `externalRunSessions.set` (L615). The second `set` overwrites the first entry.
5. The first caller's `activeEntry?.session !== session` check (L629) makes it return false without calling `session.dispose()`. Alternatively, the first caller has already returned true and its session is then overwritten. Either way, one session's watchers and interval are never cleaned up, and the coordinator's `dispose()` (L1129-1131) cannot reach it.

## Root Cause

`ExternalRunWatchCoordinator.ts` guards session creation with a check-then-act that spans awaits, so it is not atomic:

- The `externalRunSessions.has()` checks are at L337 (the poll filter), L410 (`handleRunnerJsonEvent`) and L993 (`ensureExternalRunWatchSession`). `startExternalRunWatchSessionIfExternal` (L420-436) does not check at all.
- `startExternalRunWatchSession` (L438-637) awaits at L463 and L532. It then calls `this.externalRunSessions.set(workflowId, ...)` at L615 without checking for an existing entry. Nothing tracks starts that are still in flight.
- When the branch at L629-631 finds that its session has been superseded, it returns false without calling `session.dispose()`. The session whose entry was overwritten is never disposed either.

`ExternalRunWatchSession.start()` (`ExternalRunWatchSession.ts:111-126`) creates three watchers (run dir, lineage dir, manifest dir) and a 10 s heartbeat `setInterval`. Only `dispose()` (L128-145) releases them. Once a session is out of the map, neither `handleExternalRunFinished` nor the coordinator's `dispose()` can reach it.

## Suggested Fix

- Serialize starts per `workflowId`. Add a `pendingStarts: Map<string, Promise<boolean>>` to the coordinator, and route every start path through one wrapper around `startExternalRunWatchSession`. Before doing any async work, the wrapper returns the existing pending promise, or `true` if a session is already registered. It deletes the pending entry in a `finally`.
- As defense in depth, check `this.externalRunSessions.has(workflowId)` again inside `startExternalRunWatchSession`, right before the `set` at L615. If an entry already exists, return early without constructing or starting a session.
- Call `session.dispose()` in the superseded branch at L629-631 so that losing a race can never leak watchers.
- Add a unit test that fires `handleRunnerJsonEvent` twice concurrently for the same lock. It should assert that exactly one session is started, and that every watcher and interval created is disposed when the coordinator is disposed.
