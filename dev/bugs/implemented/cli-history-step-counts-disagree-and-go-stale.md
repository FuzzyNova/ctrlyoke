# CLI history reports four different step counts for one run

- **Found:** 2026-10-02 by Claude (claude-cli), running `ctrlyoke history` against the live `more bug backlog2` run
- **Area:** `src/cli/HistoryInspectionCommands.ts`, `src/core/orchestration/OutputHistoryManager.ts` (`finalizeRun`)
- **Severity:** low

## Symptom

For one running run (64 steps in its working file, 56 queue attempts plus 11
`finalStep` passes recorded), the CLI reports:

| Surface                               | Shows                                                          |
| ------------------------------------- | -------------------------------------------------------------- |
| `history runs` STEPS column           | `43`                                                           |
| `history show --step 99` error        | `This run has 60 steps` (at that moment)                       |
| `history show` prompt headers         | `Step 13/21`, `Step 55/21`, `Step 56/21`                       |
| `history show` names of unnamed steps | `Step 55`, the generic fallback, even when the step has a name |

An agent cannot tell how many steps a run has, or which step is current, without
reading the working file itself.

## Steps to Reproduce

1. Run a workflow that appends steps to itself and is paused and resumed at least once.
2. `ctrlyoke history runs --workflow <key>` shows the count recorded at the last pause.
3. `ctrlyoke history show --workflow <key> --run 1` shows `Step N/<old total>` headers.

## Root Cause

- **STEPS column:** `renderRunSummaries` prints `summary.stepCount`
  (`HistoryInspectionCommands.ts` ~835), and the manifest's `stepCount` is written
  only by `OutputHistoryManager.finalizeRun` (~1007-1035). This run's two
  `runTerminated` events are its two pauses (`stepCount` 21, then 43). While a run is
  running or resumed, the column shows the count from its last pause or termination.
  The `--step` validation uses `workingFileStepCount`, which is live, hence the
  disagreement.
- **Header total and name:** `renderHistoryAttempt` takes `totalSteps` from the
  attempt's own definition snapshot (`HistoryInspectionCommands.ts` ~597). That is
  the step count when the attempt's revision was committed, not the run's total.
  Because appended steps never got a committed revision
  (`run-definition-revision-regresses-after-mcp-append.md`), steps past index 20
  have no `definition.step`, so the name falls back to `Step N`.

## Suggested Fix

- `history runs`: take STEPS from the same live source as `--step` validation
  (`workingFileStepCount ?? stepCount`), and consider showing `done/total`.
- `history show` headers: use the run's current definition for the total (or drop
  the `/total` in history views), and fall back to the working file's step `name`
  when the attempt's snapshot lacks the step.
- Fixing the revision bug removes the missing-definition half. The display should
  still not depend on it.

**Resolution:** fixed in this commit
