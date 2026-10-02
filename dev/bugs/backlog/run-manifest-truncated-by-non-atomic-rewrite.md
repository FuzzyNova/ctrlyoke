# Run manifest truncated to 0 bytes by non-atomic rewrite

- **Found:** 2026-10-02 by bug-hunt final step (found on disk in this worktree's run history, then traced in source)
- **Area:** `src/core/orchestration/TimelineRecorder.ts`
- **Severity:** high

## Symptom

A run's `manifest.json` can be left as an empty (0-byte) file. When that
happens the run drops out of history:

- `ctrlyoke history list` counts it (`RUNS 1`), but `ctrlyoke history runs --workflow <key>`
  lists nothing.
- Every history search prints `Rebuilding search index (0/1 runs)…` and runs
  an incremental rebuild. The run is still never indexed:
  `computeHistorySearchIndexDiff` in
  `src/core/orchestration/historySearchRebuildWorker.ts` keeps classifying it
  as a "new run not yet indexed", and both rebuild paths skip it when
  `readManifestSafe` returns `null`. This is a secondary, lower-severity effect.
  It takes the index lock and rewrites the index manifest on every query, but
  results are still correct.
- Anything that calls `TimelineRecorder.readManifest` on it (run view load,
  output resolution, continuation, `appendEvents`) throws
  `Unexpected end of JSON input`.

This is not hypothetical. This worktree's user-mode history
(`~/.ctrlyoke/projects/bug-fix-98eaf41dc0e3/.runs/repro-script-timeout-2026-09-28T01-30-27-503/run-2026-09-28T01-30-27-530Z/`)
holds exactly this state: `manifest.json` is 0 bytes, and a stale
`manifest.json.lock` (`44144 2026-09-28T01:30:27.638Z`) is still there.
`events.jsonl` has four complete events, the last stamped `01:30:27.634`. So
the CLI process took the manifest lock 4 ms after appending the last event,
truncated `manifest.json`, and exited before the new contents were written.
That run failed normally, on an execution-root lease conflict. Nothing
crashed: an ordinary CLI failure exit was enough.

## Steps to Reproduce

1. Run any workflow from the CLI that fails right after starting. For example,
   start it while another run holds the execution-root lease, or kill the
   process while a step is streaming events.
2. If the exit lands inside `TimelineRecorder.writeManifestDirect` (it runs
   after every `appendEvents` batch, so this window comes up constantly),
   `manifest.json` is left truncated.
3. Run `ctrlyoke history runs --workflow <key>`: the run is missing. Open the
   lineage in the dashboard: the run is missing or fails to load.

Deterministic unit repro: stub `fs.promises.writeFile` (or kill the process)
after the file is opened with `w` but before the data is flushed.
`writeManifestDirect` has no temp file to fall back on, so the old manifest
contents are already gone.

## Root Cause

`TimelineRecorder.writeManifestDirect` (`src/core/orchestration/TimelineRecorder.ts`,
about lines 109–133) rewrites the manifest in place with `fs.promises.writeFile`.
That truncates the file first and then writes it. Its own comment admits this
("this is a non-atomic write"). Every `appendEvents`,
`commitDefinitionRevisionIfNewer`, `updateManifest`/`reopenRun` and
`initializeRunAt` goes through it, so the manifest is rewritten many times per
run, and a process exit, crash, or kill during any one of those rewrites
leaves it empty.

This also breaks the documented convention in
`.github/instructions/orchestration.instructions.md`: "Replace run/lineage
files only through `AtomicFileUtils` (`writeFileAtomic` /
`renameWithTransientRetry`)". The run's working file (`WorkingFileManager`)
and the lineage descriptor already follow it. The manifest is the one run file
that doesn't.

### Related writers that bypass the same convention

Two run-working-file writers use a bare `writeFile(tmp)` + `fs.rename`. The
convention bullet says this fails with `EPERM` on Windows under ctrlyoke's own
read load. They also skip `RunSummaryCache` write-through invalidation, because
they don't go through `WorkingFileManager`'s single writer:

- `OutputHistoryManager.repairWorkingFileTokenTotals`
  (`src/core/orchestration/OutputHistoryManager.ts`, about line 1868; fixed temp
  name `${runFilePath}.token-totals.tmp`)
- `ExternalRunWatchCoordinator`'s `handleExternalRunFinished` normalization
  (`src/core/orchestration/ExternalRunWatchCoordinator.ts`, about line 900;
  fixed temp name `workingFilePath + ".tmp"`)

Both swallow and log the failure, so the impact is a lost repair or
normalization, not corruption. They are the same class of defect, though, and
should be fixed together.

## Suggested Fix

- Make `writeManifestDirect` write through `writeFileAtomic` from
  `src/utils/AtomicFileUtils.ts`: temp file plus rename, with the
  transient-sharing retry that the Windows read-load case needs. Keep the
  `invalidateRunSummaryFor` call in `finally`, and keep `assertWritableSchema`
  and redaction exactly as they are.
- Update the `finally` comment, since the write is now atomic. The
  invalidation is still correct to keep in `finally`.
- Add a Mocha test showing that a failing write leaves the previous manifest
  contents intact. For example, inject a failure into the rename or temp write,
  or check that no reader ever sees an empty manifest while concurrent
  `appendEvents` run.
- Route the two related working-file writers through the existing atomic
  working-file writer (`writeWorkingFileAtomicTo` in
  `src/core/WorkingFileManager.ts`, or `writeFileAtomic` plus
  `invalidateRunSummaryFor` if that writer's signature doesn't fit). That
  gives them the transient-rename retry, unique temp names, and cache
  invalidation.
- Out of scope here: whether the CLI should wait for queued timeline writes
  before exiting. Atomic replacement makes an early exit harmless (the old
  manifest survives, and stale-lock recovery already handles the leftover
  `.lock` file).
