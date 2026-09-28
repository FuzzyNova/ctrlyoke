# `UPDATE_FINAL_PROMPT` from a background workflow replaces the displayed workflow's final step

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Severity:** medium

## Symptom

`WorkflowTaggedSink.updateFinalStep` tags the message with its `workflowId`, but the webview
handler applies it whatever workflow is active. When workflow A's final step changes (for
example, an agent edits it over MCP, or A's run updates it) while the dashboard shows workflow B:

- B's final step is replaced by A's.
- B's `displayedDefinitionRevision`/`appliedDefinitionRevision` jump to A's revision.

If the user then edits B, A's final step is written into B's file.

## Steps to Reproduce

In a vitest test: set `activeWorkflowId = "wf-B"` with a final step, and dispatch
`{type: UPDATE_FINAL_PROMPT, workflowId: "wf-A", finalStep: {...}, definitionRevision: 42}`. B's
final step and its revision both change.

## Root Cause

`handlers[MESSAGE_TYPES.UPDATE_FINAL_PROMPT]` (around line 1460) lacks the
`message.workflowId !== activeWorkflowId` guard that every sibling handler has, for example
`PROMPT_DELETED` and `FINAL_PROMPT_STATUS_CHANGED`.

## Suggested Fix

Add the guard before `adoptPushedDefinitionRevision`. The same guard is copy-pasted into about 25
handlers, so extract an `isForInactiveWorkflow(message)` helper and use it everywhere, so a new
handler can't forget it. Add a vitest test.
