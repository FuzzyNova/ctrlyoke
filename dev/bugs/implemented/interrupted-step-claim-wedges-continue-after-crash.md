# Continuing a run after an extension-host crash fails with "claim alreadyClaimed"

- **Found:** 2026-10-01 by claude-cli (user-reported, `bug-backlog` run in the `bug-fix` worktree)
- **Area:** `src/core/PromptQueue.ts` (`restoreFromWorkingFile`), `src/utils/WorkflowLockManager.ts` (`normalizeStaleLocks`)
- **Resolution:** fixed in this commit. `settleInterruptedRun` (`src/utils/InterruptedRunSettlement.ts`) is now the one routine that settles a dead owner's in-flight work, and both the startup normalization and the restore path that forces a loaded run to STOPPED call it.

## Symptom

The extension host crashed (hard kill, no deactivation) while step 35 of 38 was running. VS Code
restarted the host automatically. Continuing the run then failed at once:

```text
ERROR: [executeLoadedPromptFile] Failed to execute prompt file:: Cannot dispatch step 9d70c290-…: claim alreadyClaimed
  at WorkflowExecutor.execute -> startWorkflowExecution -> prepareWorktreeAndDispatch -> executeContinuationAtRun
```

The failed attempt then recorded the step as `failed` with that message and advanced past it, so
the interrupted step's work was silently skipped by the next continue.

## Steps to Reproduce

1. Start a run with the dashboard viewing it, and kill the extension host while a step is in flight.
   The step keeps `_runtime.startedAt` with no `completedAt`.
2. Let the host restart. The panel restores its persisted run view through
   `PromptFileLoader.reloadFromWorkingFile(..., preventRunningAutoStart=true)` _before_
   orchestrator init finishes (00:09:04 vs 00:09:15 in the user's log).
3. Continue the run: `claim alreadyClaimed`.

## Root Cause

A dispatch claim is `startedAt`, and only `completedAt` releases it; the claim refuses a step that is
started but not completed. Two paths turn a dead owner's active run into a stopped one:

- `normalizeStaleLocks` (run by `ExternalRunWatchCoordinator` during init) cancels the current
  in-flight step — but only for runs still in an active state.
- `PromptQueue.restoreFromWorkingFile` with `preventRunningAutoStart` forces RUNNING/PAUSING/
  CANCELLING to STOPPED and persists it, but left the step claimed.

The restore ran first, so by the time normalization looked the run was STOPPED and was skipped. The
claim was never settled. Separately, `normalizeStaleLocks` settled only `currentIndex`, so a crash
inside a parallel group left the other in-flight members claimed.

## Fix

`settleInterruptedRun` cancels every started-but-unsettled step (advancing past the current one, as
an orderly stop does) or, with none in flight, an unfinished final step. Both paths call it, so
whichever runs first leaves a continuable run.
