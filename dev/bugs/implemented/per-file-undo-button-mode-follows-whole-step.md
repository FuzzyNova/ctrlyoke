# Per-file Undo/Redo buttons switch to Redo for every file once any file in the step is undone

- **Found:** 2026-10-11 by Claude (bug-drain review of 9ce775f63)
- **Area:** `src/ui/webview-react/hooks/useOutputUndoActions.ts`, `src/ui/webview-react/components/output/OutputRow.tsx`, `src/core/orchestration/OutputHistoryManager.ts`
- **Resolution:** fixed in this commit

## Symptom

Commit 9ce775f63 made the persisted undo record keep redo data per file, but
the per-file buttons on output blocks still pick Undo or Redo for the whole
step:

- After the per-file **Undo** on file A, every file block in that step shows
  **Redo**. Clicking **Redo** on file B, which was never undone, does nothing.
  The repro from `dev/bugs/implemented/undo-record-loses-redo-for-earlier-partial-undos.md`
  (undo A, then undo B, each through the per-file button) still can't be done.
- The merge made this worse. Undo A and B, then redo only A: the record stays
  open because B is still pending, so A's button stays **Redo** (a no-op), and
  A can't be undone again per file until B is redone.

## Steps to Reproduce

1. Run a step that edits two files, A and B.
2. Click the per-file **Undo** on A.
3. B's button now reads **Redo**. Clicking it does nothing.

## Root Cause

- `handleFileUndo` (`useOutputUndoActions.ts`, the `showRedo` branch) uses
  `row.undoRecord != null && row.undoRecord.isRedone !== true` to choose the
  mode. It returns without doing anything when `redoInstructions` has no entry
  for the clicked file.
- `OutputRow.tsx` chooses the button label and icon (FILE_WRITE, FILE_EDIT
  and FILE_DELETE blocks) from the same step-level test.

Related issues in the same code, found in the same review:

1. **Old "redone" records come back.** `OutputHistoryManager.saveUndoRecord`
   merges `existingUndoRecord.redoInstructions`/`restoredFiles` even when
   `existingUndoRecord.isRedone === true`. Records written before 9ce775f63
   kept their redo instructions after being redone, so they reappear as
   pending redo rows. Running one would overwrite the file with stale AI
   content.
2. **Path keys are always case-insensitive.** The merge keys in
   `saveUndoRecord` and `markUndoRecordRedone` use `normalizeCliFilePathKey`,
   which always lowercases. On Linux, `A.ts` and `a.ts` then collide. Note
   that `WorkspaceSnapshotService.undoFiles` deliberately stays case-sensitive
   on Linux.
3. **The dashboard can get the unmerged batch.**
   `UndoRedoCoordinator.recordUndoApplied` posts the unmerged batch when
   `saveUndoRecord` returns `undefined`, or when there is no history file.
   The dashboard then replaces the full record with it, and earlier redo rows
   vanish. Separately, `UndoRedoCoordinator`'s redo path ignores the record
   that `markUndoRecordRedone` returns and calls `loadHistory()` again.

## Suggested Fix

- Choose the mode per file: show **Redo** only when the record isn't redone
  and its `redoInstructions` has the file (`sameFilePath`). Otherwise use the
  normal undo path. Do this in `handleFileUndo` and for the `OutputRow`
  label. Put the test in one shared helper (e.g. in `promptUndo.ts`) so the
  label and the handler can't drift apart.
- In `saveUndoRecord`, ignore an existing record's redo data when it is
  `isRedone`.
- Fold path keys with the platform-aware helper from
  `src/utils/PathCasing.ts` (`foldPathForCompare` or its equivalent) instead
  of always lowercasing.
- Post the merged record, or nothing, and reuse the record
  `markUndoRecordRedone` returns.
- Tests: an `OutputRow`/hook test for undo A → B still shows Undo → undo B;
  an `OutputHistoryManager` test for an old redone record; and an
  `UndoRedoCoordinator` test for the merge path. The original bug asked for
  that last one and it was never added.
