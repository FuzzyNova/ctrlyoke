# A failed final step loses its failure kind and reason (CLI timeout exits 1, not 4)

- **Found:** 2026-10-03 by the more-bug-backlog2 workflow final step (claude-cli)
- **Area:** `src/core/WorkflowExecutor.ts` (`failStepForInternalError` and `handleHarnessFailure`, final-step branches), `src/cli/CliExitCode.ts`, `src/cli/CliJsonResultBuilder.ts`
- **Resolution:** fixed in this commit

## Symptom

When the `finalStep` fails with a timeout, or because its harness CLI is
missing, the CLI:

- exits **1** instead of the documented **4** (timeout) or **3** (missing
  harness CLI);
- reports `finalStep.failureKind: null` and `finalStep.error: null` in
  `--json`, with a generic top-level `error.message: "Final step failed"`.
  The real reason ("Script step: timed out after 1033ms") appears only deep
  in `finalStep.lastLoop.lastAttempt.reason`.

## Steps to Reproduce

```yaml
steps:
  - { type: script, script: node -e "0" }
finalStep:
  type: script
  script: node -e "setTimeout(()=>{},10000)"
  timeoutSec: 1
```

`ctrlyoke run d.ctrlyoke.yaml --headless --json`:

- **Actual:** exits 1, with `finalStep.failureKind: null`,
  `finalStep.error: null`, and `error.message: "Final step failed"`.
- **Expected:** exits 4, with `finalStep.failureKind: "timeout"` and the
  timeout reason as the final step's error and the top-level `error.message`.

## Root Cause

- In `WorkflowExecutor.failStepForInternalError` (~line 3675) and
  `handleHarnessFailure` (~line 5379), the queue branch calls
  `promptQueue.failStep(index, reason, failureKind)`. The final-step branch
  calls `setFinalStepRuntime(...)` without recording either `failureKind` or
  the failure message.
- `getExitCode` (`CliExitCode.ts`) only inspects `state.results`, which never
  contains the final step, so even a recorded kind would be ignored.

## Suggested Fix

- Record `failureKind` and the failure message on the final step's persisted
  runtime state, alongside the existing status, from both final-step failure
  branches.
- Surface them in `CliJsonResultBuilder` as `finalStep.failureKind` /
  `finalStep.error`.
- Have the terminal-failure selection used by `getExitCode` and
  `selectTopLevelError` fall back to the final step when it is the failure
  that ended the run. Share one helper; see
  `cli-exit-code-uses-first-failure-not-the-one-that-stopped-run.md`.
- If a new persisted field is needed, keep the run-file schema/docs
  (`docs/reference/run-files.md` is generated) in sync via the documented
  regeneration scripts.
- Add tests for:
  - a final-step script timeout giving exit 4, with `failureKind` and the
    message in the JSON;
  - a final-step harness-missing failure giving exit 3.
