# A running run's definitionRevision does not increase with MCP appends, and can go backwards

- **Found:** 2026-10-02 by Claude (claude-cli), inspecting the live `more bug backlog2` run with `ctrlyoke history`; the exact writer that rolls it back was not pinned down
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`appendStepsToRun`), `src/core/PromptQueue.ts` (disk merge + `updateWorkingFileDirect` writes), `src/core/orchestration/TimelineRecorder.ts` (`commitDefinitionRevisionIfNewer`)
- **Severity:** medium

## Symptom

In a long run that extends itself (a planner step plus repeated `finalStep` reviews,
all calling `append_step` against their own running run), the working file grew from
1 to 64 steps, but its `definitionRevision` ended at **5**. The revisions that
`append_step` reported back to the agent repeat and go backwards. These are the
(`newQueueSize`, `definitionRevision`) pairs recorded in that run's `events.jsonl`:

```
size=5  rev=2
size=7  rev=4   size=10 rev=4   size=13 rev=4   size=16 rev=4   size=21 rev=4
size=23 rev=6   size=28 rev=6   size=34 rev=6   size=39 rev=6   size=43 rev=6
size=47 rev=6   size=49 rev=7   size=54 rev=6   size=60 rev=6   size=64 rev=6
```

`appendStepsToRun` writes `sourceRevision + 1` (`RunContinuationService.ts` ~425)
under the run-file lock, so five consecutive appends that each report `4` mean some
other writer put the file back to `3` between them. Revision `7` followed by `6`,
and the final on-disk `5`, are outright regressions.

Consequences:

1. **The optimistic-concurrency guard is weakened.** `definitionRevision` is what
   clients echo back to reject stale edits (`core.instructions.md`). A revision
   that returns to an earlier value means a client holding that superseded number
   can pass the check again (ABA).
2. **Run history loses step definitions.** `commitDefinitionRevisionIfNewer` only
   records a `DEFINITION_REVISION_COMMITTED` event when the revision increases.
   This run has exactly two such events (revisions 3 and 5) for about 12 appends.
   Every attempt for a step past index 20 therefore resolves against the
   21-step revision-5 snapshot with `definition.step` undefined. `history show`
   then renders headers like `Step 55/21 — Step 55`, with no step name and no
   harness (see `cli-history-step-counts-disagree-and-go-stale.md`).

## Steps to Reproduce

1. Start a workflow whose first step uses `append_step` to queue several steps on
   its own run, and give it a `finalStep` that also appends.
2. Let several steps complete while appends continue.
3. Compare the `definitionRevision` in each `append_step` result with the working
   file's `definitionRevision` and with the run's `definitionRevisionCommitted` events.

The extension session log for this run (`ctrlyoke-1790978827576.log`) shows 187
`updateWorkingFileDirect write analysis` entries on the working file with
`"definitionRevision":"no-op"`, 4 with `"changed"`, and four
`mergeStepsFromDisk: Found N new steps from disk (MCP append)` merges.

## Root Cause

Not confirmed. The likely shape: the in-process `PromptQueue` keeps its own
`state.definitionRevision` and writes it back on runtime persistence
(`updateWorkingFileDirect(true, true)` after each step outcome, and similar
`_runtime` writes). It only adopts the disk revision when `mergeDiskSteps` finds new
steps (`PromptQueue.ts` ~1060-1066 and ~1110-1114). A runtime write made after an
out-of-process append, but before the next merge that adopts it, could persist the
queue's older revision over the appended one. The steps survive because the merge
restores them, but the revision does not.

## Suggested Fix

- Make every in-process working-file write take `max(diskRevision, state.definitionRevision)`
  under the working-file lock, or have runtime-only writes never write
  `definitionRevision` at all.
- Add a regression test: an out-of-process `appendStepsToRun` between two
  in-process step-outcome writes must leave the on-disk revision at least as high
  as the append's result, and must produce a `DEFINITION_REVISION_COMMITTED` event
  before the appended step's first output.
