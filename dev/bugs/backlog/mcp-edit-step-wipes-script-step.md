# `edit_step` on a pending script step replaces the whole step with the partial update

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/WorkflowStepSanitizer.ts` (`mergeWorkflowStepUpdate`), `src/core/orchestration/RunContinuationService.ts`, `src/mcp-server.ts` (`handleStepEdit`)
- **Severity:** high

## Symptom

Editing any field of a pending `type: script` step through the MCP `edit_step` tool (or the
`ctrlyoke-mcp --tool edit_step` skill path) destroys the step. The tool reports
`success: true, changed: true`, but the stored step keeps only the fields in `updates`. `type`,
`script`, `onFail`, and `_runtime.stepId` are all gone, leaving a step with neither a prompt nor a
script.

Reproduced with `node out/mcp-server.js --tool edit_step` against a scratch run with a live
runner lock:

- Step 2 before: `{"type":"script","script":"npm test","name":"tests","onFail":"stopWorkflow","_runtime":{"stepId":"c1"}}`
- `edit_step {"index":2,"updates":{"name":"renamed tests"}}` (or `{"enabled":false}`)
- Step 2 after: `{"name":"renamed tests"}`

Expected: the rename is applied and the rest of the script step is kept, or the edit is refused.

## Steps to Reproduce

1. Start a workflow whose queue has a pending script step.
2. From the harness, call `edit_step` on that step with `updates: {"name": "x"}`.
3. Read the run's `workflow.ctrlyoke.json`: the step is now just `{"name":"x"}`.

## Root Cause

`edit_step`'s `updates` object never carries `type: "script"`. `mergeWorkflowStepUpdate`
(`WorkflowStepSanitizer.ts:~583-585`) treats `isScriptStep(existing) !== isScriptStep(incoming)` as a
real type change and returns `incomingStep` wholesale. For a script target that condition is always
true, because a partial update never looks like a script step.

## Suggested Fix

In the MCP/continuation edit path (`RunContinuationService` step edit / `handleStepEdit`), treat a
partial `updates` payload as a same-kind edit: when the target is a script step, build the incoming
step as `{ ...existing, ...updates }` (or pass the existing `type` through) before calling
`mergeWorkflowStepUpdate`. Only an explicit `type` change should replace the step wholesale. Reject
prompt-only fields on a script step, or the reverse, if they don't apply. Add tests: renaming or
disabling a pending script step via `edit_step` keeps `type`, `script`, `onFail`, and the stepId.
