# Continuing a stopped, failed or appended run ignores its recorded named worktree

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing 228023d10
- **Area:** `src/core/orchestration/WorkflowStartupPipeline.ts` (`resolveWorktree`), `src/core/WorkflowInstance.ts` (`resume`, `resumeAfterSetup`), `src/utils/WorktreeResolution.ts` (`recordedWorktreeConfigForContinue`)
- **Severity:** medium

## Symptom

`docs/workflows/worktrees.md` says "A continued run uses the branch recorded by
that run, even if the workflow's current defaults have changed." That holds
only when a **paused** run resumes. A Continue on a **stopped** or **errored**
run, a continue after appending a step to a completed run, and an idle
continuation from a set start position all re-resolve the worktree from the
workflow's current `worktree` field and `defaults.worktree`. The run's
recorded `_runtime.worktree` is ignored.

So if `defaults.worktree` changed between the stop and the Continue:

- a different `directory` makes the rest of the run execute in another
  checkout, without the earlier steps' uncommitted work;
- the same `directory` with a different `branch` switches the checkout to the
  new branch (or, when the directory is dirty, Continue refuses with the
  "commit or stash" error).

## Steps to Reproduce

1. Set `defaults.worktree = { mode: named, directory: bug-fix, branch: fix-a }`
   and run a workflow with no `worktree` of its own. Stop it after step 1.
2. Change the default to `{ mode: named, directory: research, branch: research }`.
3. Continue the stopped run (dashboard Continue, or `ctrlyoke continue`).
4. Expected: step 2 runs in `bug-fix` on `fix-a`. Actual: it runs in
   `research` on `research`.

## Root Cause

228023d10 added `recordedWorktreeConfigForContinue`, which turns the recorded
`_runtime.worktree` (`executionCheckoutRoot`, `branchName`,
`comparisonBaseLabel`) into the config used for the continuation. Its only
caller is `WorkflowInstance.resumeAfterSetup` (#selection:src/core/WorkflowInstance.ts:2631-2650),
the paused-run path.

`WorkflowInstance.resume()` (#selection:src/core/WorkflowInstance.ts:2541-2562)
sends STOPPED, ERROR and IDLE-with-position runs to
`executeLoadedPromptFile(undefined, true)`. That reaches
`WorkflowStartupPipeline.execute()`, which always calls `resolveWorktree()`
(#selection:src/core/orchestration/WorkflowStartupPipeline.ts:644-652). It
resolves from `getWorkflowFile().worktree` and
`ConfigurationUtils.getDefaultWorktree()` and never reads `_runtime.worktree`,
even though `execute()` has already computed whether this is a continuation
(`continueFromCurrent`, `classification.isAppendContinuation`,
`classification.isIdleContinuation`).

The only test is a unit test of the helper (`src/test/unit/WorktreeResolution.test.ts`).

## Suggested Fix

Single-source "resolve the worktree for this start, honoring the recorded
named worktree on a continuation" in one helper, and call it from both
`resumeAfterSetup` and `WorkflowStartupPipeline.resolveWorktree()`. In the
pipeline, apply the recorded config only when `continueFromCurrent ||
classification.isAppendContinuation || classification.isIdleContinuation`;
fresh runs and restarts from the beginning keep resolving from current config.

Test: stop a named-directory run (so `_runtime.worktree` records directory and
branch), change `getDefaultWorktree()` to another directory/branch, then
continue from STOPPED, from ERROR, and after an append. Assert the worktree
manager is asked for the recorded directory and branch each time, and that a
fresh run still uses the new default.
