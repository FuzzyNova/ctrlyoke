# Clear History permanently wipes every lineage in one tap, including running workflows

- **Found:** 2026-09-29 by user (lost the full `c:\dev\ctrlyoke` run history from the hosted dashboard on a phone)
- **Area:** `src/ui/WorkflowSerializer.ts`, `src/ui/WebviewMessageRouter.ts`, `src/ui/webview-react/components/workflow/WorkflowList.tsx`, `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`
- **Resolution:** fixed in this commit

## Symptom

A single tap on **Clear History** in the recent-workflows dropdown deleted every
lineage under the project's `.runs/`: 1,600+ runs across 1,300+ workflows. Two
workflows that were running at the time were deleted as well. Their harness
processes kept going, but every later write failed:

```
WARN: [WorkflowLockManager] updateHeartbeat: failed for reply-to-step-plan-…: EPERM rename …\runner.json.<uuid>.tmp -> …\runner.json
WARN: [OutputHistoryManager] Failed to append streamed output deltas to history: ENOENT …\manifest.json.lock
```

Their output from that point on was lost. The delete bypasses the Recycle Bin,
so nothing could be restored from the OS. The only surviving copy of the content
was the history search index, which stores event text capped at 2,000
characters.

The action itself left almost no trace in the session log. The first sign of it
was `[inst:…] clearWorkingFilePath: stale working file path cleared` after the
delete had already finished, so the cause had to be reconstructed indirectly.

## Steps to Reproduce

1. Set `confirmDeleteOperations: false` (the setting is global, so this is a
   plausible state, e.g. after bulk-deleting a few single runs).
2. Start a long-running workflow.
3. Open the hosted dashboard on a phone and open the workflow dropdown.
4. Tap **Clear History**. It is the full-width footer row directly under the
   list, and it is visible as soon as the list has recent rows.
5. Every lineage, including the running one, is `rm -rf`'d with no prompt and
   no undo.

## Root Cause

- `WorkflowStatus.handleClearHistory` (`WorkflowStatus.tsx`) skips the
  confirmation modal whenever `confirmDeleteOperations` is off. That setting
  makes sense for single-run deletes, but it applies equally to the
  delete-everything scope `WORKFLOW_DELETE_SCOPES.ALL`.
- `WorkflowSerializer.handleClearWorkflowHistory` lists every lineage key and
  calls `fs.rm(lineageDir, { recursive: true, force: true })` on each one. It
  never checks for a live `runner.json` lock. `handleRemoveWorkflowHistory`
  (single lineage) has the same gap.
- The deletes are permanent (`fs.rm`), so there is no trash or undo.
- The button is a large, full-width target placed right where a thumb lands
  after scrolling the dropdown on a touch device.
- Neither handler logs at INFO what it deleted, so a wipe is invisible in the
  session log.

## Suggested Fix

Full design: `dev/implemented/RECOVERABLE_HISTORY_DELETE_PLAN.md`.

1. Always confirm `WORKFLOW_DELETE_SCOPES.ALL`, regardless of
   `confirmDeleteOperations`. A type-to-confirm or a count ("Delete 1,326
   workflows?") would make an accidental tap impossible.
2. Refuse to delete (or skip and report) any lineage whose `runner.json` lock is
   live, in both the clear-all and single-lineage paths. `inspectRunner` in
   `src/utils/ProjectStateLifecycle.ts` already has the liveness check.
3. Make history deletes recoverable: move lineages into a
   `.runs/.trash/<timestamp>/` directory and purge it after a grace period,
   with an Undo toast in the dashboard.
4. Move Clear History out of the dropdown footer, e.g. into settings or a
   secondary overflow menu, so it isn't a primary tap target on mobile.
5. Log at INFO level every lineage key the handlers delete, and which client
   (webview vs. `browser:<id>`) requested it.
