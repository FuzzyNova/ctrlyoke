# Steps panel "Copy full output" omits the prompt

- **Found:** 2026-10-13 by Claude Code (while fixing output-pane-prompt-row-missing-after-timeline-v2)
- **Area:** `src/ui/webview-react/utils/stepContextMenuItems.ts`
- **Severity:** low

## Symptom

"Copy full output" from a step's (or the finalStep's) context menu in the steps
panel produces markdown with no `### Prompt` section. The same action from the
output pane's context menu includes it.

## Steps to Reproduce

1. Run a prompt step.
2. Right-click the step in the steps panel, choose "Copy full output".
3. The copied markdown has the response but not the prompt.

## Root Cause

Since timeline v2 the prompt lives on the attempt's `OrderedCliHistoryEntry`,
not on `CliOutput`. `stepContextMenuItems.ts` calls
`generateSingleStepMarkdownExport(latestOutput, ...)` with the bare `CliOutput`
from `useLatestStepOutput` / `useFinalStepLatestOutput`, so it has no prompt to
pass. The output pane's menu has the full `OutputMessage` and passes
`msg.prompt`.

## Suggested Fix

Have the latest-output hooks return the entry's `prompt` alongside its
`cliOutput` (or a small `{ output, prompt }` pair), and pass it through to
`generateSingleStepMarkdownExport`'s `prompt` parameter.
