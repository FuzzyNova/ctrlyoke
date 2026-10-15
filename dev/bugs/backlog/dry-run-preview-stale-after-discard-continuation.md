# Dry-run preview stays marked stale for good after a Discard continuation, because definitionRevisionHeads only ever increases

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/store/executionPreviewStore.ts`
- **Severity:** low

## Symptom

After a rewound run's continuation is discarded, every Dry Run preview of that run shows the "Definition changed — Refresh" stale banner, and Refresh does not clear it. The preview content is correct, but the banner says it is out of date. The banner stays until the webview reloads, or until later edits raise the definition revision back to the pre-discard value.

## Steps to Reproduce

1. Open a run whose definition revision is N in the dashboard.
2. Rewind the run to an earlier step. The rewind writes revision N+1 (`WorkingFileManager.ts:1080`), and `RUN_VIEW_LOADED`/`WORKFLOW_VIEW_IDENTITY` report N+1 to the client. Optionally edit the rewound suffix to raise it further, to N+k.
3. Click **Discard continuation**. The run file is restored to the snapshot at revision N, and the client receives revision N for the same run address.
4. Open Dry Run on that run. The modal shows the "Definition changed" stale banner.
5. Click Refresh. The server returns `displayedDefinitionRevision` N again, and the banner stays.

## Root Cause

`observeDefinitionRevision` (`src/ui/webview-react/store/executionPreviewStore.ts:128-131`) and `resolve` (`:108-111`) merge the per-address definition head with `Math.max`, which assumes revisions only increase. They can decrease. `WorkingFileManager.discardPendingRewind` restores the pre-rewind snapshot (`src/core/WorkingFileManager.ts:1994`) and returns `definitionRevision: base.definitionRevision ?? 1` (`:2015`), which is lower than the `sourceRevision + 1` the rewind wrote (`:1080`).

The address key does not change across the discard: `workflowViewAddressKey` is `<workflowKey>:run:<runRef>` (`src/ui/webview-react/utils/viewAddress.ts:29-33`). The old high value therefore stays in `definitionRevisionHeads`. `resolve` then computes `isStale: currentHead !== message.displayedDefinitionRevision` (`executionPreviewStore.ts:121`), which stays true from then on. `reset()` (`:159`) would clear the heads, but nothing outside tests calls it.

`uiStore.ts:160-169` (the `mergeDescriptorRevision` doc comment) already warns that definition revisions must not be merged monotonically, because "a discarded continuation legitimately restores an older definition head". This store does it anyway.

## Suggested Fix

- Stop merging definition heads monotonically. Authoritative pushes, `WORKFLOW_VIEW_IDENTITY` (`useMessageHandler.ts:2465-2468`) and `RUN_VIEW_LOADED` (`:2598-2601`), should overwrite the head with the incoming value. For example, add an `authoritative` flag to `observeDefinitionRevision`, or add a separate `setDefinitionRevisionHead`.
- In `resolve()`, treat the server's `displayedDefinitionRevision` as the current head, without taking `Math.max` against the cache.
- If a guard against out-of-order pushes is still needed, key it on the monotonic `descriptorRevision`, as `uiStore.mergeDescriptorRevision` does, not on `definitionRevision`.
- Add a store test: observe 3, observe 2 (the discard), resolve with 2, and expect `isStale === false`.
