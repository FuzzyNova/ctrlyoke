# `history steps` shows the final step as completed when a pass is still pending

- **Found:** 2026-10-03 by Claude (claude-cli) while manually testing the CLI history commands
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`stepsHistoryCommand`, `historyFinalPassRows`)
- **Severity:** low

## Symptom

In a paused run where the queue finished but the next final-step pass has not started yet, the
overview's `final` row reads `completed  17 passes`. Every queue step also reads `completed`.
Nothing in the output says that resuming the run will start another final pass (pass 18), so
the overview looks like a finished run, which contradicts the run's `paused` state in
`history runs`.

Real example: `more-bug-backlog2-2026-10-02T00-06-20-309`, `run-2026-10-02T00-12-12-449Z`. The
user paused during step 71, which had been appended by final pass 17. Step 71 finished, and
`_runtime.currentIndex` is `72`, equal to `steps.length`, so the final step runs next. The
run's state is correctly `paused`.

## Steps to Reproduce

1. Run a workflow with a `finalStep` that appends queue steps, so the final step runs more
   than one pass.
2. While a step appended by the final step is running, pause the workflow and let that step
   finish.
3. `ctrlyoke history steps --workflow <key>` shows every row completed, and `final` shows
   `completed` with N passes.

## Root Cause

The `final` row's state comes from `historyWorkingStepState(definition.finalStep._runtime)`,
which reflects the last pass that ran. `historyFinalPassRows` lists only passes that have
recorded attempts. Neither looks at the run's execution state or `currentIndex`, so a pending
pass is invisible.

## Suggested Fix

When the run is not terminal and `_runtime.currentIndex >= steps.length`, mark the final row
pending: show its state as `pending` (or `paused`) with a note such as `17 passes, 18 next`.
Add the same information to the JSON (e.g. `finalStep.nextPass: 18`). Apply the same rule to
queue rows: a non-terminal run whose `currentIndex` points at a step should label that step as
next.

## Decision

Decided 2026-10-03 (obvious, no input needed): adopt the suggested fix. When the run is not terminal and `_runtime.currentIndex >= steps.length`, the `final` row's state is `pending` and its note reads `N passes, N+1 next`. JSON gains `finalStep.nextPass` (`null` when no pass is pending). When a non-terminal run's `currentIndex` points at a queue step, that row is labelled as next, both in the table and with a `next: true` flag in JSON. Use the existing state constants, not new string literals.
