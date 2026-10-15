# executeDraftAtAddress never settles when startup fails or returns before onPrepared

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/RunLifecycleService.ts`
- **Resolution:** fixed in this commit

## Symptom

When a never-run draft's Run fails during startup preflight (harness CLI missing or unauthenticated, compatibility error, missing secret, worktree or promotion failure), the promise returned by `executeDraftAtAddress` never settles. `WorkflowOrchestrator.executeDraftAtAddress` and `WorkflowStepHandlers.handleExecuteDraft` stay suspended forever, so:

- `recordSuccessfulRevisions` never runs.
- The run-action failure path (`showRunActionFailure` / `reportActionFailure`) is never reached.
- Each failed click leaks a pending promise and its closures, which hold the `WorkflowInstance` and client id.

The pipeline still reports its own status and error, so the user does see the failure in the dashboard. The harm is the hung handler and the leak, not a silent failure.

## Steps to Reproduce

1. Create a new workflow that exists only as a draft (never run), with its harness set to a CLI that is not installed or not authenticated, such as `codex-cli` on a machine without codex.
2. Open the draft in the dashboard (VS Code webview or hosted browser) and click Run. This sends `EXECUTE_DRAFT`.
3. `WorkflowStartupPipeline.execute` -> `ensureHarnessReadiness` returns false (`WorkflowStartupPipeline.ts:332-333`), so `execute` returns without calling `onPrepared`.
4. The session log has no `[WorkflowMutationCoordinator] Failed to run draft` line, and the code after the `await` at `WorkflowOrchestrator.ts:4192` (`recordSuccessfulRevisions` at line 4198) never runs. A debugger breakpoint, or a unit test with a stub instance whose `executeLoadedPromptFile` resolves without invoking `onPrepared`, shows that the returned promise never settles.

## Root Cause

In `src/core/orchestration/RunLifecycleService.ts:657-686`, `preparedPromise` resolves only from the `onPrepared` callback (line 678). It rejects only from the `.catch` on `executeLoadedPromptFile` (line 681). Nothing settles it when `executeLoadedPromptFile` resolves without having called `onPrepared`.

`WorkflowStartupPipeline.execute()` (`src/core/orchestration/WorkflowStartupPipeline.ts`) resolves normally before `onPrepared` (line 815) on several paths:

- Line 288: no prompt file is loaded.
- Line 330: `preflightCompatibility()` returns false.
- Line 333: `ensureHarnessReadiness()` returns false.
- Lines 348-349: errors thrown by `preflightSecrets`, `resolveWorktree` and `promoteFreshRun` are caught and passed to `finalizeFailure` (lines 1317-1369), which logs, notifies and reports status but does not rethrow.

`WorkflowInstance.executeLoadedPromptFile` (`src/core/WorkflowInstance.ts:2250-2267`) passes that normal resolution straight through. The hung await is at `WorkflowOrchestrator.ts:4192`, which is called from `WorkflowStepHandlers.ts:550`. That handler's catch (line 557) is the only route to `showRunActionFailure`, and its comment notes that hosted browser clients see nothing else.

`seedAndExecuteAtRun` (`RunLifecycleService.ts:528-547`) uses the same pattern but is not affected in practice, because `executeSeededRun` calls `onPrepared` before the pipeline runs.

## Suggested Fix

In `RunLifecycleService.executeDraftAtAddress`, settle the promise when execution finishes without having been prepared. For example, chain this before the existing `.catch`:

```ts
.then(() => {
  if (!prepared) rejectPrepared(new Error("Run did not start; see the workflow status for details"));
})
```

Rejecting is better than resolving because it routes through `showRunActionFailure`. The pipeline's `finalizeFailure` already shows an error toast, so avoid a duplicate: either use a quiet error type or have `handleExecuteDraft` recognize it. The alternative is to resolve and let the orchestrator skip `recordSuccessfulRevisions` when the run was not prepared.

Also:

- Catch an exception thrown by `onPrepared` itself, so `prepared` and `rejectPrepared` stay consistent.
- Apply the same guard to `seedAndExecuteAtRun` (lines 528-547) for consistency.
- Add a unit test with a stub instance whose `executeLoadedPromptFile` resolves without calling `onPrepared`, and assert that `executeDraftAtAddress` settles.
