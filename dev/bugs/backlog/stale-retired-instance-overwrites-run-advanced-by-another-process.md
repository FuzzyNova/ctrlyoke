# Stale retired instance overwrites a run that another process advanced

- **Found:** 2026-10-18 by user, while working in one run from both the main VS Code window and a shared-state dev host (`npm run dev:host:start:shared`)
- **Area:** `src/core/WorkflowOrchestrator.ts` (retired-instance reuse, `applyRunAddressedMutation`), `src/core/WorkflowInstance.ts` (`executeEphemeralPrompt` append), `src/core/PromptQueue.ts` (conflict recovery)
- **Severity:** high

## Symptom

In the main VS Code window, the two most recent completed steps of a run suddenly showed as pending/idle. Adding a new prompt to the run failed. Dragging one of those "pending" steps failed with:

```
ERROR: [WorkingFileManager] operationQueue: serialized operation failed: Cannot reorder a completed step while the workflow is running
ERROR: [WebviewMessageRouter] Error handling webview message (reorderPrompts):: Cannot reorder a completed step while the workflow is running
```

Dragging the step back to its original position succeeded, and that write corrupted the run file. `_runtime.currentIndex` went from 5 to 3, and the workflow token/cost totals were recomputed from only the first 3 steps (`attemptCount` 5 → 3, `costUsd` 2.28 → 1.37), even though steps 4 and 5 still had `completedAt` and `terminalStatus: completed`.

## Steps to Reproduce

1. In process A (the main VS Code window), run a workflow to completion. The instance retires but stays in A's retired map, holding 3 steps and `currentIndex = 3`.
2. In process B, which shares the same CtrlYoke state home (a shared-state dev host, or the CLI), open the same run and append and run two more steps. The run file is now at 5 steps, `currentIndex = 5`, definition revision 5.
3. Back in process A, submit a new prompt to the run, or drag one of the steps.
4. A reuses its stale retired instance:
   - The append is rejected with `Definition revision conflict: expected 3, found 5`.
   - The instance still ends up holding all 5 steps from disk but `currentIndex = 3`, so steps 4 and 5 render as pending.
   - A later definition mutation through that instance (the no-op reorder) writes the stale workflow `_runtime` back to disk.

Session-log evidence from 2026-10-18 (main window log `ctrlyoke-1792346879606.log`):

- `19:32:16Z` `inst:cea07e18` completes at 3/3 and is retired.
- The dev host runs steps 4 and 5, which complete at 20:17Z and 20:57Z.
- `21:29:46Z` `executeEphemeralPrompt: appending to existing workflow (status=completed, prompts=3 …)` is followed by `Rejecting local definition mutation based on revision 3 … is at revision 5 (changed by another writer)`.
- Then `Queue state completed (step 3/5)`, followed by the panel log `setCurrentStep 5 -> 3`.
- `21:30:58Z` the reorder is rejected.
- `21:31:04Z` the identity reorder is accepted. Its write analysis shows `_runtime.currentIndex` 5 → 3 and `tokenTotals` recomputed.

## Root Cause

A retired `WorkflowInstance` is a cache of the run file as it was when this process last wrote it. Nothing checks it against disk before it is reused:

- `executeEphemeralPrompt` appends to the cached queue. The revision guard in `WorkingFileManager` correctly rejects the write. The recovery path then takes the newer step list from disk without the workflow-level `_runtime` (`currentIndex`, totals). The instance is left half old and half new, and the dashboard renders that.
- `applyRunAddressedMutation` routes a mutation to the instance path when an instance exists for the run. The instance then writes its whole in-memory state, including workflow `_runtime`, so a definition-only change (a reorder) also persists the stale runtime. The client's `expectedDefinitionRevision` had already been refreshed to the disk value, so the revision guard did not stop this second write.

Within a single process the cache is always current, which is why this only appears when two processes share state. The repo's debugging notes say running one project on two synced machines at once is unsupported. A shared-state dev host on the same machine is a documented workflow, though, and so is the CLI running against the same project.

## Suggested Fix

1. **Check retired instances against disk before reuse.** When a request would reuse a retired instance (ephemeral append, an addressed mutation, a view load), compare the on-disk `definitionRevision` (and run runtime) with what the instance last persisted. If disk is newer, dispose the retired instance and rebuild it from the file, as the "inst not found … creating fresh instance" path already does.
2. **Make conflict recovery all-or-nothing.** When a local write is rejected as changed by another writer, reload the full working file into the queue, runtime included, or leave the in-memory state untouched. Never adopt the disk steps while keeping the cached `currentIndex`.
3. **Keep definition-only mutations from writing workflow runtime.** A reorder or edit applied through the instance path should not persist `_runtime.currentIndex`/`tokenTotals` it did not change. Alternatively, it should merge them from disk under the same lock, as the `*AtRun` file paths in `WorkingFileManager` effectively do.
4. Add a regression test covering two orchestrators (or one orchestrator plus a direct file write) on the same run: the second advances the run, then the first appends or reorders. Assert that the file's `currentIndex`, totals and step runtimes are unchanged and that the append lands after step 5.
