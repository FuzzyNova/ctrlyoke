# On-demand snapshot content is only fetched from some entry points, so diffs and undo lose old content

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code-path review
- **Area:** `src/ui/webview-react/components/output/OutputRow.tsx`, `src/ui/webview-react/hooks/useOutputUndoActions.ts`, `src/ui/webview-react/hooks/useOutputMinimapModel.ts`
- **Severity:** medium (regression from ccaf42888 / 1e418308d)

## Symptom

Since run views strip workspace-snapshot `beforeContent` and fetch it on demand
(`RunViewPublisher.stripSnapshotContents`, `useWorkspaceSnapshotContent`), only
some entry points fetch it:

1. **Diffs that are already expanded** never fetch before-content. This covers
   the persisted "expand all diffs" preference (`diffsCollapsed = false`,
   `uiStore.ts` ~1243) and a diff the user expanded whose row the virtualizer
   unmounted and remounted. `DiffView`'s `hasExpandableSource` (~207) is then
   false, so gap-expansion controls disappear and gaps that were already
   expanded collapse after a remount.
2. **The minimap "N changes" action** opens the undo dialog from the stripped
   snapshot (`useOutputMinimapModel.ts` ~340-395, `OutputSection.tsx` ~1356)
   without hydrating it. A deleted file then shows "Cannot undo"
   (`resolveSnapshotUndoInstruction` needs `contentToRestore`), and modified
   files lose full-context diffs. The CLI-header "View changes" button for the
   same step works.
3. **Live-run views** loaded mid-run (panel reload, or a hosted client
   connecting while the run executes) copy stripped history into
   `workspaceSnapshots` (`workflowStore.ts` ~1635-1657) with
   `historyOutputs: null`. `handleWorkflowView` (`useOutputUndoActions.ts`
   ~466-491) decides whether to hydrate by looking only at `historyOutputs`, so
   the workflow-changes dialog opens with stripped entries.
4. **Workflow dialog path matching** (`useOutputUndoActions.ts` ~494-499) uses
   `changedFiles.find(... sameFilePath(f.path, candidate.path))`. That is the
   first-suffix match 9a353dbfa removed elsewhere, so
   `<abs>/packages/api/package.json` picks up the root `package.json`'s content.
   Lines ~510-514 also send `candidate.path` (absolute) as the instruction path
   instead of the snapshot's `change.path`.

## Steps to Reproduce

- (1) Turn on expand-all diffs and open a completed run with an edited file.
  The diff has no gap-expansion controls. Alternatively, expand a diff, scroll
  it out of view and back.
- (2) Open a completed run in which a step deleted a file and click that step's
  change badge in the minimap. The deleted file shows "Cannot undo".
- (3) Start a workflow in which step 1 deletes a file. While step 2 runs, reload
  the dashboard. After the run, open the workflow changes dialog. You get
  "Cannot undo".

## Root Cause

Hydration was added at specific call sites rather than at the point where
snapshot data is used. `OutputRow` fetches only inside
`onCollapsedChange(false)` (~931) and keeps the result in component state
(~582). The minimap path never hydrates. `handleWorkflowView` checks the wrong
store field for live runs and uses suffix matching.

## Suggested Fix

Single-source the hydration:

- Add one helper, e.g. `hydrateSnapshot(address, target, snapshot)`, in or next
  to `useWorkspaceSnapshotContent.ts`. It fetches every `changedFiles` entry
  with `contentAvailableOnDemand` and returns a snapshot with `beforeContent`
  filled in. Use it from the CLI-header, minimap, file-row and workflow-dialog
  paths.
- In `OutputRow`, fetch from an effect whenever a diff is expanded (not
  collapsed) and its matched change has `contentAvailableOnDemand`. The client
  cache makes repeat fetches cheap, so a remount simply re-reads the cache.
- In `handleWorkflowView`, find snapshots the same way `workflowChangeData`
  does (`historyOutputs` for history views, otherwise `workspaceSnapshots` /
  `finalStepWorkspaceSnapshots`), or decide by `contentAvailableOnDemand` on the
  entries themselves.
- Use `resolveSnapshotFileMatch(changedFiles, candidate.path, workspaceRoot)`
  and `change.path` in the workflow dialog.

Add Vitest coverage for each of the four cases.
