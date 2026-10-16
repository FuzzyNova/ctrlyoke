# A pre-condition or end-condition script killed by Stop or fail-fast is treated as a real failed verdict

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/core/WorkflowExecutor.ts`
- **Resolution:** fixed in this commit

## Symptom

When ctrlyoke kills a running pre-condition or end-condition script, either
because a sibling in a `failFast` parallel group failed or because the user
pressed Stop, the kill is handled as an ordinary failed check:

- A pre-condition with the default `onFail: skipPrompt` marks the step
  **SKIPPED**. A skipped step is terminal, so Resume never runs it.
- An end condition with `onFail: continue` marks the step **COMPLETED** even
  though its check never finished. `onFail: retry` can start a retry after Stop.

The docs say a stopped step is "marked as cancelled, not failed. Resume continues
the run from where it stopped".

## Steps to Reproduce

`node out/cli.js run t.ctrlyoke.yaml --headless --json`, run in a scratch git
repo with `CTRLYOKE_HOME` pointed at a temp dir. No harness call is needed:

```yaml
steps:
  - parallel:
      - name: gated
        prompt: say hi
        preCondition:
          script: node -e "setTimeout(()=>process.exit(0),6000)"
      - name: boom
        script: node -e "setTimeout(()=>process.exit(3),500)"
    failFast: true
```

Observed for `gated`: `"status":"skipped"`, with
`preCondition: { passed: false, action: "skipPrompt", exitCode: null }`.
Expected: `cancelled`. (The fail-fast path was reproduced; the user-Stop path on
a non-parallel step was found by reading the code.)

## Root Cause

- `ScriptProcessRunner.run` returns `{ cancelled: true, errored: false }` with
  no exit code for a ctrlyoke-requested kill.
- `compareScriptOutputInline` then reports `passed: false`.
- The pre-condition branch (`WorkflowExecutor.ts` ~2101–2159) checks
  `preResult.errored` but never `preResult.cancelled`, and `evaluateEndCondition`
  (~4019–4127) has the same gap.
- Script steps do handle it (`if (evalResult.cancelled)` ~2784).
- `skipStepState` then overwrites any CANCELLED status already set, and
  `ParallelGroupRun` only relabels FAILED members as CANCELLED on fail-fast.

## Suggested Fix

In both condition paths, check the script result's `cancelled` flag (and/or the
run's abort signal) before applying `onPass`/`onFail`. Handle it the way
`executeScriptStep` handles a cancelled script step: cancel the attempt and step,
record no pass/fail verdict, and return without skipping, completing or
retrying. Add the YAML above as a regression test expecting `cancelled`, plus a
matching end-condition case.
