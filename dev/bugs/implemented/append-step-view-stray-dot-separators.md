# append_step view renders literal "·" separators inside table cells

- **Found:** 2026-09-29 by user, during the MCP tool-call display visual test
- **Area:** `src/ui/webview-react/components/output/ctrlyoke-tools/AppendStepView.tsx`
- **Resolution:** fixed in this commit

## Symptom

Each `append_step` row shows trailing dots in the Position, Name and Harness / model cells, e.g. `#2 ·`, `Junk A ·`, `Workflow default ·`. The columns already separate the values, so the dots read as stray punctuation.

## Steps to Reproduce

1. Call `mcp__ctrlyoke__append_step` with any step.
2. Look at the rendered table: every cell except Prompt ends with ` ·`.

## Root Cause

`AppendStepView.tsx:121-153` hard-codes `{" "}·` after the highlighted text in three `<td>`s. It is a leftover from the single-line text form built by `appendStepRowLine` (`appendStepModel.ts:175`: `#N · name · harness · prompt`), which is used for find/search text. The offsets in `AppendStepView.tsx:112-115` (`nameStart`, `harnessStart`, `promptStart`) depend on that `·` separator, but the separator does not need to be rendered visibly.

## Suggested Fix

Remove the three literal `·` nodes from the cells. The find-offset math is against the search-text string, not the DOM, so it is unaffected. The same pattern appears in `GlobalStatusView.tsx` (lines ~47-58) and `ListHarnessesView.tsx` (line ~24); check whether those are intentional inline separators or the same leftover.
