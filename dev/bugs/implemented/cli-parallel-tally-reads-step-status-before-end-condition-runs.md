# CLI parallel-group tally settles members before end-condition status

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli), reviewing d70119d08
- **Area:** `src/cli.ts` (parallel-group progress: `onPromptComplete`), `src/core/WorkflowExecutor.ts` (`dispatchCompletedOutput`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run` prints a running tally for a `parallel:` group
(`… · N running · N done · M failed`). A member whose end condition **fails** (exhausted
`onFail: retry`, or the default `stopWorkflow`) or **errors** (timeout, spawn failure)
stays under "done"; the tally keeps reading `0 failed` although the step failed.

d70119d08 was meant to fix the errored case
(`dev/bugs/implemented/cli-parallel-tally-counts-errored-end-condition-member-as-done.md`)
but does not, and it also regresses the plain failed-end-condition case, which used to
be counted through its ERROR-severity status message.

## Steps to Reproduce

1. A workflow with a `parallel:` group of two prompt steps. Member A has
   `endCondition: { script: "exit 1" }` (or `{ script: "sleep 30", timeoutSec: 1 }`).
2. `ctrlyoke run` it.
3. A's turn ends and the tally prints `1 done · 0 failed`. The end condition then fails
   and the step is marked failed, but no later tally line moves it to failed.

## Root Cause

Verified in code: d70119d08 removed the ERROR-status handler from
`onWorkflowStatusMessage` and instead reads
`promptQueue.getState().results[stepIndex].status` inside `onPromptComplete`
(#selection:src/cli.ts:1391-1409). `onPromptComplete` fires through
`OutputCaptureBuffer.captureCompletedOutput` → `finalizeAndPersistOutput` →
`dispatchCompletedOutput` when the harness turn completes, before
`WorkflowExecutor.evaluateEndCondition` runs (#selection:src/core/WorkflowExecutor.ts:2700-2730).
The queue therefore still reports the step as running at that read. Later, a failed
end condition or an errored end condition updates the queue status, but the CLI tally
has no listener for that transition. This also explains why the previous ERROR-status
path counted ordinary failures before d70119d08 but no longer does.

## Suggested Fix

Resolved by subscribing to queue state changes and settling each started tracked
member only when its status is terminal. `FAILED` maps to failed; other terminal
statuses map to completed. The exported tally helper is unit tested for failed and
errored end conditions, retry success, and ignoring members that never started.
