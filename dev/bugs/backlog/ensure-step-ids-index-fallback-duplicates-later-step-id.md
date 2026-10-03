# `ensureStepIds` index fallback can hand a new step the ID of a later step, and then throws "Duplicate stepId"

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a tsx probe of the pure function. Not reproduced end to end.
- **Area:** `src/core/StepIdentity.ts` (`ensureStepIds` ~92-122); callers with `fallbackSteps`: `PromptQueue.mergeDiskSteps` (~1753, ~1847), `PromptQueue.syncStepsForUndoRedo` (~2970), `WorkingFileManager.syncStepsForUndoRedoAtRun` (~1659)
- **Severity:** low (low confidence that users hit it)

## Symptom

`ensureStepIds([{prompt:"new"}, A, B], [A, B])` throws
`Duplicate stepId "A" at index 1`. The step without an ID at index 0 inherits
`fallbackSteps[0]`'s ID (`A`), but `A` is still present later in the same array.

## When it can happen

Only when an incoming step array mixes steps that have IDs with a step that has
none, placed _before_ existing steps. Examples are a hand-edited run working file
where a new step is inserted mid-queue while the run is executing (picked up by
`mergeDiskSteps`), or an undo/redo snapshot with an ID-less step. Normal MCP, CLI,
and dashboard insert paths assign IDs first, so I couldn't find a supported path
that triggers it, hence low confidence.

## Root Cause

`usedIds` only contains the IDs of _earlier_ steps. The fallback check
`!usedIds.has(fallbackId)` doesn't consider IDs that appear later in `steps`.

## Suggested Fix

Seed the used set with every existing ID in `steps` before the mapping loop, so
the fallback is used only when that ID isn't already present anywhere in the
array. Add a unit test in `src/test/unit/StepIdentity.test.ts`.
