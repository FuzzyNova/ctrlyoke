# Final-step pre/end-condition summaries are dropped when each pass settles

- **Found:** 2026-11-25 by bug-hunt final step (subagent code review, reproduced)
- **Area:** `src/core/WorkflowExecutor.ts`, `src/core/PromptQueue.ts`
- **Severity:** medium

## Symptom

`ctrlyoke run --json` always reports `finalStep.lastPass.preCondition` and
`finalStep.lastPass.endCondition` as `null`, even when the final step's
conditions ran, and the run file's `_runtime.finalStep.preCondition` /
`.endCondition` fields (which the schema describes as retained for the final
step's automation result projection) are never present after a pass.

## Steps to Reproduce

1. Build a `WorkflowExecutor` + `PromptQueue` with `MockHarnessIntegration`
   and a workflow whose `finalStep` has a `preCondition` script printing `pre`
   and an `endCondition` script printing `end`.
2. Observe `recordFinalStepEndConditionSummary` is called (summary passed,
   stdout `end`).
3. After `execute()`, `promptQueue.getFinalStepRuntime()` is
   `{"phase":"finalStep","loopCount":0,"status":"completed","startedAt":…,"completedAt":…}`
   — no `preCondition` or `endCondition`.

## Root Cause

During a pass, `PromptQueue.recordFinalStepPreConditionSummary` /
`recordFinalStepEndConditionSummary` (`src/core/PromptQueue.ts` ~873, ~886) merge
the summaries into `finalStepRuntime`. When the pass settles, the executor calls
`setFinalStepRuntime` with a fresh object (no spread of the current runtime) and
`PromptQueue.setFinalStepRuntime` (~2765) replaces the whole object. This happens
at `src/core/WorkflowExecutor.ts` ~999 (completed), ~979 (appended queue work),
~2216 (failed), ~3018 (skipped) and ~2061 (no turn started). Only
`persistInterruptedFinalStepRuntime` spreads the existing runtime.
`src/cli/CliJsonResultBuilder.ts` ~481-482 reads `runtime?.preCondition` /
`runtime?.endCondition` for `lastPass`, so they are always null.

Existing coverage (`src/test/unit/PromptQueueConditionSummary.test.ts`) only
tests the queue in isolation.

## Suggested Fix

Route the settle-time writes through one helper, e.g.
`settleFinalStepRuntime(context, patch)` that writes
`{ ...this.promptQueue.getFinalStepRuntime(), ...patch }`, so the latest
pass's summaries survive. Keep the start-of-pass write (~915) clearing them so a
new pass never shows the previous pass's results.

Tests: `src/test/unit/WorkflowExecutor.test.ts` (suite "WorkflowExecutor
finalStep phase 2") asserting the runtime keeps both summaries after a completed
and a failed pass and that a new pass clears them; plus a
`src/test/unit/CliJsonResultBuilder.test.ts` case for `lastPass`.
