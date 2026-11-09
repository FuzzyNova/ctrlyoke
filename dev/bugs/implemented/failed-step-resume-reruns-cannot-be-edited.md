# The failed step that Resume re-runs cannot be edited or removed

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, CLI repro)
- **Area:** `src/core/StepIdentity.ts` (`assertStepMutable`), `src/core/PromptQueue.ts` (`rewindTerminalFailureForContinuation` and the mutation guards), `src/core/orchestration/RunContinuationService.ts` (`assertEditableDuringExecution`), `src/ui/webview-react/utils/stepCapabilities.ts` (`getStepCapabilities`)
- **Resolution:** fixed in this commit

## Symptom

Since `cd33ed82f` (fix: re-run the failed step when resuming an errored run),
Resume and `ctrlyoke continue` re-run the step that stopped an errored run.
`docs/workflows/error-handling.md` (the "Stop" section) tells the user what to
do first: "Fix the cause first, for example by editing the step or installing
the missing harness."

Editing the step is not possible. Every mutation path treats the failed step
as one that "has already run":

- `ctrlyoke step edit` / `step remove` on it fail with
  `Error: Cannot edit a step that has already run` /
  `Cannot remove a step that has already run`.
- `ctrlyoke step reorder` says the order must contain only the steps after it
  ("not-yet-started step indices (2, 3)"), so the failed step always runs
  first.
- The dashboard step menu disables Delete, Enable/Disable, Reorder and the
  prompt properties for it (`getStepCapabilities`: `index < ctx.currentStep`
  and `terminalRuntime` both lock it). MCP `edit_step` / `remove_step` go
  through the same `PromptQueue` / `RunContinuationService` guards.

So when the cause is in the step itself (a wrong script, a bad prompt, a
wrong model), the only way forward is to rerun the whole workflow. Resume
repeats the same failure every time.

## Steps to Reproduce

```sh
R=/tmp/cyedit; rm -rf $R; mkdir -p $R/ws && cd $R/ws && git init -q
export CTRLYOKE_HOME=$R/home
cat > w.ctrlyoke.yaml <<'EOF'
name: w
steps:
  - type: script
    name: a
    script: echo A
  - type: script
    name: b
    script: exit 3
  - type: script
    name: c
    script: echo C
EOF
printf 'steps:\n  - type: script\n    name: b\n    script: echo fixed\n' > fix.yaml
ctrlyoke run w.ctrlyoke.yaml --headless           # ✗ Workflow ended: error (b failed)
ctrlyoke step edit fix.yaml --workflow w --run 1 --index 1
#   Error: Cannot edit a step that has already run
ctrlyoke step remove --workflow w --run 1 --index 1
#   Error: Cannot remove a step that has already run
ctrlyoke continue --workflow w --run 1 --headless  # re-runs `exit 3`, fails again
```

## Root Cause

An errored run persists `currentIndex = failedIndex + 1` and keeps the failed
step's `_runtime` (`startedAt`, `completedAt`, `terminalStatus: failed`,
`terminalFailure`). That representation is deliberate: the dashboard reads it
to tell the stopping failure from an `onFail: continue` failure (see
`dev/bugs/implemented/resume-after-failure-skips-the-failed-step.md`). The
rewind to make the step pending again happens only when a continuation
starts, in `PromptQueue.rewindTerminalFailureForContinuation` (around line
949).

Every mutation guard runs against the settled state, before that rewind:

- `assertStepMutable` (`StepIdentity.ts`) rejects any step with `startedAt`.
- `assertEditableDuringExecution` (`RunContinuationService.ts` around line 1325) rejects `index < currentIndex` and any step with `terminalStatus`.
- `getStepCapabilities` (`stepCapabilities.ts`) locks `index < currentStep`
  and terminal runtimes.
- `PromptQueue` reorder/remove/update guards (`assertStepMutable` calls around
  lines 2279, 2936, 3162, 3493) and the "not-yet-started step indices" check.

Before `cd33ed82f` this was harmless because Resume skipped the failed step
anyway. Now that Resume re-runs it, the step is effectively pending work, yet
it is protected as history.

## Suggested Fix

Treat the terminal failure of a settled ERROR run as editable pending work,
the same step `rewindTerminalFailureForContinuation` will rewind:

1. Single-source a predicate for "the resumable terminal failure", e.g.
   `getResumableTerminalFailureIndex(executionState, currentIndex, steps,
results?)` next to `rewindTerminalFailureForContinuation` (or in
   `StepStatusDerivation.ts` so the dashboard bundle can import it): the run is
   `ERROR`, the step at `currentIndex - 1` is a queue step whose terminal
   status is failed, and its `terminalFailure !== false`. Reuse it inside
   `rewindTerminalFailureForContinuation` so the two cannot drift.
2. The simplest correct way to make every guard accept it: when a mutation
   (edit, remove, reorder, enable/disable) targets that step in a settled
   ERROR run, perform the same rewind first (reset `currentIndex` to it and
   strip its terminal runtime, keeping `stepId`), then apply the mutation
   through the normal pending-step path. Do it in both the live
   `PromptQueue` path and the persisted `RunContinuationService` path. This
   keeps the guards themselves unchanged. Remove must then leave the run
   continuing at the step that now occupies that index. Check what the rewind
   does to the settled ERROR display (the step repaints as pending, which is
   acceptable once the user has chosen to change it) and that `history steps`
   still shows the earlier failed attempt in its attempt count.
3. Dashboard: make `getStepCapabilities` allow Delete / Enable / Reorder /
   prompt properties for that step when `executionState === ERROR`, using the
   same predicate.
4. Keep these protected: a failure under `onFail: continue` /
   `onError: continue`, any failed step other than the terminal one, a failed
   final-step pass, and a stopped (cancelled) step.

Tests: `src/test/promptQueue.test.ts` and/or `src/test/unit/WorkflowInstance.test.ts`
(edit and remove of the terminal failure in an ERROR run succeed, then
continuation runs the edited step; an `onFail: continue` failure stays
locked), a `RunContinuationService` test for the persisted path, and a
`stepCapabilities.test.ts` case. Add a `CHANGELOG.md` **Fixed** entry.
