# Error-handling guide says `onError: continue` always fails the step and moves on

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `docs/workflows/error-handling.md` (`errorBehavior` table)
- **Resolution:** fixed in this commit

## Symptom

The `errorBehavior` table described `continue` as "The step is marked failed
with a warning, and the workflow moves on to the next step." That is true only
for a prompt/harness failure and a script step. For a condition phase the code
does what the schema description says, "proceed as if the phase had not
errored":

- An errored **pre-condition** falls through and the prompt is sent.
- An errored **end condition** accepts the response and the step completes.

## Steps to Reproduce

1. Run a prompt step with `preCondition: { script: definitely-not-a-command }`,
   `endCondition: { script: definitely-not-a-command-2 }` and
   `errorBehavior: { onError: continue }` (e.g. `ctrlyoke run --json` on
   opencode-cli with the free `opencode/big-pickle` model).
2. The prompt runs (the step has a `sessionId`) and the step's `status` is
   `completed`, not `failed`.

## Root Cause

`WorkflowExecutor.handleEvaluationError` returns `CONTINUE` for a condition
phase, and the callers fall through (pre-condition) or mark the step completed
(end condition). Only `handlePromptSendFailure` and the script-step path call
`failStep`. The docs table summarised all phases with the prompt-failure
behaviour.

## Suggested Fix

Describe `continue` per phase in the guide.
