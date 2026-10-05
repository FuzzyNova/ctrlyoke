# One malformed `runner.json` aborts stale-lock recovery for every other lineage

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a tsx probe
- **Area:** `src/utils/WorkflowLockManager.ts` (`normalizeStaleLocks` ~251-261)
- **Resolution:** fixed in this commit

## Symptom

At startup, if any lineage's `runner.json` has a missing or invalid `runRef`
(hand-edited, partially written by an older build, or a lock from a newer
ctrlyoke), crashed runs in _other_ lineages are not normalized to `stopped`, and
live runs owned by other hosts are not reported as active.

## Steps to Reproduce

1. Lineage `a-bad` has `runner.json` = `{"workflowKey":"a-bad"}`.
2. Lineage `b-good` has a lock with a dead PID and a run whose
   `_runtime.executionState` is `running`.
3. `WorkflowLockManager.normalizeStaleLocks(root, ["a-bad","b-good"])` throws
   `Invalid runRef: "undefined"`, and `b-good` stays `running`.
4. `ExternalRunWatchCoordinator` (~175) catches the error and continues with
   empty `activeRunPaths`/`recoveredPaths`.

## Root Cause

`readWorkflowLock` returns any parsed JSON object, and
`WorkflowPaths.runFilePath(..., lock.runRef as RunRef)` runs outside the loop
body's try/catch. `assertValidRunRef` throws `WorkflowPathError`, which escapes
the whole loop.

## Suggested Fix

Per lineage, check that `lock.runRef` is a valid `RunRef` (or wrap the per-lineage
body in try/catch). If it isn't, log a warning and `continue`. Add a unit test
with one malformed lock followed by one stale lock.
