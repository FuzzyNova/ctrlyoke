# The extension's undo/redo in-flight guard misses runs executing in another process

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/WorkflowOrchestrator.ts` (`isRunInFlight`), `src/ui/UndoRedoCoordinator.ts` (`applySnapshotEntries`)
- **Resolution:** fixed in this commit

## Symptom

The extension host is supposed to refuse undo/redo for a run that has a step
in flight. This is the backend backstop for stale clients (see commit
a8fd53882). For a run that a CLI or another VS Code window is executing, the
guard passes. An `undoPromptChanges` or `redoWorkflowChanges` message for that
run then writes files under a step that is still running. Such a message can
come from a stale dialog in the watcher's lag window, or from a hosted tab
whose UI has not caught up.

Traced in code; not reproduced end to end.

## Root Cause

- `WorkflowOrchestrator.isRunInFlight` (around lines 3141-3149) only looks at
  the local `WorkflowInstance` returned by `findInstanceForLineage`.
- When another process owns the run, `ExternalRunWatchCoordinator.ts`
  (around line 626) retires the local instance, and the run is observed only
  through its run file and lock. So `isRunInFlight` returns `false`.
- `UndoRedoCoordinator.applySnapshotEntries` (around line 281) relies on that
  answer.
- The UI already treats such a run as running, because
  `ExternalRunWatchSession.ts` (around lines 217-230) publishes the run file's
  `executionState`. Only the backend check misses it.

## Suggested Fix

In `isRunInFlight`, also treat the run as in flight when an active external
runner lock names that `runRef` (the `WorkflowLockInspector` /
`ExternalExecutionResolver` check). Add an orchestrator unit test with a
retired instance plus an active external lock, and a `UndoRedoCoordinator`
test that refuses in that case.

## Decision

**No decision needed; fix as suggested** (2026-11-26). The fix only tightens an
internal safety guard to match what the UI already shows, so there is no
trade-off to choose between.
