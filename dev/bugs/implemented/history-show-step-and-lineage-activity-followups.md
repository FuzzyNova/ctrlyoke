# `history show --step` rejects every step of an unfinished run, and `_runtime.lastActivityAt` is erased by the next queue save

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent; real CLI with isolated `CTRLYOKE_HOME`, compiled `out/` script)
- **Area:** `src/cli/HistoryInspectionCommands.ts` (~l.218), `src/core/WorkingFileManager.ts` (`updateWorkingFileDirect`, ~l.2113), `src/utils/WorkingFileMetadata.ts` (`getLineageLastModifiedAt`)
- **Resolution:** fixed in this commit

Follow-ups to 1b10a6b86 (`cli-history-show-out-of-range-step-silent.md`) and 1f3b9aa42
(`lineage-recency-inconsistent-across-surfaces.md`).

## Symptom

1. **`history show --step N` fails for running, paused or unrecovered runs.** While a 2-step script
   workflow's first step was sleeping, `ctrlyoke history show --workflow <key> --run 1 --step 0`
   printed `Error: Invalid --step index: 0. This run has 0 steps.` (exit 2). Plain `history show`
   for the same run printed step 1's output. The `final` error says "this run has no valid
   zero-based step indices". The same command worked once the run completed.
2. **`lastActivityAt` doesn't survive the queue's next save.** A step appended from MCP, the CLI or
   the dashboard (`RunContinuationService.appendStepsToRun`) to a run owned by a live VS Code
   instance stamps `_runtime.lastActivityAt`. The owner's next `updateWorkingFile` (e.g. on pause)
   rebuilds `_runtime` from scratch and drops it. A working file with `lastActivityAt: 5000` and a
   step `startedAt: 1000` came back as
   `{"currentIndex":0,"executionState":"paused","schemaVersion":2}`, and lineage recency fell back
   to 1000.
3. **Recency reads every run file on each list refresh (performance).** `getLineageLastModifiedAt`
   reads and `JSON.parse`s every run's (and the draft's) `workflow.ctrlyoke.json`, all at once, with
   no cache. `WorkflowSerializer.handleGetRecentWorkflows` calls it inside a `Promise.all` over all
   lineages, so each recent-workflows refresh reads the whole history. `RunViewPublisher`,
   `WorkspaceSessionManager`, MCP and CLI `history list` do the same. This bypasses `RunSummaryCache`
   and the EMFILE-safe batching that `orchestration.instructions.md` requires for O(runs) reads. An
   EMFILE is caught and becomes `undefined`, which silently gives an older recency.

## Root Cause

1. `assertStepIndex(runSummary.stepCount, …)` uses `manifest.stepCount`.
   `TimelineRecorder.initializeRunAt` writes it as 0, and only `finalizeRun`/`reopenRun` update it.
2. `updateWorkingFileDirect` rebuilds `_runtime` (currentIndex, executionState, timing, finalStep …)
   and carries over `worktree` but not `lastActivityAt`.
3. 1f3b9aa42 routed recency through a helper that scans all run files and doesn't use the cached
   summaries.

## Suggested Fix

1. Validate `--step` against the run's working-file step count. `readRunSummaryRecord` already
   parses that file for `hasFinalStep`, so return `steps.length` alongside it and use it for both
   the index range and the `final` message. Test with a summary for a RUNNING run whose manifest
   `stepCount` is 0.
2. Preserve `_runtime.lastActivityAt` in the rebuild (same pattern as `worktree`), or take the max
   of the existing and new values. Test that an externally stamped value survives
   `updateWorkingFile`.
3. Serve per-run activity from the cached run summaries: add the latest activity time to
   `RunSummaryRecord` and derive lineage recency from `getRunSummaryRecords`. Failing that, at least
   batch the reads with the existing bounded-concurrency helper. Keep a single source for the input
   gathering.
