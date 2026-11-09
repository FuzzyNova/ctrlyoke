# Undo/redo can rewrite or delete a step that already ran after the run stops

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent review of ~281911d9c)
- **Area:** `src/core/PromptQueue.ts` (`syncStepsForUndoRedo`), `src/core/WorkingFileManager.ts` (`syncStepsForUndoRedoAtRun`)
- **Resolution:** fixed in this commit

## Symptom

281911d9c made executed steps immutable once a run stops: `PromptQueue.assertEditableDuringExecution`
refuses to edit, replace, delete or insert at a step with execution evidence or a terminal
status, and the commit removed the undo tests that deleted a completed step ("a state the product
no longer allows"). Undo/redo still bypasses that rule. After a run completes or stops, clicking
Undo in the dashboard can:

- change an executed step's prompt back to text it never ran with, while it keeps its completed
  `_runtime` (`startedAt`, `completedAt`, `terminalStatus: completed`);
- delete the executed step entirely, after which `currentIndex` is recomputed from the remaining
  steps and moves backwards, so output already recorded in `events.jsonl` points at the wrong step.

## Steps to Reproduce

1. During a run, edit a pending step's prompt (or let an agent `append_step` a new step via MCP);
   the dashboard records an undo entry for that definition change
   (`src/ui/webview-react/hooks/useMessageHandler.ts`, step-count change ~1133).
2. Let that step run, and let the run complete or stop.
3. Click Undo (`UndoRedoControl.tsx` only disables undo while running/paused).
4. The executed step's prompt reverts (or the appended step disappears) and `currentIndex` moves.

Direct repro against `PromptQueue` with a completed step 0 (`stepId` "a", prompt "ran-B") and a
pending step 1, `currentIndex` 1, run not executing:

- `updatePrompt(0, …)` → rejected: "Cannot edit a step that has already run".
- `deletePrompts([0])` → rejected: "Cannot delete a step that has already run".
- `syncStepsForUndoRedo([{ prompt: "original-A", _runtime: { stepId: "a" } }, step1])` →
  succeeds; step 0's prompt becomes "original-A" and it keeps its completed runtime.
- `syncStepsForUndoRedo([step1])` → succeeds; steps become `["p1"]` and `currentIndex` 1 → 0.

## Root Cause

`syncStepsForUndoRedo` (`src/core/PromptQueue.ts` ~3401) and its run-file twin
`WorkingFileManager.syncStepsForUndoRedoAtRun` (~2193, the path used when no live instance holds
the run) guard only against a pending rewind (`PromptQueue.assertPendingRewindUndoRedoSuffix` is a
no-op unless one is pending). Neither applies
the executed-step immutability rule that `assertEditableDuringExecution` (~3584) enforces for every
other mutation.

## Suggested Fix

Before applying an undo/redo snapshot, compare it to the current steps: every current step that
has started or has a terminal status (after the same failed-step rewind the other mutations apply)
must still be present, at the same index, with the same persisted definition (prompt and
configuration, ignoring view-only fields and `_runtime`). Otherwise reject with an error
like "Cannot undo a change to a step that has already run". Share one helper between the queue and
`WorkingFileManager` paths. The dashboard should surface the rejection (and ideally drop undo
entries that cross executed steps) rather than leaving its local state diverged from the backend.
