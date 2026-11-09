# Importing a history-only run bundle shows every step as pending, with no harness, model or elapsed time

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/orchestration/RunMaterializer.ts` (`materialize`), `src/core/orchestration/RunBundleImporter.ts`, `src/core/orchestration/RunBundleExporter.ts` (history-only bundles carry no `_runtime`)
- **Resolution:** fixed in this commit

## Symptom

Exporting a **completed** run, or any run without pending work, gives a
history-only bundle. After `ctrlyoke import`, the run itself reads as
`completed`, but every step reads as never having run:

```
# source workspace
$ ctrlyoke history steps --workflow scripted
0  one    completed  —  —  0s  1  echo hello-one
1  two    completed  —  —  0s  2  echo fixed-two
2  three  completed  —  —  0s  1  echo hello-three

# after export + import into another workspace
$ ctrlyoke history steps --workflow scripted
0  one    pending    —  —  —   1  echo hello-one
1  two    pending    —  —  —   2  echo fixed-two
2  three  pending    —  —  —   1  echo hello-three
```

`--json` reports `"state":"pending"`, `"elapsedSeconds":null`, and
`harness`/`model` `null` for every step, while `attempts` and `history show`
(both built from `events.jsonl`) show the steps did run. A shared run's steps
also lose which harness and model ran them. The dashboard reads per-step status
from the same `_runtime` blocks (`stepCapabilities.ts`, the queue's status
icons), so it very likely shows the same "not run" steps. That part was not
verified in the dashboard.

## Steps to Reproduce

```sh
R=/tmp/cyimp; rm -rf $R; mkdir -p $R/ws $R/ws2
export CTRLYOKE_HOME=$R/home
cd $R/ws && git init -q && git commit -q --allow-empty -m init
cat > wf.ctrlyoke.yaml <<'EOF'
name: scripted
steps:
  - { name: one, type: script, script: echo hello-one }
  - { name: two, type: script, script: echo hello-two }
EOF
ctrlyoke run wf.ctrlyoke.yaml
ctrlyoke export --workflow scripted -o $R/b          # "History only"
cd $R/ws2 && git init -q && git commit -q --allow-empty -m init
ctrlyoke import $R/b.ctrlyokerun
ctrlyoke history steps --workflow scripted           # every step "pending"
```

## Root Cause

A bundle's `workflow.ctrlyoke.json` is the authored definition
(`buildAuthoredWorkflow`), with no step `_runtime`. The working file with
`_runtime` (`run.ctrlyoke.json`) is written only for continuable bundles
(`RunBundleExporter.ts`, `if (continuationInfo)`). For a history-only import,
`RunBundleImporter` passes no `workingFile`, so `RunMaterializer.materialize`
writes steps with no `_runtime`. Only the root `_runtime` gets an
`executionState`. `historyWorkingStepState` (`HistoryInspectionCommands.ts`)
and the dashboard then fall back to "pending".

## Suggested Fix

Rebuild each step's runtime from the imported timeline when the bundle has no
runtime file. This also repairs bundles already shared since 0.2.0. Changing
only the exporter would not.

- In `RunMaterializer.materialize` (or in the importer before it), when
  `input.workingFile` is absent, fold the imported `attemptStarted` /
  `attemptTerminated` events per queue step (and final-step pass) into
  `step._runtime`: `terminalStatus` from the latest attempt's terminal state
  (mapped to the `PROMPT_TERMINAL_STATUS` values the live engine writes),
  `startedAt` / `completedAt`, and `harness` / `model` / `sessionId` where the
  events record them. Steps with no attempt stay pending. Reuse an existing
  timeline projection helper if one already maps attempts to step state rather
  than writing a new one.
- Keep the root `_runtime` handling and the "imported view-only" reason as is.
- Tests in `src/test/unit/RunBundleImporter.test.ts`: importing a history-only
  bundle of a completed multi-step run yields completed step runtimes
  (including a re-run step whose latest attempt passed), and an attempt-less
  step stays pending.
- Add a `CHANGELOG.md` **Fixed** entry under `## [Unreleased]`.
