# Create / Create & Run in the template modal has no in-flight guard, so repeated submits create and run duplicate workflows

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workflow/TemplateModal.tsx`
- **Severity:** medium

## Symptom

Double-clicking **Create & Run**, or holding Ctrl+Enter in the template modal, creates several workflow lineages. Each one starts its own harness run at the same time, so the user pays for duplicate token use and gets parallel agents editing the same workspace. With **Create**, it leaves several duplicate draft lineages in history.

## Steps to Reproduce

1. Open the dashboard and choose **New Workflow**, which opens "Create Workflow from Template".
2. Pick any template, enter a workflow name and fill in the required variables.
3. Double-click **Create & Run** quickly, or focus the name input and hold Ctrl+Enter so key autorepeat fires.
4. Look at the workflow list or the run storage directory (`runsRoot/<slug>-<timestamp>/`). There are several new lineages, and each one has started a harness run.

## Root Cause

Nothing tracks that a create is pending, on either side of the message boundary.

- `src/ui/webview-react/components/workflow/TemplateModal.tsx:589-617`: `handleSubmit` posts `CREATE_WORKFLOW` unconditionally once validation passes. There is no pending/submitting state.
- `TemplateModal.tsx:738-755`: the Create and Create & Run buttons are disabled only by `!filename.trim() || !!filenameError || hasUnsatisfiedRequired`.
- `TemplateModal.tsx:620-631`: `handleKeyDown` submits on every Enter / Ctrl+Enter keydown and does not check `e.repeat`, so autorepeat submits repeatedly.
- The modal closes only when `WORKFLOW_CREATED` arrives (`src/ui/webview-react/hooks/useMessageHandler.ts:1988-1994`). The backend sends it only after async template expansion and instance creation (`src/ui/WorkflowSerializer.ts:1135-1155`), which leaves a wide window for repeat submits.
- The backend does no de-duplication. `src/ui/WebviewMessageRouter.ts:2017-2036` forwards every message, and `WorkflowSerializer.handleCreateWorkflow` creates a new instance each time via `createWorkflowFromTemplateForClient`, then calls `orchestrator.executeWorkflow(instance.id)` when `runAfter` is set (`WorkflowSerializer.ts:1157-1159`).
- `allocateWorkflowKey` (`src/utils/WorkflowPaths.ts:557-584`) gives each request a fresh timestamped lineage key, so the duplicates neither collide nor hit a runner lock.

## Suggested Fix

Add an in-flight guard to `TemplateModal`:

- Keep `isSubmitting` state, backed by a ref so two clicks in the same render frame are both caught. Set it in `handleSubmit` before posting, and return early if it is already set.
- Disable both Create buttons while it is set, and optionally show a spinner or a "Creating…" label.
- In `handleKeyDown`, ignore events where `e.repeat` is true.
- Clear the flag when `WORKFLOW_CREATED` arrives with an error, so the user can retry; on success the modal closes. The simplest way is a `uiStore` flag that the `WORKFLOW_CREATED` handler in `useMessageHandler.ts` resets, and that is also reset whenever the modal opens.

Add a Vitest case under `src/ui/webview-react/test/` that double-clicks **Create & Run** and asserts that only one `CREATE_WORKFLOW` is posted.
