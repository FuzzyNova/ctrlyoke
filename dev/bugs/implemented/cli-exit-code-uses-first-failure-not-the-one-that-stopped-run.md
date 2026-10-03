# CLI exit code and JSON `error` report the first failed step, not the one that stopped the run

- **Found:** 2026-10-03 by the more-bug-backlog2 workflow final step (claude-cli)
- **Area:** `src/cli/CliExitCode.ts` (`getExitCode`), `src/cli/CliJsonResultBuilder.ts` (`selectTopLevelError`), `src/core/WorkflowExecutor.ts` (`handleHarnessFailure`, `onError: continue` branch)
- **Resolution:** fixed in this commit

## Symptom

If a step fails with `errorBehavior.onError: continue` and a later step then
fails and stops the run, `ctrlyoke run --headless`:

- exits with the exit code derived from the *continued* step, not the stopping
  one. A stopping harness-not-installed failure exits **1** instead of **3**,
  and a stopping timeout exits **1** instead of **4**.
- reports the continued step in `--json` as the top-level `error.step` /
  `error.message`, even though that step did not end the run.

`docs/cli/ctrlyoke.md` ("Exit codes") and `docs/cli/ci.md` promise 3 for a
missing harness CLI and 4 for a timeout, so CI scripts that branch on the code
take the wrong path.

## Steps to Reproduce

With `codex` not on `PATH`:

```yaml
harness: codex-cli
steps:
  - prompt: say hi
    errorBehavior: { onError: continue }
  - prompt: say hi again
```

`ctrlyoke run d.ctrlyoke.yaml --headless --json`:

- **Actual:** exits 1. Step 0 has `failureKind: null`; step 1 has
  `failureKind: "harnessNotInstalled"` and stopped the run; the top-level
  `error.step` is `0`.
- **Expected:** exits 3, and `error.step` is `1`.
- **Control:** the same workflow with only the second step exits 3.

## Root Cause

1. `getExitCode` (`CliExitCode.ts:20-22`) takes
   `state.results.find(r => r.status === FAILED)`, the **first** failed
   result. `selectTopLevelError` (`CliJsonResultBuilder.ts`, `steps.find(...)`)
   does the same.
2. The `onError: continue` branch of `WorkflowExecutor.handleHarnessFailure`
   calls `promptQueue.failStep(target.stepIndex, failureReason)` without a
   `failureKind`, so the continued step's kind is lost. Once that is fixed,
   rule 1 would still be wrong the other way round: a continued harness-missing
   step followed by a stopping end-condition failure would exit 3.

## Suggested Fix

- Pass the `failureKind` through in the continue branch, so every failed step
  records its own kind.
- Make `getExitCode` and `selectTopLevelError` use the failure that **ended**
  the run. That is the last failed queue result. Earlier failures can only
  precede it if the run continued past them, and a run cannot continue past the
  failure that stopped it.
- Single-source the "terminal failure" selection in one helper used by both, so
  the exit code and the JSON `error` cannot disagree.
- Keep exit 1 for runs whose terminal failure has no special kind.
- Add unit tests in the existing CLI exit-code/JSON-builder tests covering:
  - a continued failure followed by a stopping harness-missing failure
    (exit 3, `error.step` = the later step);
  - a continued harness-missing failure followed by a plain stopping failure
    (exit 1).

Related: `cli-final-step-failure-loses-kind-and-reason.md`, which covers the
final-step branch of the same exit-code logic.
