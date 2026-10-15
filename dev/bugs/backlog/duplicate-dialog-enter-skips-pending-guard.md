# Pressing Enter in the Duplicate dialog skips the pending guard and creates a second workflow variant

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/workflow/DuplicateWorkflowDialog.tsx`
- **Severity:** low

## Symptom

If you press Enter more than once in the Duplicate Workflow name field before the backend replies, ctrlyoke creates two or more `<name> Copy` draft lineages. Clicking Duplicate and then pressing Enter does the same. The dashboard navigates only to the last copy. The earlier copies stay in workflow history, and nothing tells the user they were made.

## Steps to Reproduce

1. Open a workflow in the dashboard and open the Duplicate Workflow dialog.
2. With the Name field focused, press Enter twice quickly before `WORKFLOW_VARIANT_CREATED` arrives. Holding Enter so it autorepeats, or clicking Duplicate and then pressing Enter, also works.
3. Each Enter posts `CREATE_WORKFLOW_VARIANT` with a new `requestId`. The backend runs `createWorkflowVariant` once per request and allocates a separate `workflowKey` each time.
4. Open recent workflows or history. There are several `<name> Copy` lineages, and the dialog navigated only to the last one.

## Root Cause

- `DuplicateWorkflowDialog.tsx:164-172`: `handleKeyDown` calls `handleSubmit()` on Enter and never checks `isPending`. `isPending` is defined at line 174 and is used only for the Duplicate button's `disabled` prop at line 191.
- `handleSubmit` (lines 138-162) has no in-flight guard. Every call mints a new id with `nextDuplicateRequestId()` (line 150).
- The backend dedupe in `src/ui/WebviewMessageRouter.ts:1897` uses `clientId` + `requestId` as its key, so it does not catch a request that arrives with a new id.
- `src/core/orchestration/WorkflowLineageRepository.ts:121` allocates a new unique `workflowKey` for each request.
- `beginRequest` in `src/ui/webview-react/store/uiStore.ts:1704-1708` replaces the tracked `duplicateWorkflowRequest`. The `WORKFLOW_VARIANT_CREATED` handler in `src/ui/webview-react/hooks/useMessageHandler.ts:1868` then drops the earlier reply because its `requestId` no longer matches, which leaves that lineage orphaned.

## Suggested Fix

Put the in-flight guard inside `handleSubmit` so that both entry points, the Enter key and the button, are covered. Either compute `isPending` before the callbacks or read `useUiStore.getState()` inside the callback. In both cases, check `duplicateWorkflowRequest !== null && duplicateWorkflowError === null` and return early if a request is pending. Add a Vitest case to `DuplicateWorkflowDialog.test.tsx` that presses Enter twice and asserts that exactly one `CREATE_WORKFLOW_VARIANT` is posted.
