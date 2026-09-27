# `edit_step` accepts unknown harness/model values and lets `clearProperties` remove a step's prompt

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/mcp-server.ts` (`handleAppendStep`, `handleStepEdit`), `src/core/orchestration/RunContinuationService.ts` (`NON_CLEARABLE_STEP_PROPERTIES`)
- **Resolution:** fixed in this commit

## Symptom

1. `append_step` rejects a harness or model that isn't in the capabilities cache, but `edit_step`
   writes the same values without checking. With `.ctrlyoke/capabilities.json` listing only
   `claude-cli` (models `sonnet`/`opus`):
   - `append_step {"steps":[{"prompt":"x","harness":"bogus-cli"}],"position":"end"}` fails with
     "Invalid harness 'bogus-cli'…".
   - `edit_step {"index":2,"updates":{"harness":"bogus-cli","model":"gpt-9"}}` succeeds
     (`changed: true`) and stores both values.
2. `edit_step {"index":3,"updates":{"prompt":"x"},"clearProperties":["prompt"]}` succeeds and
   leaves the step as `{"_runtime":{"stepId":"d1"}}`, a step with no prompt and no script.

Both reproduced with `node out/mcp-server.js --tool …` against a scratch run with a live runner
lock.

## Steps to Reproduce

1. Start a workflow with a pending prompt step.
2. Call `edit_step` with `updates.harness` set to an ID that isn't installed. It succeeds.
3. Call `edit_step` with `clearProperties: ["prompt"]`. It succeeds, and the step has no prompt.

## Root Cause

- The capabilities check for harness/model lives only in `handleAppendStep`
  (`mcp-server.ts:~1122-1154`). `handleStepEdit` (`~1245-1273`) doesn't call it.
- `NON_CLEARABLE_STEP_PROPERTIES` (`RunContinuationService.ts:~1232-1245`) blocks only `_runtime`,
  `status`, and `details`, and the merged step is never checked for a prompt or script afterwards.

## Suggested Fix

- Extract the append-time harness/model validation into a shared helper and call it from
  `handleStepEdit` on the merged step's effective harness/model.
- Validate the merged step before writing it: a prompt step must keep a non-empty `prompt`, and a
  script step must keep `script`. Refuse the edit with a clear message otherwise. At minimum, add
  `prompt`, `script`, and `type` to the non-clearable set.
- Tests for both refusals.
