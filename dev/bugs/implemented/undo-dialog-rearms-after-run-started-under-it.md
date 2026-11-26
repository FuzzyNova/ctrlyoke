# A changes dialog left open while a run starts becomes undoable again with its old list

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/UndoChangesDialog.tsx`, `src/ui/webview-react/hooks/useOutputUndoActions.ts`
- **Resolution:** fixed in this commit

## Symptom

1. With the run stopped or paused, open **View N changes**. The dialog is
   armed and every row is ticked.
2. The run starts or resumes while the dialog is still open. This can come
   from the command palette, an MCP `append_step` with a run action, a hosted
   browser tab, or a CLI resuming the run while the panel watches it. The
   dialog goes read-only, which is correct.
3. The run finishes. The dialog is armed again, with no banner, showing
   "Undo 1 file" and the old ticks restored. Clicking it sends
   `undoPromptChanges` for a list from before the run, which misses
   everything the run just changed.

`docs/guide/file-changes.md:43-44` says: "A dialog opened mid-run stays
read-only even after the run stops, so its list is never out of date when you
undo." The code comment in `UndoChangesDialog.tsx` gives the same reason.

## Steps to Reproduce

A Vitest probe: render the dialog with `undoBlockedReason={undefined}`,
rerender it with `IN_FLIGHT_RUN_UNDO_BLOCKED_MESSAGE`, then rerender with
`undefined` again. The result is that the Undo button reads "Undo 1 file", is
enabled and has no status. Clicking it posts `["undoPromptChanges"]`.

The existing test "withdraws selection when a run starts under an open dialog"
(`src/ui/webview-react/test/components/output/UndoChangesDialog.test.tsx`,
around line 750) stops at the blocked state and never renders the dialog
unblocked again.

## Root Cause

`UndoChangesDialog.tsx:171-174`:

```ts
const [openedWhileBlocked] = useState(() => undoBlockedReason !== undefined);
const blockedReason =
  undoBlockedReason ??
  (openedWhileBlocked ? IN_FLIGHT_RUN_REOPEN_TO_UNDO_MESSAGE : undefined);
```

The read-only latch is recorded only on the first render. `undoBlockedReason`
follows the live `executionState` (`OutputSection.tsx`, around lines
512-515). Nothing closes the dialog when a run starts: `useOutputUndoActions`
clears the dialog state only from `onClose`. The `checkedPaths` selection
survives while the checkboxes are hidden.

## Suggested Fix

Latch on any blocked render, not just the first. For example, keep a
`useRef(false)` that is set whenever `undoBlockedReason` is defined, and use
it in place of `openedWhileBlocked`. When the latch trips, clear
`checkedPaths` too, so no old selection comes back.

Extend the test at `UndoChangesDialog.test.tsx` (around line 750) with a final
`rerender` where `undoBlockedReason` is `undefined`. Assert that Undo is
disabled, the status shows `IN_FLIGHT_RUN_REOPEN_TO_UNDO_MESSAGE`, and nothing
was posted. Cover the redo direction the same way if it shares the latch.
