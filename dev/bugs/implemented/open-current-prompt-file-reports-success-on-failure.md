# openCurrentPromptFile reports success even when opening the file failed

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/orchestration/WorkflowCommandHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

When the prompt file cannot be opened, the "Edit current prompt file" command and the dashboard's open-file action do nothing. This happens when the file was deleted, moved or is unreadable, or when the host returns `UNSUPPORTED`. No error notification appears. The session log shows an error line and then a contradictory `ctrlyoke: Opened prompt file: <path>` info line.

## Steps to Reproduce

1. Load a workflow file into ctrlyoke in VS Code, for example `.ctrlyoke/foo.ctrlyoke.yaml`.
2. Delete or rename that file on disk while it is still loaded.
3. Run the `ctrlyoke.editCurrentPromptFile` command, or use the dashboard's edit/open-file action.
4. Observe that no editor opens and no error toast or other feedback appears. The session log shows `[WorkflowCommandHandler] ctrlyoke: Failed to open prompt file: ...` followed by `[WorkflowCommandHandler] ctrlyoke: Opened prompt file: <path>`.

## Root Cause

In `src/core/orchestration/WorkflowCommandHandler.ts`, `openPromptFile` (lines 80-101) wraps its whole body in a try block. Inside that block, lines 89-94 turn `FAILED` and `UNSUPPORTED` `ActionResult`s into thrown `Error`s. The catch at lines 95-100 then logs the error and swallows it.

Because nothing propagates, `openCurrentPromptFile` (lines 46-72) always reaches the success log at lines 58-60. Its catch at lines 61-71 holds the only `notifyUserFeedback(USER_FEEDBACK_SEVERITY.ERROR, ...)` call, and that catch can never run.

`VsCodeDashboardHostActions.openWorkspaceTarget` (`src/platform/VsCodeDashboardHostActions.ts:23-35`) turns any exception from opening the file into a `FAILED` result. The realistic failure path therefore always ends in this swallow.

## Suggested Fix

Remove the try/catch from `openPromptFile`. `FAILED`/`UNSUPPORTED` results and any exceptions will then reach `openCurrentPromptFile`, which already logs the error and calls `notifyUserFeedback` with `ERROR` severity. This also removes the duplicate error log line.

Build the user message from `result.message` (or `error.message`) rather than `${error}`, which would add an `Error: ` prefix.

Add a `WorkflowCommandHandler` unit test whose host stub returns `{ status: FAILED, message }`. The test should assert that the feedback sink receives an `ERROR` and that the "Opened prompt file" success log is not written.
