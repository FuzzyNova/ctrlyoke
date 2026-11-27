# `history steps` reports every finished final-step pass as running

- **Found:** 2026-11-27 by Claude Code (claude-cli), while inspecting a long Large Spec Loop run
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`collectHistoryAttemptIndex`), `src/core/orchestration/RunOutputResolver.ts` (`streamAttemptLifecycle`)
- **Severity:** medium

## Symptom

`ctrlyoke history steps --json` on a run whose `finalStep` has a `preCondition`
or `endCondition` reports every pass as `"state": "running"` with
`"completedAt": null` and `"elapsedSeconds": null`, including passes that
finished hours earlier. The final step's total elapsed time is `null` as a
result. On the 15-pass `workflow-step-plan` run (Large Spec Loop template, which
puts a clean-tree pre- and end-condition on its final step), all 15 passes
showed `running`.

The same index feeds `history show --step running`. Any step or pass with a
condition script whose attempt has finished still matches `running`, so the
selector returns finished attempts.

Queue steps in the `history steps` table look right only because their state
comes from the run file's `_runtime.terminalStatus`, not from this index.

## Steps to Reproduce

1. Run any workflow whose `finalStep` has `endCondition: { script: "true" }`
   for at least one pass, and let it finish.
2. `ctrlyoke history steps --workflow <key> --json`
3. Every `finalStep.passes[]` entry has `state: "running"` and
   `completedAt: null`.

## Root Cause

Condition and setup script attempts record `attemptStarted` (with a `phase`)
but never `attemptTerminated`. `history-show-marks-every-condition-script-unterminated`
(`dev/bugs/implemented/`) fixed this for `RunOutputResolver`'s settled-attempt
projection by treating `scriptExecutionRecorded` as the terminal record for
phase attempts. The compact lifecycle path didn't get the same fix:

- `RunOutputResolver.streamAttemptLifecycle` yields only `attemptStarted` and
  `attemptTerminated` events, so the script completion record never reaches it.
- `collectHistoryAttemptIndex` (`HistoryInspectionCommands.ts`) adds every
  `attemptStarted` phase to `openPhases`, and only an `attemptTerminated` with
  the same phase removes it. A condition phase therefore stays open forever.
- `running` is built from `openPhases.values()`, the phase-less identity key.
  That key is shared with the pass's AI attempt, so `historyFinalPassRows`
  sees the pass's latest attempt as running and reports it as running with no
  `completedAt`.

## Suggested Fix

Make `streamAttemptLifecycle` also yield `scriptExecutionRecorded` for
phase-scoped attempts, as a terminal lifecycle record. Use the same rule the
earlier fix applied in `RunOutputResolver`, ideally by sharing one helper so the
two projections can't diverge again. Then have `collectHistoryAttemptIndex` close
the phase on it. A condition script that really was cut off (no
`scriptExecutionRecorded`) must still leave its phase open.

Add a `HistoryInspectionCommands.test.ts` case: a final step with pre- and
end-conditions, one finished pass → `history steps --json` reports the pass
`completed` with a `completedAt`, and `history show --step running` selects
nothing.
