# Undo/redo copies another step's `_runtime` by index, giving two steps the same `stepId`

- **Found:** 2026-10-03 by bug-hunt final step (claude-cli); both paths reproduced against the compiled modules with a `vscode` stub
- **Area:** `src/core/WorkingFileManager.ts` (`syncStepsForUndoRedoAtRun`, ~1632-1680), `src/core/PromptQueue.ts` (`syncStepsForUndoRedo`, ~2975-3030)
- **Severity:** high

## Symptom

After undoing a step delete (or insert/reorder) the run definition can contain
two steps with the same `_runtime.stepId`. Every later step mutation on that
run then throws `Duplicate stepId "<id>" at index N` — dashboard insert/paste,
MCP `append_step`, CLI `append`/`continue`, and `mergeDiskSteps` at step
completion — and the run stays wedged until the working file is hand-edited.
ID-keyed lookups (`findStepIndexById`, timeline/runtime matching) can also bind
output to the wrong step, and a restored pending step can inherit another
step's `completedAt`/`sessionId`/`terminalStatus`.

## Steps to Reproduce

**Path A — idle run (no live instance), `WorkingFileManager.syncStepsForUndoRedoAtRun`:**

1. Run with steps `[done (stepId d, completed), A (a, pending), B (b, pending)]`.
2. Delete A → disk holds `[done, B(b)]`.
3. Undo with the original snapshot `[done, A(a), B(b)]` (pending steps carry
   only `_runtime.stepId`).
4. Actual: `[done(d), A(b), B(b)]`. The next `insertStepAtRun` throws
   `Duplicate stepId "b" at index 2`. Expected: `A(a), B(b)`.

**Path B — loaded instance, `PromptQueue.syncStepsForUndoRedo`:**

1. Steps `[X(a)]`; paste a duplicate → `[X(a), X(b)]` (same type, name, text).
2. `deletePrompt(0)` → `[X(b)]`.
3. Undo with the dashboard snapshot `[X(a), X(b)]`.
4. Actual: `[X(b), X(b)]`; the next `appendSteps` throws `Duplicate stepId`.
   Expected: `[X(a), X(b)]`.

## Root Cause

- **Path A:** when an incoming step's `_runtime` holds nothing but `stepId`,
  the code replaces its whole `_runtime` with `existingTopology.steps[index]._runtime`
  — whatever step is on disk at the same *index* — without checking that it is
  the same step. The docstring says runtime is preserved only "when the
  incoming step is otherwise identical", but no such check exists.
- **Path B:** `existingRuntime` is chosen by same index plus
  `getStepIdentityKey` (type + name + text, not `stepId`), and
  `mergeRuntimeMetadata(archived, incoming, existing)` lets the existing
  runtime's `stepId` overwrite the incoming one.

The only existing test (`WorkingFileManager.test.ts` "syncStepsForUndoRedoAtRun
preserves existing runtime for unchanged-position steps") covers steps that keep
their position, so nothing pins the broken behaviour.

## Suggested Fix

Match runtime by `stepId`, not by index or text: when the incoming step has a
`stepId`, take existing (and archived) runtime only from the step with that same
`stepId` (look it up in the existing steps by ID); fall back to index/identity
matching only when the incoming step has no `stepId`. In every case the incoming
`stepId` must survive the merge. Add regression tests for both repro paths
(`WorkingFileManager.test.ts`, and `PromptQueue`/`WorkflowInstance` tests).

Related but separate: `ensure-step-ids-index-fallback-duplicates-later-step-id.md`
(the ID-less fallback in `ensureStepIds`).
