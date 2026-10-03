# `ctrlyoke history show` labels final-step attempts as "Step 1/N"

- **Found:** 2026-10-03 by bug-hunt final step (claude-cli); reproduced with the built CLI
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`renderHistoryAttempt` ~586-601, `createHistoryOutputTarget` ~631-647)
- **Resolution:** fixed in this commit

## Symptom

For a workflow with two queue steps and a `finalStep` named `closer`,
`ctrlyoke history show --workflow <key> --run 1` prints:

```
│ Step 1/2 — first
│ Step 2/2 — second
│ Final Step Loop 1
│ Step 1/2 — closer
```

The final step is shown as queue step 1 of 2 (loop 2 would be "Step 2/2"), so
it reads like a re-run of the first step. The live `ctrlyoke run` output prints
only `Final Step Loop 1` for the same attempt, with no "Step x/y" header.

## Steps to Reproduce

1. Workflow with `steps: [first, second]` and a `finalStep` (prompt or script).
2. `ctrlyoke run` it, then `ctrlyoke history show --workflow <key> --run 1`.

## Root Cause

`renderHistoryAttempt` always calls `CliTerminalFormatter.renderPromptHeader`,
passing `stepIndex: target.stepIndex`, where `createHistoryOutputTarget` maps a
final-step attempt's `loopIndex` into `stepIndex`, and `totalSteps` is the queue
length.

## Suggested Fix

For `FINAL_STEP_PHASES.FINAL_STEP` attempts, don't render the queue
"Step x/N" header: keep `renderFinalStepLabel(loopIndex)` and show the step name
without the queue position (match what live `run` prints). Add a case to the CLI
history tests.
