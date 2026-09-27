# A script step's own `timeoutSec` is ignored when it runs headless

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/WorkflowExecutor.ts` (`executeScriptStep`), `src/core/EndConditionEvaluator.ts`
- **Resolution:** fixed in this commit

## Symptom

A `type: script` step with `timeoutSec` runs past that limit when executed headless. Only
`execution.scriptTimeoutSec` (or `--script-timeout`) applies, so a hung script runs much longer
than the author allowed and the step can still report `completed`.

Reproduced with the real CLI (`npm run compile:extension`, `node out/cli.js`) on a script-only
workflow:

```yaml
steps:
  - name: s1
    type: script
    script: node -e "setTimeout(()=>{},10000)"
    timeoutSec: 1
```

- `ctrlyoke run to.ctrlyoke.yaml --json`: `"status":"completed"`, `durationMs: 10462`, exit 0.
- The same run with `--script-timeout 1`: `Script step: timed out after 1025ms`, exit 4.

The schema says of `timeoutSec`: "Timeout in seconds. When omitted, the
`execution.scriptTimeoutSec` setting applies".

## Steps to Reproduce

1. Save the workflow above.
2. Run `ctrlyoke run to.ctrlyoke.yaml --json`.
3. The step completes after about 10 seconds instead of timing out after 1 second.

## Root Cause

`executeScriptStep` (`WorkflowExecutor.ts:~2539-2548`) builds `resolvedProperties` with
`resolveReportedScriptProperties({ ..., timeout, shell })`, which passes a millisecond `timeout`
field. The headless evaluator (`EndConditionEvaluator.ts:~281-283`) reads only
`condition.timeoutSec` and otherwise falls back to `ConfigurationUtils.getScriptTimeoutMs()`.
The generic `T extends ScriptComparisonConfig` signature accepts the extra key, so TypeScript
doesn't flag it. Pre- and end-conditions are unaffected: `toReportedConditionProperties` (`~378`)
passes `timeoutSec`. The interactive PTY path is also unaffected because it uses the local `timeout`.

## Suggested Fix

Pass `timeoutSec: effectiveStep.timeoutSec` (the step's own value) into
`resolveReportedScriptProperties`, and keep the local millisecond `timeout` only for the PTY path.
If practical, tighten the types so a script-properties object can't carry a stray `timeout` key.
Add an executor-level test in which a script step with `timeoutSec: 1` running a longer script
times out, while the global setting is larger.
