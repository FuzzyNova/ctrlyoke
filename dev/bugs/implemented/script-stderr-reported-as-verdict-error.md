# A script's stderr is reported as its verdict error, even when it passes

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/ScriptProcessRunner.ts` (`run`), `src/core/orchestration/ScriptExecutionReporter.ts` (`createVerdict`, `formatVerdictSummary`)
- **Resolution:** fixed in this commit

## Symptom

Any script step, pre-condition or end-condition that writes to stderr gets
its stderr text as `ScriptVerdict.error`, even when it exits 0 and passes.
Many tools write progress and warnings to stderr (npm, git, compilers), so
this is common. The effects:

- The one-line status summary replaces the comparison with the stderr text.
  The CLI prints `✔ Passed — Script step passed (oops) → continue` instead of
  `(stderr contains oop)`, and a failed exit-code check prints its stderr
  instead of `(exit code == 0, got "3")`. The dashboard status message comes
  from the same `formatVerdictSummary` (`ScriptExecutionReporter.emitStatus`,
  `WorkflowExecutor`), so it shows the same text.
- The CLI verdict block ends with a red `Error: <stderr>` line on a passing
  script.
- The `<verdict … reason="<stderr>"/>` block that `HarnessIntegration.ts`
  builds for prior context carries the stderr text as the reason on a passing
  verdict.

The dashboard's `ScriptVerdict.tsx` shows `verdict.error` in the collapsed row
only for `errored` outcomes, so the row itself looks right. Its expanded
detail still shows the error field.

## Steps to Reproduce

```sh
R=/tmp/cyerr; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q
export CTRLYOKE_HOME=$R/home
cat > c.ctrlyoke.yaml <<'EOF'
name: c
steps:
  - type: script
    name: stderr-contains
    script: echo oops 1>&2
    compareSource: stderr
    operator: contains
    expected: oop
EOF
ctrlyoke run c.ctrlyoke.yaml --headless
#  │ ✔ Passed — Script step passed (oops) → continue
#  │   Compare: stderr contains oop
#  …
#  │   Error: oops
```

## Root Cause

`ScriptProcessRunner.run` builds the completed result with

```ts
error:
  (result.terminationSignal && !result.terminatedByManager
    ? `Process terminated by ${result.terminationSignal}`
    : undefined) ||
  result.stderr.trim() ||
  undefined,
errored: false,
```

so a script that exited normally gets its stderr as `error`.
`EndConditionEvaluator` carries it through (`error: comparison.error ??
result.error`), and `ScriptExecutionReporter.createVerdict` copies it into
`verdict.error` (`result.error ?? result.comparisonReason`) whatever the
outcome. `formatVerdictSummary` then prefers `verdict.error` over the
comparison, and `CliTerminalFormatter.renderScriptVerdict` prints it as
`Error:`. The stderr text is already available separately as `stderr`.

## Suggested Fix

Stop putting stderr in `ScriptProcessResult.error`. Keep only real failure
text there: the external termination signal, spawn errors and timeouts (the
`catch` path). First audit every reader of `ScriptProcessResult.error` /
`EvaluationResult.error` (`EndConditionEvaluator`, `EndConditionHandler`,
`WorkflowExecutor`, worktree setup in `WorktreeManager`, precondition
summaries) for one that relied on the stderr fallback to explain a failure.
If one does, have it read `stderr` explicitly. Add tests that a passing script
with stderr has no `verdict.error` and that its summary shows the comparison.
Add one more test that a failing exit-code script's summary still reads
`exit code == 0, got "N"`.
