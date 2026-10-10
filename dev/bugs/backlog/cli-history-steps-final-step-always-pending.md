# `ctrlyoke history steps` reports a finished final step as `pending`

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with the built CLI on a script-only workflow)
- **Area:** `src/cli/HistoryInspectionCommands.ts` (final-step row of `history steps`)
- **Severity:** medium

## Symptom

After `ctrlyoke run` completes a workflow that has a `finalStep`,
`ctrlyoke history steps --workflow <key>` prints the final row as
`final  fin  pending  …  1 pass`, and `--json` gives
`finalStep.state: "pending"`. In the same output every pass of that row is
`completed`, and the working file has `_runtime.finalStep.status: "completed"`
and `executionState: "completed"`.

## Steps to Reproduce

1. Create a workflow with two script steps and a script `finalStep`.
2. `ctrlyoke run ok.ctrlyoke.yaml` → exits 0.
3. `ctrlyoke history steps --workflow <key>` → the final row's state is
   `pending`. Expected: `completed`.

## Root Cause

`src/cli/HistoryInspectionCommands.ts:1244-1252` takes the row state from
`historyWorkingStepState(definition.finalStep._runtime)`, which looks for
`terminalStatus`, `completedAt` or `startedAt`. The engine never writes those to
`finalStep._runtime`. It writes only harness/model/mode/session/secrets there
(see `WorkflowExecutor.ts`). The final step's phase and status live in the root
`_runtime.finalStep` block (`{ phase, loopCount, status, startedAt,
completedAt }`), as the schema description for `finalStep._runtime` says. The
unit test fixture in `src/test/unit/HistoryInspectionCommands.test.ts` (~730)
puts `terminalStatus` on `finalStep._runtime`, a shape the engine never
produces, which is why this went unnoticed.

## Suggested Fix

Derive the row state from the root `definition._runtime?.finalStep` block (its
`status`), falling back to the last pass's state. Keep the existing `nextPass` →
`pending` override for a run whose next pass is queued. Change the test fixture
to the shape the engine actually writes, and add a case with only root
`_runtime.finalStep.status: "completed"`.
