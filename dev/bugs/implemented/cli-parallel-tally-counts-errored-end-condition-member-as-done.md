# CLI parallel-group tally counts a member whose end condition errored as done

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/cli.ts` (parallel-group progress: `onWorkflowStatusMessage`, `onPromptComplete`), `src/core/WorkflowExecutor.ts` (`handleEvaluationError`)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run` prints a running tally for a `parallel:` group (`… · N done · M failed`).
When a member's end condition **errors** (timeout, spawn failure, unsupported script)
and the error policy stops the step, the tally keeps the member under "done" and the
last line reads `0 failed`, although the step failed and the workflow stopped.

## Steps to Reproduce

1. A workflow with a `parallel:` group of two prompt steps. Member A has
   `endCondition: { script: "sleep 30", timeoutSec: 1 }` and no `errorBehavior`.
2. `ctrlyoke run` it.
3. A's turn completes and the tally prints `1 done · 0 failed`. The end condition times
   out and A fails, but no later tally line moves it to failed.

The same happens with `onError: retry` once the retries are spent.

## Root Cause

The CLI moves a member to `failed` only from an ERROR-severity status message
(#selection:src/cli.ts:1387-1405); `onPromptComplete`
(#selection:src/cli.ts:1407-1416) adds it to `completed` first. Before afd116b5c,
`handleEvaluationError` always posted "End condition errored (…) → stopWorkflow" at
ERROR severity. 0.7.0 dropped that status when the script ran and showed its own
verdict (`scriptOutputShown`, default `true`;
#selection:src/core/WorkflowExecutor.ts:4058-4067), so the CLI lost its only failure
signal for this path. A failed (non-errored) end condition still posts an ERROR status
from `EndConditionHandler`, so that path still counts.

## Suggested Fix

Derive the tally from the step's terminal state instead of status severity, e.g. from
the prompt queue's step status moving to failed or the timeline's attempt-terminal
event, so every failure path counts (and no status row has to exist just to feed the
tally). Add a CLI unit test with an errored end condition in a parallel member.
