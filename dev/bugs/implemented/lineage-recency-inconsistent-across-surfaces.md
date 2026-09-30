# Lineage recency is computed from different inputs on each surface

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/WorkingFileMetadata.ts`, `src/cli/HistoryInspectionCommands.ts`, `src/core/orchestration/RunViewPublisher.ts`, `src/ui/webview-react/store/uiStore.ts`
- **Resolution:** fixed in this commit

## Symptom

Commit 512a229ff routed recency through `resolveLineageLastModifiedAt`, but
each surface feeds it different timestamps:

- The dashboard lineage list (`WorkflowSerializer`), `WorkspaceSessionManager`
  and MCP use `getWorkingFileLastActivityAt`, which covers step dispatch and
  completion times.
- CLI `history list` (`HistoryInspectionCommands.ts` ~756) and
  `RUN_SUMMARIES_LOADED` (`RunViewPublisher.ts` ~533) fold only the manifest's
  `startedAt`/`completedAt`.

Observed: after a script-only run completes, `ctrlyoke append slow.ctrlyoke.yaml
--workflow <key> --run 1` runs an 8 s step. During it, `history list --json`
still reports `lastModifiedAt` equal to the original run start, with
`completedAt: null`. It catches up only when the run finishes, and a paused
continuation stays stale.

Further consequences found by code reading (not reproduced):

- `runSummaryCacheStore.ensureRunSummaries` treats the cache as fresh only when
  the cached `lastModifiedAt` is at least the row's value. The two now come
  from different inputs, so a lineage whose working-file activity is newer than
  its manifest times re-fetches on every drill-in.
- A pure append that isn't continued stamps no activity time. Neither input
  moves, although the helper's doc comment says appends are why it exists.
- `uiStore.updateRecentWorkflowFromSummary` overwrites the row's
  `lastModifiedAt` with `summary.completedAt ?? summary.startedAt` on live
  updates, which can lower it below the resolved value.

## Suggested Fix

Compute lineage recency from one source on every surface: e.g. make the CLI
and `RunViewPublisher` use `getWorkingFileLastActivityAt` (or a single stamped
per-run activity field bumped on append/continue/transition). Make the live
`uiStore` update only raise the value.
