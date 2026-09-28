# A timed-out script step makes the CLI exit 1, not the documented 4

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/WorkflowExecutor.ts` (`handleEvaluationError`, `failStepForInternalError`), `src/cli/CliExitCode.ts`
- **Severity:** medium

## Symptom

```yaml
steps:
  - type: script
    script: node -e "setTimeout(()=>{},10000)"
    timeoutSec: 1
```

`ctrlyoke run g.ctrlyoke.yaml --headless --json` exits **1** with
`"failureKind": null, "error": "Script step: timed out after 1028ms"`. The same happens with no
`timeoutSec` and `--script-timeout 1`. The CLI exit-code tables (`docs/cli/ci.md`, the CLI reference)
say `4` means a step timed out.

## Steps to Reproduce

1. Save the workflow above.
2. Run it headless with `--json` and check `$?`.

## Root Cause

On a script timeout, `handleEvaluationError` calls `failStepForInternalError`
(`WorkflowExecutor.ts:~3499-3526`), which calls `promptQueue.failStep(target.stepIndex, reason)`
without a `failureKind`. `getExitCode` (`src/cli/CliExitCode.ts`) returns 4 only when the failed
result's `failureKind === FAILURE_KINDS.TIMEOUT`, which only the harness paths set. The timeout flag
on the script result is known at the call site but dropped.

## Suggested Fix

Give `failStepForInternalError` an optional `failureKind` and pass `FAILURE_KINDS.TIMEOUT` when the
script/condition result timed out (covers script steps and pre/end-condition scripts). Tests: a
script step that times out records `failureKind: timeout` and `getExitCode` returns 4; a script that
merely fails still returns 1.
