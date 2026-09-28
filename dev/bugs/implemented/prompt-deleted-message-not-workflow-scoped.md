# Deleting a step in one workflow overwrites other dashboards' step lists

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `promptDeleted` message path — `src/core/WorkflowTaggedSink.ts`, `src/ui/PostMessageDashboardSink.ts`, `src/types/WebviewMessageTypes.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

When a step is deleted from workflow A, every connected dashboard (VS Code webview and
hosted browser clients) replaces its displayed steps and file name with workflow A's,
even if it is showing workflow B. The view is wrong until the next full snapshot.

Reproduced through the real chain
`new WorkflowTaggedSink(new PostMessageDashboardSink(capture), "wf-A")` with the
webview store showing workflow B (`activeWorkflowId = "wf-B"`, steps `["b1","b2"]`):

- `notifyPromptsReordered` → message carries `workflowId: "wf-A"`, handler ignores it,
  steps stay `["b1","b2"]` (correct).
- `updatePromptDeleted` → `{type:"promptDeleted", fileName:"a.yaml", steps:[{prompt:"a1"}], finalStep:null}`
  with **no** `workflowId`; the store switches to `["a1"]` / `a.yaml` (wrong).

## Root Cause

`WorkflowTaggedSink`'s doc comment says it injects `workflowId` into every live-update
method, but `updatePromptDeleted` (`WorkflowTaggedSink.ts:307`) forwards without it.
`IDashboardSink.updatePromptDeleted` has no `workflowId` parameter,
`PostMessageDashboardSink.updatePromptDeleted` doesn't send one, `PromptDeletedMessage`
(`WebviewMessageTypes.ts`) has no field for it, and the `PROMPT_DELETED` handler in
`useMessageHandler.ts` applies the steps unconditionally. Sibling messages
(`REORDER_PROMPTS_CONFIRMED`, `STEP_COLOR_UPDATED`, `STEPS_EXTENDED`,
`UPDATE_FINAL_PROMPT`) carry `workflowId` and are filtered.

## Suggested Fix

Thread `workflowId` through `IDashboardSink.updatePromptDeleted`, every implementation
(`WorkflowTaggedSink`, `PostMessageDashboardSink`, `DashboardBroadcastHub`,
`CtrlYokeHostedServer`, `CtrlYokeWebviewProvider`), and `PromptDeletedMessage`, and have
the `PROMPT_DELETED` handler drop messages for a non-active workflow using the same
guard the sibling handlers use (single-source it if it's duplicated). Also make sure
`adoptPushedDefinitionRevision` is only applied for the active workflow. Add tests: a
`WorkflowTaggedSink` unit test that `updatePromptDeleted` forwards the tag, and a
webview handler test that a `promptDeleted` for another workflow leaves the store
unchanged while one for the active workflow still applies.
