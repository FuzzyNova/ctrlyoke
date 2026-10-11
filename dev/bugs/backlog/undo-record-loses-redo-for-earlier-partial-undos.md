# A step's redo data is replaced by each undo, and any redo clears all of it

- **Found:** 2026-10-11 by Claude (File changes docs pass, code review)
- **Area:** `src/ui/UndoRedoCoordinator.ts`, `src/core/orchestration/OutputHistoryManager.ts`
- **Severity:** medium

## Symptom

Undo and redo are tracked as one record per step that holds only the most
recent batch:

- Undo file A in a step, then undo file B in the same step separately: only B
  can be redone. A's redo row disappears from the dialog.
- Undo A and B together, then redo only A: B's redo row disappears too, because
  the whole record is marked redone.

Both lose the only way back to the AI's version of a file without re-running
the step.

## Steps to Reproduce

1. Run a step that edits two files.
2. Use the per-file **Undo** on the first file, then on the second.
3. Open **View N changes** on the step: only the second file shows as
   **Undone** with a redo row.

## Root Cause

- `UndoRedoCoordinator.recordUndoApplied` (`UndoRedoCoordinator.ts:466-510`)
  builds a new `UndoRecord` from this batch's `redoInstructions` only.
  `OutputHistoryManager.saveUndoRecord` appends it as the step's latest
  `UNDO_APPLIED` event, and readers use `findLatestUndoRecord`, so the earlier
  batch is shadowed. The webview also replaces, not merges, the record on
  `UNDO_RECORD_UPDATED`.
- `OutputHistoryManager.markUndoRecordRedone` (`OutputHistoryManager.ts:1714-1756`)
  sets `isRedone: true` on the whole record regardless of which files were
  redone, and `promptUndo.ts` drops all redo rows once `isRedone` is set.

## Suggested Fix

Merge into the existing record on undo (union of `restoredFiles`, and
`redoInstructions` keyed by normalized path, newest wins). On redo, remove only
the redone paths from `redoInstructions` and set `isRedone` only when none
remain. Cover both sequences in `UndoRedoCoordinator` tests.
