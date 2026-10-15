# CANCELLING instances are treated as idle and disposed while still executing

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/WorkflowInstanceRegistry.ts`
- **Severity:** low

## Symptom

A workflow whose Stop is still in progress (CANCELLING) is disposed and dropped from the live registry as soon as its last viewer leaves or the panel loads another file. For the rest of the cancel, in-process owner checks such as `findInstanceForLineage`, `isLineageExecuting` and the `createWorkflow` duplicate check don't see it. Its integrations are also torn down mid-cancel, so `stop()` usually waits out its full 10s timeout instead of settling when the harness reports completion.

## Steps to Reproduce

1. Start a workflow whose step is a long CLI harness turn, and view it in a hosted browser tab (or in the VS Code panel).
2. Press Stop. The instance enters CANCELLING (`WorkflowStateMachine.requestStop`) and `WorkflowInstance.stop()` waits up to 10s for the cancel to settle.
3. Before it reaches STOPPED, close the hosted tab (`unregisterClient`) or load a different workflow file in the panel (`createWorkflow`).
4. The session log shows the instance disposed and removed from `instances`. Reopen the same workflow file or lineage before the cancel settles: `findInstanceForLineage` and the duplicate check don't find the cancelling instance, so a second instance is built for the lineage while the first is still settling. `stop()` then logs `Stop timeout: cancellation did not settle within 10s` because the integrations it was listening on were disposed.

## Root Cause

The idle checks in `src/core/orchestration/WorkflowInstanceRegistry.ts` are hand-written lists of execution states (`RUNNING`, `PAUSING`, `PAUSED`) that omit `CANCELLING`:

- `createWorkflow` idle check at lines 270-274, plus its duplicate-instance check at lines 238-241.
- `unregisterClient` idle check at lines 556-560.

The shared helper `isExecutionOwnerState` at lines 42-49 of the same file does include `CANCELLING`. Because of the omission, `currentViewed.dispose()` + `instances.delete` (lines 279-280) and `instance.dispose()` + `instances.delete` (lines 562-563) run on an instance whose stop is still in flight. `WorkflowInstance.dispose()` (`src/core/WorkflowInstance.ts:1142-1179`) then tears down the runner-lock heartbeat, stop-request polling, integrations and script runners while `WorkflowInstance.stop()` (`src/core/WorkflowInstance.ts:2374-2497`) is still awaiting them. With the heartbeat stopped, the runner lock also looks stale after 30s and can be reclaimed by another process while this one is still finishing.

## Suggested Fix

Replace the three hand-written state lists in `WorkflowInstanceRegistry.ts` (lines 238-241, 270-274 and 556-560) with `isExecutionOwnerState(status)`: `isIdle = !isExecutionOwnerState(status)`, and the duplicate check uses `isExecutionOwnerState(existingStatus)`. An unviewed CANCELLING instance then stays in the registry until it reaches STOPPED, just as an unviewed RUNNING instance does, and the existing settle and cleanup paths handle it.

Add a registry unit test for each path (`unregisterClient` and `createWorkflow`) asserting that a CANCELLING instance is neither disposed nor removed.
