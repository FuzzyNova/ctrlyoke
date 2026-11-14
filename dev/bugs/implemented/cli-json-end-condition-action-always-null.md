# `--json` reports `endCondition.action: null` for every end condition

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/core/EndConditionHandler.ts` (`recordEndConditionEvaluation`), `src/core/WorkflowExecutor.ts` (`evaluateEndCondition`), `src/cli/CliJsonResultBuilder.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke run --json` gives `steps[].preCondition` and `steps[].endCondition`
the same `CliJsonCondition` shape, including `action`, `compareSource` and
`operator`. Only the pre-condition fills them in:

```json
"preCondition": { "passed": false, "action": "continue", "compareSource": "exitCode", "operator": "eq", ... },
"endCondition": { "passed": false, "action": null, "compareSource": null, "operator": null, ... }
```

An end condition always reports `action: null`. That includes passing, failing
and errored conditions, and `onFail: retry` loops. `compareSource` and
`operator` are `null` unless the workflow spells them out, even though the
defaults (`exitCode`, `eq`) were applied. A CI script cannot tell from the
JSON whether a failed end condition stopped the workflow or was continued past.

## Steps to Reproduce

1. Run a prompt step whose `endCondition.script` is a missing command, with
   `errorBehavior: { onError: continue }`. Use opencode-cli with
   `opencode/big-pickle` and `--headless --json`.
2. `steps[0].endCondition.action` is `null`, while `steps[0].preCondition.action`
   for the same setup is `"continue"`.

## Root Cause

The pre-condition summary is recorded from the reporter's verdict
(`action: preReport.verdict.action`, `compareSource`/`operator` from
`preReport.verdict`, in `WorkflowExecutor`). Both end-condition summary writers
pass only the raw `prompt.endCondition` fields and no action to
`createConditionEvaluationSummary`:

- `EndConditionHandler.recordEndConditionEvaluation`
- the errored and missing-script paths in `WorkflowExecutor.evaluateEndCondition`

So `summary.action` is never set, and `CliJsonResultBuilder` maps it to `null`.

## Suggested Fix

Record end-condition summaries from the `ScriptExecutionReporter` verdict, as
the pre-condition path does: the action actually taken, plus the resolved
`compareSource`/`operator`/`expected`. The missing-script path, which has no
verdict, should use the error action from `getErrorConditionAction`. Do not
change the `$endCondition:*` prompt-reference fields. `action` is already part
of the `CliJsonCondition` shape, so this fills an existing field and needs no
envelope version bump.
