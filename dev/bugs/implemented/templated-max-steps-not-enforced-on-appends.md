# A `maxSteps: "{{var}}"` cap is never enforced on appended steps

- **Found:** 2026-11-25 by bug-hunt final step (subagent code review, reproduced)
- **Area:** `src/core/orchestration/RunContinuationService.ts`, `src/core/WorkflowInstance.ts`, `src/mcp-server.ts`
- **Resolution:** fixed in this commit

## Symptom

`maxSteps` is a documented run-start `{{var}}` field
(`docs/workflows/variables.md`, `src/utils/VarSubstitutionPolicy.ts:201`). When
a workflow writes `maxSteps: "{{cap}}"`, the executor honours the substituted
number, but every append path compares against the raw string `"{{cap}}"`:
`exceedsLimit` (`src/utils/LimitUtils.ts`) compares a count with a non-number,
which is always false, so appends are accepted without limit. MCP
`workflow_status` reports `maxSteps: "{{cap}}"` and `remainingSteps: null`
(`NaN` serialized), although the docs promise numbers.

This defeats the run-wide cap that bounds self-extending workflows (e.g. an
agent looping on `append_step`).

## Steps to Reproduce

1. Seed a run file with one step, `maxSteps: 1`, and call
   `RunContinuationService.appendStepsToRun` with two steps → rejected with
   `Step limit reached: this run has 1/1 steps (workflow maxSteps: 1)`.
2. Repeat with `maxSteps: "{{cap}}"` and `vars: { cap: "1" }` → the append
   succeeds and the run now has 3 steps; `maxSteps` still reads `{{cap}}`.

## Root Cause

The run file keeps placeholders (`RunStartView.ts`); only `WorkflowExecutor`
reads the substituted value via `getRunStartWorkflow(context).maxSteps`
(`src/core/WorkflowExecutor.ts` ~753, ~972). The other readers use the raw field:

- `src/core/orchestration/RunContinuationService.ts:453` (`appendStepsToRun`,
  used by MCP `append_step`, CLI `append`, `RunLifecycleService`) and `:702`
  (`appendStepsToActiveParallelGroup`): `source.maxSteps`.
- `src/core/WorkflowInstance.ts` ~2996 (dashboard append) and ~3890
  (`getStepLimitError`): `this.promptQueue.getWorkflowFile().maxSteps`.
- `src/mcp-server.ts` ~1377 and ~1399 (`workflow_status`): `queueData.maxSteps`.

`resolveEffectiveMaxSteps` passes the string through unchanged.

## Suggested Fix

Add one shared helper that resolves a workflow's effective `maxSteps` through
run-start substitution (`VarSubstitutor.substituteWorkflowRootView(source,
source.vars ?? {}, RUN_START)` or the run's `RunStartView`) and use it in every
reader above before `resolveEffectiveMaxSteps`. CLI `--var` values are merged
into the persisted run-file `vars`, so the cross-process paths can resolve from
the run file. An unresolvable placeholder should behave like the executor does
for the same value (check what `getRunStartWorkflow` does) rather than mean
"unlimited".

Tests: `src/test/unit/RunContinuationService.test.ts` (next to "reads a changed
workflow maxSteps value on the next locked append") and
`src/test/unit/McpServer.test.ts` (next to the MCP append `maxSteps` test, plus
`workflow_status` numbers). Cover the dashboard `WorkflowInstance` path too.
