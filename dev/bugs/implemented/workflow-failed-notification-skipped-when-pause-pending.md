# No "Workflow Failed" notification when a run fails while a pause is pending

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code-path review
- **Area:** `src/ui/notifications/CompletionNotificationFactory.ts` (`isWorkflowCompletionTransition`)
- **Resolution:** fixed in this commit

## Symptom

If the user clicks **Pause** while a step is running (state `pausing`, which
waits for the step to finish by design) and that step then fails terminally,
the run ends in `error` but sends no "Workflow Failed" notification. This
affects the VS Code toast, the hosted browser, and web push.

## Steps to Reproduce

1. Leave `notifications.events.workflowComplete` at `all` or `failuresOnly`.
2. Start a workflow whose current step will fail terminally, e.g. an end
   condition with `onFail: stopWorkflow`, or a harness error with
   `errorBehavior: stop`.
3. Click **Pause** while that step is running.
4. The step fails, the run moves to `error`, and no notification appears.

## Root Cause

`isWorkflowCompletionTransition` (~line 128) only reports a completion when the
previous summary's `executionState` is exactly `RUNNING`. But
`WorkflowStateMachine.fail()` (`src/core/WorkflowStateMachine.ts` ~569) moves to
`ERROR` from any state, and the executor calls it on a terminal step failure
without checking for a pending pause. That happens for sequential steps
(`WorkflowExecutor.ts` ~1751), parallel groups (~1272), and the final step
(~746). The summary therefore goes `pausing → error`, and both
`NotificationManager.notifyWorkflowSummaryUpdated` and
`CtrlYokeHostedServer.notifyWorkflowSummaryUpdated` return early. A run whose
last step completes while pausing can reach `completed` straight from
`pausing` in the same way.

## Suggested Fix

Treat every state in which a step may still be executing as a valid previous
state. Either accept `EXECUTION_STATES.PAUSING` alongside `RUNNING`, or reuse
the existing shared list of "step may still be executing" lifecycle states in
`DashboardConstants.ts` (~1042-1050) so the two cannot drift apart. Add unit
tests for `pausing → error` and `pausing → completed`.
