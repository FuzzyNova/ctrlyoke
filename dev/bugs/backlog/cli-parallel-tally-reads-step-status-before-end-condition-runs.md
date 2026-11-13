# CLI parallel-group tally never counts a member that fails its end condition

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli), reviewing d70119d08
- **Area:** `src/cli.ts` (parallel-group progress: `onPromptComplete`), `src/core/WorkflowExecutor.ts` (`dispatchCompletedOutput`)
- **Severity:** medium

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

d70119d08 removed the ERROR-status handler from `onWorkflowStatusMessage` and instead
reads `promptQueue.getState().results[stepIndex].status` inside `onPromptComplete`
(#selection:src/cli.ts:1391-1409). `onPromptComplete` fires from
`OutputCaptureBuffer.captureCompletedOutput`, which `WorkflowExecutor` calls through
`finalizeAndPersistOutput` → `dispatchCompletedOutput` as soon as the harness turn
completes, **before** `evaluateEndCondition` runs
(#selection:src/core/WorkflowExecutor.ts:2700-2730). At that moment the step is still
running, so the status is never `failed` for an end-condition failure; `promptQueue.failStep`
runs later and nothing tells the CLI tally about it. The new unit test only asserts the
queue's step status, not the CLI tally, so it passes.

## Suggested Fix

Settle a member's tally from its terminal state, not from turn completion: subscribe to
`instance.promptQueue.onDidChangeState` in `runCommand` and, for each started member of a
tracked group, move it to `failed` when `results[i].status` is `failed` and to `completed`
when it is `completed` (or skipped/continued per the existing terminal statuses), then
re-render the tally when a set changes. `onPromptComplete` can keep updating stats but
should no longer settle the member. `onPromptStart` already clears both sets on a retry.
Extract the settle logic into a small exported helper in `src/cli/` so a unit test can
drive it with a queue state: a member whose turn completed and whose end condition then
failed ends in `failed`, and a retried member that later passes ends in `completed`.
