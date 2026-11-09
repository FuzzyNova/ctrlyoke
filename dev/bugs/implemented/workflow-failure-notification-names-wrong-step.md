# Workflow failure notification names the wrong step

- **Found:** 2026-11-09 by bug-hunt final step (pass 16), reading ~123b7eb9c
- **Area:** `src/core/WorkflowInstance.ts` (`getSummary`), `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Resolution:** fixed in this commit

## Symptom

The **Workflow Failed** notification added in ~123b7eb9c ("include failure
details in workflow notifications") is meant to name the failing step and the
reason. In several common cases it names the wrong step or leaves the details
out:

1. **Any workflow with a `finalStep`, when a queue step fails.** The label is
   built from the final-step pass counter instead of the step index. Every queue
   failure before the first pass reads "Step 1". After pass N has appended work
   it reads "Step N+1", whatever step actually failed. For example, step 17
   failing after pass 1 is reported as "Step 2".
2. **A failure on the startup/setup path.** `PromptQueue.finalizeFailedInFlightPrompt`
   advances `currentIndex` past the step it failed. See its doc comment and the
   "reports the failed step index when execution start throws mid-run" test in
   `src/test/unit/WorkflowInstance.test.ts`. `results[currentIndex]` is then the
   next, pending step with no error. The summary falls back to `stopReason` or
   drops `failure` entirely, and the label names the next step.
3. **A parallel-group member failure** where the failed member isn't at
   `currentIndex` has the same problem as case 2.
4. **External (CLI-owned) runs** watched by the extension:
   `ExternalRunWatchCoordinator` only reads `steps[currentIndex]._runtime`. A
   failed final step (`_runtime.finalStep.status === failed`) never gets
   failure details, and cases 2 and 3 apply there too.

## Steps to Reproduce

1. Make a workflow with two queue steps and a `finalStep`. Give step 2 a
   failure it can't recover from, e.g. a script step that exits non-zero with
   `failurePolicy` left at stop.
2. Run it with workflow notifications on.
3. The notification body reads "… - Step 1 - <reason> …" when step 2 failed.

## Root Cause

In `WorkflowInstance.getSummary()`:

```ts
const failedResult = state.results[state.currentIndex];
...
stepLabel: formatStepTargetLabel(
  failedFinalStep,
  finalRuntime?.loopCount ?? state.currentIndex
),
```

- `finalRuntime` exists for every workflow that declares a `finalStep`.
  `WorkflowExecutor.initializeFinalStepRuntime` seeds it with `loopCount: 0`, so
  `finalRuntime?.loopCount ?? state.currentIndex` uses the pass counter even
  when `failedFinalStep` is false.
- `results[currentIndex]` assumes the cursor still sits on the failed step,
  which is false for cases 2 and 3.

`selectTerminalFailure` in `src/cli/CliExitCode.ts` already solves this: it
picks the failed final step or the last failed queue result. The CLI exit code
uses it, but the summary doesn't.

## Suggested Fix

- Single-source the selection. Move `selectTerminalFailure` (and its
  `TerminalFailure` type) to a shared core/utils module and re-export or import
  it from `CliExitCode.ts`. Use it in `getSummary()`:
  - for a queue failure, `formatStepTargetLabel(false, failure.index)` with the
    result's `error`/`failureKind`;
  - for a final-step failure, `formatStepTargetLabel(true, runtime.loopCount)`
    with the runtime's `failureMessage`/`failureKind`.
  - Keep the `stopReason?.message` fallback only when no failed step exists.
- In `ExternalRunWatchCoordinator`, build the same `failure` from the working
  file. Use the last step whose `_runtime.status` is failed, or
  `_runtime.finalStep` when the final step failed. Ideally share the helper by
  mapping the working file into the shape it takes.
- Tests: a `getSummary` unit test for a queue failure in a workflow with a
  `finalStep` (after a completed pass, so `loopCount > 0`); one for the
  startup-path failure where `currentIndex` was advanced; one for a final-step
  failure. Add an `ExternalRunWatchCoordinator` test for a failed final step.
