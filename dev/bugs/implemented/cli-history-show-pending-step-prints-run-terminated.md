# `history show --step` on a pending step prints "Run terminated" lines and exits 0

- **Found:** 2026-10-02 by Claude (claude-cli), running `ctrlyoke history show` against the live `more bug backlog2` run
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`showHistoryCommand`)
- **Resolution:** fixed in this commit

## Symptom

On a run that is **running** (pause/resume history: paused at 21 steps, resumed,
paused at 43, resumed), selecting a step that has not started yet prints:

```
$ ctrlyoke history show --workflow more-bug-backlog2-... --run 1 --step 56
│ ℹ Run terminated: paused
│ ℹ Run terminated: paused
```

It exits `0`. Nothing says the step is pending. The two lines describe two past
pauses that were later resumed, and are unrelated to step 56. A reader (or an
agent) concludes the run is paused, or that step 56 was cut off.

The unfiltered `history show` prints the same lines mid-stream. There they mark
where pauses happened, but "terminated" is still misleading for a pause that was
resumed, and no resume marker follows.

## Steps to Reproduce

1. Pause and resume a run at least once.
2. While it runs, `ctrlyoke history show --workflow <key> --run <ref> --step <index of a pending step>`.
3. Only `Run terminated: paused` lines are printed, and the exit code is 0.

## Root Cause

`showHistoryCommand` applies `targetFilter` only to `ATTEMPT_SETTLED` events. Every
`RUN_TERMINATED` event is rendered regardless of the filter
(`HistoryInspectionCommands.ts` ~258-267). A pause is persisted through
`finalizeRun` as a `runTerminated` timeline event with `executionState: "paused"`,
so each past pause shows up as a "termination". When no attempt matches, nothing
reports that the step has no output yet.

## Suggested Fix

- Suppress `RUN_TERMINATED` rendering when `--step` is set.
- When the filter matched no attempt, print one status line from the working
  file's `_runtime`, e.g. `Step 57 has not started (pending)` or
  `Step 57 was skipped`. Keep exit 0, since it is a valid selector with no output yet.
- In unfiltered output, render a pause that was followed by a resume as
  `Run paused` rather than `Run terminated: paused`. `--json` already
  omits these events.
