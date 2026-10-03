# `history steps` final-step ELAPSED is always `—` even though each pass is timed

- **Found:** 2026-10-03 by Claude (claude-cli) while manually testing the CLI history commands
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`stepsHistoryCommand`)
- **Severity:** low

## Symptom

The `final` row in `ctrlyoke history steps` shows `—` for ELAPSED, and the JSON has
`finalStep.elapsedSeconds: null`. Each entry in `finalStep.passes[]` does carry
`elapsedSeconds` (for example 447.263, 825.615, …). In a real 17-pass run the passes add up to
about 2h40m, but the table shows nothing.

## Steps to Reproduce

1. Run any workflow with a `finalStep` to completion (one pass is enough).
2. `ctrlyoke history steps --workflow <key>`. The `final` row's ELAPSED is `—`.
3. `ctrlyoke history steps --workflow <key> --json`. `finalStep.elapsedSeconds` is `null`, while
   every `finalStep.passes[i].elapsedSeconds` has a value.

## Root Cause

The final row reads `historyElapsedSeconds(definition.finalStep._runtime?.elapsed)`
(`src/cli/HistoryInspectionCommands.ts:1221`). The executor never writes `elapsed` to the final
step's `_runtime`; the observed runtime has only `completedAt`, `sessionId`, and the resolved
harness fields. Queue steps get `_runtime.elapsed`, so their ELAPSED column works.

## Suggested Fix

Derive the final row's `elapsedSeconds` from `historyFinalPassRows` by adding up each completed
pass's `elapsedSeconds`. Leave it `null` only when no pass has finished. Keep the per-pass
values in JSON unchanged. Also consider whether the executor should write `_runtime.elapsed`
for the final step like it does for queue steps, so the dashboard and the CLI agree. Check
`src/core/WorkflowExecutor.ts` before choosing which side to fix.
