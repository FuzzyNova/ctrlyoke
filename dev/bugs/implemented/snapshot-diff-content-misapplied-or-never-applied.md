# On-demand snapshot diff content is dropped for absolute paths, leaks across runs, and caches failures

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/OutputRow.tsx`, `src/ui/webview-react/hooks/useWorkspaceSnapshotContent.ts`
- **Resolution:** fixed in this commit

## Symptom

Since ccaf42888/1e418308d, a file-edit diff in a run view fetches the
snapshot's `beforeContent` on demand when it is expanded. That content feeds the
diff's expandable context gaps. Three things go wrong:

1. **Never applied for absolute paths.** Most harnesses (Claude Code, Codex,
   …) report edit events with absolute paths. For those events the fetch
   succeeds, but the result is never merged, so the diff has no old-file
   context.
2. **Leaks across runs.** Fetched content is kept in `OutputRow` state keyed
   only by file path. Row keys are not run-scoped
   (`getAttemptRowKeyBase` → `${targetKey}:run${runIndex}:attempt${attemptIndex}`,
   `utils/outputRows.ts` ~451), so after switching to another run in the same
   lineage the reused row overrides that run's `beforeContent` with the earlier
   run's text. The request also uses the live `displayedViewAddress`, not the
   address the row belongs to. That address moves optimistically before
   `RUN_VIEW_LOADED` (`uiStore.ts` ~2203), so expanding during a switch can
   fetch the other run's content into this row.
3. **Failures cached forever.** If the extension-side lookup throws,
   `WebviewMessageRouter` (~1517-1527) still replies, with no content.
   `WorkspaceSnapshotContentClient` caches that empty reply for the life of the
   webview, so the diff and the file-undo dialog preview never get content until
   a reload.

## Steps to Reproduce

1. Run a step in which Claude Code edits a file. The edit event path is
   absolute, e.g. `C:\dev\proj\src\a.ts`; the snapshot's `changedFiles[].path`
   is `src/a.ts`.
2. Open the completed run and expand that file's diff.
3. A `REQUEST_WORKSPACE_SNAPSHOT_CONTENT` is sent and answered with
   `beforeContent`, but the diff's gap expansion still has no old content.

## Root Cause

`OutputRow.tsx` ~615-640: `fetchSnapshotContent(path)` finds the snapshot entry
with `sameFilePath(change.path, path)`, which tolerates absolute-vs-relative
paths. It then stores the reply under the **event** path:
`[path]: content.beforeContent`. The merge (~598-613) reads it back by the
**snapshot** path: `loadedSnapshotContent[change.path]`. When the two differ,
the lookup misses.

The `loadedSnapshotContent` key has no run address or target (issue 2), and
`WorkspaceSnapshotContentClient.request` caches every reply unconditionally
(issue 3).

## Suggested Fix

- Key loaded content by the snapshot's own `indexedChange.path`, not the event
  path.
- Scope it to the run: build the request address from the row's run (or the
  applied view address), not the optimistic `displayedViewAddress`. Then either
  key the state by `workflowKey/runRef/target/path` and ignore non-matching
  entries, or reset it when the row's address changes.
- In `WorkspaceSnapshotContentClient`, do not cache a reply with no content. A
  failed lookup can then be retried on the next expand. The `pending` entry
  must still be cleared.
