# Per-file Undo on a Write block deletes a file that already existed

- **Found:** 2026-10-11 by Claude (File changes docs pass, code review)
- **Area:** `src/ui/webview-react/utils/promptUndo.ts`
- **Severity:** high

## Symptom

The **Undo** button on a "Wrote" block in the output pane always deletes the file.
When the harness used its write tool to overwrite a file that existed before the
step (Claude's `Write` tool does this routinely for full rewrites), Undo deletes
the user's file instead of restoring its earlier content. The dialog shows the
row as an ordinary "Undo 1 file", so nothing warns that the original goes too.

## Steps to Reproduce

1. Have a tracked file `notes.md` with some content.
2. Run a step that rewrites it with a whole-file write (e.g. Claude: "Rewrite
   notes.md from scratch with …").
3. In the output, select **Undo** on the "Wrote notes.md" block, then **Undo 1 file**.
4. `notes.md` is deleted. Expected: its pre-step content is restored.

## Root Cause

`resolveEventUndoInstruction` (`promptUndo.ts:128-137`) maps every
`FILE_WRITE` event to `{ action: UNDO_FILE_ACTIONS.DELETE }`. `FileWriteData`
(`src/types/CliOutputTypes.ts:407`) carries no "existed before" flag, so the
per-event path can't tell a create from an overwrite.

`buildUndoCandidatesForOutputs` (the step-level dialog) does not have this
problem: it resolves writes against the workspace snapshot, whose `changeType`
is authoritative (`promptUndo.ts:396-402`).

## Suggested Fix

In `buildUndoDialogInputForSpecificEvent`, resolve `FILE_WRITE` through
`resolveSnapshotFileMatch` the same way `FILE_DELETE` does: if the snapshot
records the file as `modified`, use its restore-content (or reverse-patch)
instruction; only a snapshot `created` entry should map to DELETE. With no
snapshot entry, return `null` ("Cannot undo") rather than guessing DELETE.
Add a `promptUndo.test.ts` case for a write over an existing file.
