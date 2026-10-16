# MCP `append_step` accepts a blank prompt, and the run then fails to reload

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced against compiled `out/`)
- **Area:** `src/mcp-server.ts` (`handleAppendStep`), `src/core/orchestration/RunContinuationService.ts`
- **Resolution:** fixed in this commit

## Symptom

`append_step {"steps":[{"prompt":"   "}],"position":"end"}` returns `success: true` and writes the
step to the run's working file. Every later reload of that file then fails validation with
`Prompt N: Empty prompt text` (`PromptFileParser.ts`, `validateWorkflowSteps`):

- the run can't be reopened or resumed after a restart ("Working file validation failed");
- every later file-watcher merge throws, so the dashboard stops receiving `STEPS_EXTENDED`, even
  for valid appends that follow;
- if the executor merges the step anyway, the harness is sent an empty prompt.

`edit_step` already rejects the same input ("A prompt step must keep a non-empty prompt").

## Steps to Reproduce

1. Pause a run.
2. Call `append_step` with `{"steps":[{"prompt":"   "}],"position":"end"}`. It succeeds.
3. Run `validateWorkflowSteps` on the run's `workflow.ctrlyoke.json`. It returns
   `valid: false, ["Prompt 2: Empty prompt text"]`.

## Root Cause

`handleAppendStep` (`src/mcp-server.ts:1189-1206`) checks only for an empty `steps` array and the
script-step marker. The tool schema only requires `prompt` to be a string.
`assertStepHasRequiredContent` (`RunContinuationService.ts:1366`) exists, but only `editStepAtRun`
calls it (line 920). Neither `appendStepsToRun` nor `appendStepsToActiveParallelGroup` does.

## Suggested Fix

Call `assertStepHasRequiredContent` on every incoming step (parallel members included) in the
shared append path of `RunContinuationService`, so the MCP tool and any other caller are both
covered. Add tests for a blank top-level step and a blank parallel member.
