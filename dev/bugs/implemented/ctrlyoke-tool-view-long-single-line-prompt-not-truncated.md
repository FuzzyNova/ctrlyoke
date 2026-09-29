# ctrlyoke tool views: a long single-line prompt is shown in full and takes a lot of space

- **Found:** 2026-09-29 by user, during the MCP tool-call display visual test
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/AppendStepView.tsx`, `appendStepModel.ts`, `WorkflowStatusView.tsx`
- **Resolution:** fixed in this commit

## Symptom

Multi-line prompts are fine: only the first line is shown, with an "Expand prompts" toggle. But a prompt that is one very long line is not shortened at all. A ~1,300-character single-line prompt fills about 18 wrapped lines in the `append_step` Prompt cell, and about 20 lines in the `workflow_status` Name cell, so a few such steps dominate the output pane. Nothing offers to collapse them: the "Expand prompts" button only appears when a prompt contains a newline.

## Steps to Reproduce

1. Call `mcp__ctrlyoke__append_step` with a step whose `prompt` is a single line of about 1,300 characters.
2. Call `mcp__ctrlyoke__workflow_status` while that step is queued.
3. Both rows render the whole line, wrapped.

## Root Cause

"Preview" means "first line", not "bounded length":

- `appendStepModel.ts` `appendStepPromptPreview` returns `step.prompt.split(/\r?\n/, 1)[0]` with no length cap.
- `AppendStepView.tsx:193-197` only renders the Expand / Collapse button when some prompt `includes("\n")`.
- `WorkflowStatusView.tsx:98-99` derives the Name cell from the same first-line split, with no cap and no expand control.

## Suggested Fix

Cap the preview at a fixed number of characters (or CSS `line-clamp` at a few lines) in both views, with an ellipsis. Show the Expand control whenever a prompt is longer than the preview (multi-line or over the cap), not only when it contains a newline. Keep the search text and find-offset math in sync with whatever is displayed (`appendStepRowLine` and the offsets in `AppendStepView.tsx:112-115` assume the preview string). Single-source the cap so `workflow_status`, `append_step`, and `read_output` (`readOutputModel.ts:107`, `ReadOutputView.tsx:29`, which also use a first-line heading) share it.
