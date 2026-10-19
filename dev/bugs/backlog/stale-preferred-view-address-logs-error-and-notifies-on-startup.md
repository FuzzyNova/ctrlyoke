# A remembered view of a deleted run logs an ERROR and shows an error notification at startup

- **Found:** 2026-10-19 by Claude Code (log review)
- **Area:** `src/core/WorkflowOrchestrator.ts` (`handleClientReady`, `loadFreshInstanceAndReplay`), `src/core/WorkflowInstance.ts` (`loadWorkingFile`)
- **Severity:** low

## Symptom

On window startup the panel's READY carried the view it last showed (`preferredViewAddress`). That view was a run whose directory no longer exists. The orchestrator recovered correctly and fell back to a new workflow, but the attempt was logged as an ERROR with a full stack, and it raised an error-level user notification on the way:

`ctrlyoke-1792351124934.log`:

```
[2026-10-18T19:18:58.996Z] DEBUG: [WorkflowOrchestrator] buildWorkflowInstance: created inst:e52ffa26
[2026-10-18T19:18:58.999Z] ERROR: [WorkflowInstance] Failed to load workflow:: Failed to read working file: ENOENT: no such file or directory, open 'C:\Users\natha\.ctrlyoke\projects\ctrlyoke-81d730fe53ae\.runs\telemetry-smoke-test-2026-09-08T19-25-25-077\run-2026-09-08T19-28-52-059Z\workflow.ctrlyoke.json'
[2026-10-18T19:18:59.000Z] ERROR: Stack trace: Error: Failed to read working file: ENOENT ...
	at readWorkingFileFromDisk ...
	at async _WorkflowInstance.loadWorkingFile ...
	at async _WorkflowOrchestrator.loadFreshInstanceAndReplay ...
	at async RunViewPublisher.bindClientToAddressedLineage ...
	at async RunViewPublisher.loadRunViewForClient ...
	at async _WorkflowOrchestrator.handleClientReady ...
[2026-10-18T19:18:59.003Z] WARN: [WorkflowOrchestrator] handleClientReady: preferred view is not available, falling back: {"workflowKey":"telemetry-smoke-test-2026-09-08T19-25-25-077","kind":"run","runRef":"run-2026-09-08T19-28-52-059Z"}
```

The whole `telemetry-smoke-test-2026-09-08T19-25-25-077` lineage directory is gone from `.runs/`. Something deleted it after the panel last displayed it. Its key briefly shows in the header (`WorkflowStatus header badge visible=true … workflowKey=telemetry-smoke-test-…` at 19:18:59.163) before the fallback replaces it.

## Steps to Reproduce

1. Open a run in the dashboard so the panel persists it as `displayedViewAddress`.
2. Close the window (or reload it), and delete that run's lineage directory, either by hand or from another window or the CLI.
3. Reopen the window. The session log gets `ERROR: [WorkflowInstance] Failed to load workflow` with a stack, and VS Code shows an error notification `Failed to load workflow: Failed to read working file: ENOENT …`. Then the dashboard falls back normally.

## Root Cause

- `BootstrapApp.tsx:35-62` and `App.tsx:421` send the persisted `displayedViewAddress` as `preferredViewAddress` on READY, with no knowledge of whether the run still exists.
- `WorkflowOrchestrator.handleClientReady` (`WorkflowOrchestrator.ts:2277-2306`) treats a missing preferred view as an expected condition. It catches the error, logs a WARN, and falls back. But it reaches that catch only after the load path has already reported the failure as a real error:
  - `loadRunViewForClient` → `RunViewPublisher.bindClientToAddressedLineage` (`orchestration/RunViewPublisher.ts:298`) → `loadFreshInstanceAndReplay` (`WorkflowOrchestrator.ts:1408-1424`) → `WorkflowInstance.loadWorkingFile`.
  - `WorkflowInstance.loadWorkingFile` (`WorkflowInstance.ts:1627-1642`) always runs `Log.error(... loadError)` and `notifyUserFeedback(this.userFeedbackSink, "error", "Failed to load workflow: …")` before rethrowing. In VS Code that sink is `VsCodeUserFeedbackSink`, which calls `showErrorMessage` (`platform/VsCodeUserFeedbackSink.ts:44-58`).
- Nothing checks that the addressed working file exists before a fresh `WorkflowInstance` is built for it, and nothing tells `loadWorkingFile` that its caller is speculative and has a fallback.

A smaller related gap: on failure, `loadFreshInstanceAndReplay` removes the half-built instance from `this.instances` but never calls `dispose()` on it (`WorkflowOrchestrator.ts:1419-1423`).

## Suggested Fix

- In `handleClientReady` (or `RunViewPublisher` when the address comes from READY), check that the addressed run's working file exists before building an instance. A missing run should be a DEBUG/WARN-level fallback with no notification.
- Alternatively, let `loadWorkingFile` take an option such as `{ reportFailure: false }`, or move the `Log.error` + notification into the user-initiated call sites. That way a speculative restore does not surface an error the user can't act on.
- Have the fallback tell the webview to clear its persisted `displayedViewAddress`, so the stale address is not retried on every startup.
- Dispose the discarded instance in the `loadFreshInstanceAndReplay` catch block.
- Add an orchestrator unit test: READY with a `preferredViewAddress` whose run directory is missing gives no error-severity feedback and falls back to the default view.
