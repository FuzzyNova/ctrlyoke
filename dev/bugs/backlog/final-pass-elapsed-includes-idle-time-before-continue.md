# `history steps` final-step pass elapsed includes the idle time before `continue`

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`historyFinalPassRows`, `collectHistoryAttemptIndex`, `historyFinishedPassElapsedSeconds`)
- **Severity:** low

## Symptom

When a final-step pass fails and the run is continued later, `ctrlyoke
history steps` reports that pass's elapsed time as the wall-clock span from
the **first** attempt's start to the **last** attempt's end. That span includes
however long the run sat errored before `continue` (minutes, hours or days).
The `final` row's ELAPSED, `finalStep.elapsedSeconds`, and
`passes[].elapsedSeconds` all inherit it. A queue step continued the same way
reports only its own attempt time, and so does the run's own runtime record:

```
#      NAME  STATE      …  ELAPSED  ATTEMPTS
0      q     completed  …  0s       2
final  fs    completed  …  3s       1 pass        # passes[0]: attempts 2, elapsedSeconds 3.458
```

The run itself recorded `activeExecutionMs: 254`, and
`_runtime.finalStep` spans 49 ms (startedAt → completedAt). So the final
step is reported as running 13× longer than the whole run's active time. The
3.4 s is the `sleep 3` the repro waits between the failure and `continue`.

## Steps to Reproduce

```sh
R=/private/tmp/cygap; rm -rf $R; mkdir -p $R/ws; export CTRLYOKE_HOME=$R/home
cd $R/ws && git init -q && git commit -q --allow-empty -m init
cat > gap.ctrlyoke.yaml <<'EOF'
name: gap
steps:
  - { name: q, type: script, script: "test -f ok2.txt || exit 4" }
finalStep:
  name: fs
  type: script
  script: "test -f ok3.txt || exit 4"
EOF
ctrlyoke run gap.ctrlyoke.yaml; sleep 3; touch ok2.txt
ctrlyoke continue --workflow gap --run 1; sleep 3; touch ok3.txt
ctrlyoke continue --workflow gap --run 1
ctrlyoke history steps --workflow gap          # q: 0s; final: 3s
ctrlyoke history steps --workflow gap --json   # steps[0].elapsedSeconds 0.004; finalStep.passes[0].elapsedSeconds ≈ 3.4
ctrlyoke history runs --workflow gap --json    # activeExecutionMs ≈ 250
```

## Root Cause

`collectHistoryAttemptIndex` keeps only `firstStartedAt` and
`latestTerminatedAt` per target. `historyFinalPassRows` computes each pass's
`elapsedSeconds` as `(completedAt - entry.firstStartedAt) / 1000`, so every gap
between attempts in the same pass counts as elapsed. Queue rows read
`_runtime.elapsed` instead, which the executor measures per attempt.

## Suggested Fix

Accumulate each step attempt's own duration in `collectHistoryAttemptIndex`
(ATTEMPT_STARTED → its ATTEMPT_TERMINATED, keyed by the attempt identity
already tracked). Report a pass's `elapsedSeconds` as the sum of its finished
attempts' durations. Keep `startedAt`/`completedAt` as the first start and last
end. `finalStep.elapsedSeconds` keeps summing the passes. Before settling on
"sum of attempts", check what queue `_runtime.elapsed` means across
end-condition retries (`src/core/WorkflowExecutor.ts`) so both rows use the same
meaning. Add a `src/test/unit` case for `history steps` (see the existing
final-pass elapsed tests for `cli-history-steps-final-row-elapsed-always-blank.md`).
The case should have two attempts in one pass separated by a gap and assert
the gap is excluded. Add a **Fixed** entry to `CHANGELOG.md`.
