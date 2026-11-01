# `history show --step final` says "pending" for a final step that was skipped

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/cli/HistoryInspectionCommands.ts`
- **Severity:** medium

## Symptom

The "final step has not run" notice added in 5df7b1fe1 reports a skipped final
step as pending, which contradicts `history steps` for the same run:

- `ctrlyoke run --json` → `finalStep.status: "skipped"`
- `ctrlyoke history steps --json` → `finalStep.state: "skipped"`
- `ctrlyoke history show --step final` (also `final:2`, `final:latest`) →
  `--step final: the final step has not run (pending)`; the `--json` notice
  carries `"status":"pending"`.

## Steps to Reproduce

1. Workflow with one script step (`echo a`) and
   `finalStep: { enabled: false, type: script, script: echo final }`.
2. `ctrlyoke run` it.
3. `ctrlyoke history show --step final` prints the "pending" notice.

Reproduced with the built `out/cli.js` against a scratch workspace.

## Root Cause

The notice branch in `showHistoryCommand` (around
#selection:src/cli/HistoryInspectionCommands.ts:791-806) derives its state with
`historyWorkingStepState(workingDefinition?.finalStep?._runtime)`. A skip is
recorded in the run-level `_runtime.finalStep.status` of the working file; a
disabled final step has no `finalStep._runtime` at all, so the helper falls
through to `PENDING`. `history steps` already reads the right place
(`definition._runtime?.finalStep?.status`, then the last pass, then
`finalStep._runtime`, around lines 1281-1289), so the two commands disagree.

Contributing: `OutputHistoryManager` sets
`hasFinalStep: workingFile.finalStep !== undefined` (around
`src/core/orchestration/OutputHistoryManager.ts:1599`) and ignores
`enabled: false`, unlike `deriveWorkflowFinalStepSummary` in
`src/types/CtrlYokeTypes.ts`. Changing that alters which message users see
("This run has no final step" error vs. notice); leave it unless the fix needs
it, and if changed, add a CHANGELOG **Changed** entry.

## Suggested Fix

Extract the `history steps` final-state derivation into one helper (run-level
`_runtime.finalStep.status` → last recorded pass → `finalStep._runtime`) and use
it in both places. Give the notice a `SKIPPED` branch, mirroring the queue-step
wording (`--step final was skipped`). Cover it in
`src/test/unit/HistoryInspectionCommands.test.ts` beside the 5df7b1fe1 cases,
with a working file whose `_runtime.finalStep.status` is `skipped`.
