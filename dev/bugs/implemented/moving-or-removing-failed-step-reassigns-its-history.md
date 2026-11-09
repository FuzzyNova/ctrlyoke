# Reordering or removing the failed step of an errored run gives its recorded attempts to another step

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/PromptQueue.ts` (`reorderPendingPrompts`, `deletePrompts`, the `rewindTerminalFailureForContinuation` calls added in `26a5d7f88`), `src/core/orchestration/RunContinuationService.ts` (`rewindTargetedFailure`, the reorder path changed in `6dffedab7`), `src/core/StepIdentity.ts` (`assertStartedStepPositionsPreserved`), `src/ui/webview-react/utils/stepCapabilities.ts`
- **Resolution:** fixed in this commit

## Symptom

`26a5d7f88` (fix: allow editing terminal failed steps) and `6dffedab7` let the
failed step of a settled errored run be edited, **removed and reordered**. That
step has already run: its attempt, output and verdict are in `events.jsonl`,
keyed by `target.stepIndex`. When the step moves or is removed, the events stay
at the old index, so they now belong to whichever step takes that index:

```
$ ctrlyoke run wf.ctrlyoke.yaml                   # a ok, bad fails (exit 3), z pending
$ ctrlyoke step reorder --workflow reo2 --run 1 --order 2,1
$ ctrlyoke history steps --workflow reo2
0  a    completed  …  1  echo a
1  z    pending    …  1  echo z                    # z "has" bad's attempt
2  bad  pending    …  0  echo bad-output; exit 3   # bad has none
$ ctrlyoke history show --workflow reo2 --step 1   # heading "bad", bad-output, ✖ Failed
$ ctrlyoke history show --workflow reo2 --step 2   # "--step 2 has not started (pending)"
$ ctrlyoke continue --workflow reo2 --run 1
$ ctrlyoke history steps --workflow reo2
1  z    completed  …  2  echo z                    # bad's failure + "Re-run 1 — z"
2  bad  failed     …  1  echo bad-output; exit 3
```

`step remove --index 1` on the failed step does the same thing: `z` slides
into index 1 and shows `bad`'s attempt as its own. The dashboard's output pane
and timeline read the same index-keyed events, so they very likely misattribute
the same way. That was not checked in the dashboard.

## Steps to Reproduce

```sh
R=/tmp/cyreo; rm -rf $R; mkdir -p $R/ws; export CTRLYOKE_HOME=$R/home
cd $R/ws && git init -q && git commit -q --allow-empty -m init
cat > wf.ctrlyoke.yaml <<'EOF'
name: reo2
steps:
  - { name: a, type: script, script: "echo a" }
  - { name: bad, type: script, script: "echo bad-output; exit 3" }
  - { name: z, type: script, script: "echo z" }
EOF
ctrlyoke run wf.ctrlyoke.yaml                       # exits 1
ctrlyoke step reorder --workflow reo2 --run 1 --order 2,1
ctrlyoke history steps --workflow reo2              # z: 1 attempt, bad: 0
ctrlyoke history show --workflow reo2 --step 1      # bad's output at z's index
```

## Root Cause

Timeline events address queue steps only by absolute index
(`{ kind: "queue", stepIndex }`). That is why `StepIdentity.ts` documents
started steps as "absolute-index anchors" that definition edits "may never
move, remove, or replace" (`assertStartedStepPositionsPreserved`,
`assertStepMutable`).

The fix for `failed-step-resume-reruns-cannot-be-edited.md` makes the failed
step pass those guards by **rewinding it first**: `rewindTargetedFailure` /
`rewindTerminalFailureForContinuation` strip its terminal runtime, so it no
longer counts as started. Then it treats the step as ordinary pending work. For
edit and enable/disable in place this is correct, since the index and its
history still match. For reorder and remove, the step's history is left behind
at the old index. The bug doc's own fix plan only checked "that `history
steps` still shows the earlier failed attempt in its attempt count", which
holds only when the index doesn't change.

## Suggested Fix

Keep the failed step fixed in place, but still let the user change it:

- **Edit / enable-disable** of the terminal failure: keep allowing them (they
  keep its index).
- **Reorder**: accept an order only if the terminal failure keeps its absolute
  index, so it stays first among the pending steps. Apply this in both
  `PromptQueue.reorderPendingPrompts` (live and MCP `reorder_steps`) and the
  persisted `RunContinuationService` reorder path. Reject any other order with
  a message saying the failed step has recorded history and must stay first.
  Suggest disabling or editing it instead.
- **Remove**: reject removal of the terminal failure once it has recorded
  attempts, with the same hint (disable it to skip it on continue). Apply this
  in both the live `deletePrompts` and persisted remove paths.
- Dashboard `getStepCapabilities`: keep Edit and Enable/Disable for that step,
  and turn off Delete and drag-reorder again, using the same predicate
  (`getResumableTerminalFailureIndex`).
- Check that a rejected mutation doesn't leave the run rewound. The live paths
  call `rewindTerminalFailureForContinuation()` _before_ validating, so a
  mutation that then throws must not leave the failure stripped.
- Update `docs/cli/ctrlyoke.md` (`step remove` / `step reorder`, which now say
  the failed step is reorderable) and the Unreleased `CHANGELOG.md` entry
  ("can now be edited, removed, reordered, or enabled"), which has not shipped.
- Tests: `src/test/unit/RunContinuationService.test.ts` and
  `src/test/promptQueue.test.ts` (reorder that moves the failure and removal
  of it are rejected, and an order keeping it first is accepted; editing and
  disabling still work, and continuation then runs it at its original index
  with its earlier attempt counted), plus `stepCapabilities.test.ts`. Replace
  the existing tests from `26a5d7f88` / `6dffedab7` / `4008f418a` /
  `c8ce6c64f` that assert moving or removing it succeeds.

An alternative is to give timeline events a stable `stepId` and remap on
read. That is a persisted-format change (bump the timeline format) and much
larger, so prefer the guard above.
