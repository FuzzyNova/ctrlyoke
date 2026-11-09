# Editing the failed step first lets it be moved or removed, which reassigns its history

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/RunContinuationService.ts` (`rewindTargetedFailure`, `removeStepsAtRun`, the reorder path), `src/core/PromptQueue.ts` (`rewindTerminalFailureForContinuation`, `updatePrompt`/`updateSteps`/`replaceStep`, `deletePrompts`, `reorderPendingPrompts`, insert paths), `src/core/WorkingFileManager.ts`, `src/utils/StepStatusDerivation.ts` (`getResumableTerminalFailureIndex`), `src/ui/webview-react/utils/stepCapabilities.ts`
- **Resolution:** fixed in this commit

## Symptom

`95e1194f4` (fix for `moving-or-removing-failed-step-reassigns-its-history.md`)
refuses to remove or move the terminal failed step of an errored run, because
its attempts in `events.jsonl` are keyed by queue index. The guard is bypassed
by editing the step first. The edit is allowed (by design) and persists the
step as rewound. After that, remove and reorder succeed, and the failed
attempt ends up attached to a different step:

```
$ ctrlyoke run err.ctrlyoke.yaml                         # a ok, bad fails, z pending
$ ctrlyoke step reorder --workflow errins --run 1 --order 2,1
Error: Cannot move the failed step because it has recorded history ...   # guard works
$ ctrlyoke step edit badfix.ctrlyoke.yaml --workflow errins --run 1 --index 1
Edited step 1 ...
$ ctrlyoke step reorder --workflow errins --run 1 --order 2,1
Reordered pending steps ...                              # guard bypassed
$ ctrlyoke history steps --workflow errins
0  a    completed  …  1  echo a
1  z    pending    …  1  echo z                          # z "has" bad's attempt
2  bad  pending    …  0  echo bad-output-v2; exit 3
$ ctrlyoke history show --workflow errins --step 1       # heading "bad", bad-output, ✖ Failed
```

`step remove --index 1` after the same edit also succeeds: `z` slides into
index 1 and shows `bad`'s failed attempt as its own. The same thing happens
after toggling the step's enabled state, and through the live `PromptQueue`
paths (dashboard edit, then drag or delete), because those also rewind first.
Once the failure is rewound, `currentIndex` points at it, so inserting a step
at that index (the pending head) very likely shifts it the same way. The
insert case was not reproduced.

## Steps to Reproduce

```sh
R=/private/tmp/cyedit; rm -rf $R; mkdir -p $R/ws; export CTRLYOKE_HOME=$R/home
cd $R/ws && git init -q && git commit -q --allow-empty -m init
cat > err.ctrlyoke.yaml <<'EOF'
name: errins
steps:
  - { name: a, type: script, script: "echo a" }
  - { name: bad, type: script, script: "echo bad-output; exit 3" }
  - { name: z, type: script, script: "echo z" }
EOF
cat > badfix.ctrlyoke.yaml <<'EOF'
steps:
  - { name: bad, type: script, script: "echo bad-output-v2; exit 3" }
EOF
ctrlyoke run err.ctrlyoke.yaml                                   # exits 1
ctrlyoke step edit badfix.ctrlyoke.yaml --workflow errins --run 1 --index 1
ctrlyoke step reorder --workflow errins --run 1 --order 2,1      # succeeds
ctrlyoke history steps --workflow errins                         # z: 1 attempt, bad: 0
```

(Use a real path such as `/private/tmp` on macOS. A `/tmp` symlink hits
`project-history-key-splits-on-symlinked-paths.md`.)

## Root Cause

The guard asks `getResumableTerminalFailureIndex`, which recognises the
failure only while it still has terminal runtime (`terminalStatus` /
`completedAt`) and `currentIndex` points just past it. An edit or enable toggle
calls `rewindTargetedFailure` (persisted path) or
`rewindTerminalFailureForContinuation` (live path) and **persists** the
rewind: the step's `startedAt`/`completedAt`/`terminalStatus` are stripped and
`currentIndex` is set to the failure's index. From then on the step looks like
ordinary pending work that has never run, so `getResumableTerminalFailureIndex`
returns `undefined`. The remove/reorder guards and `getStepCapabilities` stop
protecting it. Its attempts are still in the timeline at that index (`history
steps` shows `pending … 1` attempt).

## Suggested Fix

Protect a pending step whose index already has recorded attempts, not just
the un-rewound terminal failure:

- When rewinding a terminal failure for continuation, keep a durable marker on
  the step's `_runtime`, for example an optional `rewoundFailure: true` or
  `priorAttempts: <n>`. An additive optional `_runtime` field needs no format
  bump. Check `PersistedSchemaGuard`/run-file docs before choosing.
  Alternatively, protect the step at `currentIndex` whenever it has that
  marker. Do not do a timeline scan on every capability check.
- Extend the predicate the guards use (a helper next to
  `getResumableTerminalFailureIndex` in `StepStatusDerivation.ts`) so the
  rewound failure is protected exactly like the un-rewound one. That covers
  the persisted remove/reorder in `RunContinuationService` and
  `WorkingFileManager`, the live `PromptQueue.deletePrompts` /
  `reorderPendingPrompts`, inserting at its index (live and persisted), and
  `getStepCapabilities` (Delete and drag stay off; Edit and Enable stay on).
- Clear the marker once the step starts its next attempt, so normal pending
  semantics apply after it re-runs.
- Tests: in `RunContinuationService.test.ts` and `promptQueue.test.ts`, edit
  (and separately toggle enabled on) the failed step, then assert that remove,
  a reorder that moves it, and an insert at its index are rejected, and that a
  reorder keeping it first is accepted. Continuing still runs it at its
  original index with the earlier attempt counted. Add a matching
  `stepCapabilities.test.ts` case for a rewound failure.
