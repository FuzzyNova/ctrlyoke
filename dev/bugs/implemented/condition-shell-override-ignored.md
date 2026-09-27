# Per-condition `shell` override is ignored for preCondition and endCondition

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/core/WorkflowExecutor.ts` (pre/end condition script reporting)
- **Resolution:** fixed in this commit

## Symptom

The workflow schema allows `shell` on `preCondition` and `endCondition`, and
`EndConditionEvaluator` honours `condition.shell`. But a condition's shell override
never takes effect: the script runs under the default shell. For example,
`endCondition: { script: "Get-ChildItem | Measure-Object", shell: pwsh }` runs under
cmd/bash and fails, or behaves differently, on a machine whose default shell is not
pwsh. Script **steps** do honour `shell`.

## Steps to Reproduce

1. On Windows with the default shell (cmd), add a step with
   `endCondition: { script: "Get-ChildItem | Measure-Object", shell: pwsh }`.
2. Run the workflow.
3. The end condition runs through the default shell rather than pwsh.

## Root Cause

All three condition call sites in `WorkflowExecutor.ts` build the properties passed to
`scriptExecutionReporter.report()` from an explicit field list:
`script, env, compareSource, operator, expected, ignoreCase, timeoutSec`. They never
pass `shell`:

- preCondition, around line 1946
- initial endCondition, around line 3709
- endCondition re-evaluation on retry (`evaluateCondition`), around line 3785

`ScriptExecutionReporter` passes those properties to
`EndConditionEvaluator.evaluateCondition`, which reads `condition.shell`
(`EndConditionEvaluator.ts:256-259`), and always gets `undefined`. Script steps pass
`shell: effectiveStep.shell` (`WorkflowExecutor.ts` ~2540). The omission dates back to
`000b97c7` ("feat: add per-script shell overrides"). Tests only exercise the
evaluator directly, so the executor wiring is uncovered.

## Suggested Fix

Stop hand-copying condition fields three times. Add one helper, e.g.
`toReportedConditionProperties(condition)`, that maps a pre/end condition to
`resolveReportedScriptProperties({...})` including `shell`, and use it at all three
sites. Also check whether the workflow-level default shell (the same fallback
`effectiveStep.shell` applies for script steps) should apply to conditions, and match
the script-step behaviour. Add a WorkflowExecutor-level test asserting that the
evaluator receives the condition's `shell` for a preCondition, an endCondition, and
an endCondition retry re-evaluation.
