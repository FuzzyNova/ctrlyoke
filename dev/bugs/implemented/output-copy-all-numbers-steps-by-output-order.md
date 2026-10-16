# "Copy All" numbers steps by the order their output appeared, not their real position

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; code reading)
- **Area:** `src/ui/webview-react/hooks/useOutputContextMenu.tsx` (`buildCopyAllText`)
- **Resolution:** fixed in this commit

## Symptom

The output pane's **Copy All** labels each section `=== Step N ===` with a counter that goes up
once for each step that has CLI output, in the order its output first appeared. The step cards
and the Markdown export (`markdownExport.ts`: `const stepNum = item.target.index + 1`) use the
step's real position. The two disagree whenever:

- a step produced no CLI output (disabled or skipped). With step 2 of 3 disabled, Copy All labels
  step 3 as "Step 2";
- parallel steps finish out of order. If step 3's output arrives before step 2's, Copy All swaps
  their labels;
- a continuation run only has output from step 3 on. Copy All labels it "Step 1".

The code's own comment says the numbering "matches the numbering used by markdown export", which
is only true when every step produced output, in index order.

## Steps to Reproduce

1. Run a workflow whose steps 2 and 3 are a parallel group, where step 3 finishes first.
2. Right-click the output → **Copy All**.
3. The section labeled "Step 2" holds step 3's prompt and output. The Markdown export labels the
   same section "Step 3".

## Root Cause

`useOutputContextMenu.tsx:30-60` keeps `let queueStepNum = 1` and increments it per seen target,
instead of deriving the number from `target.index`.

## Suggested Fix

Label queue steps `Step ${target.index + 1}`, as the export headings and the final-pass label
(`formatFinalPassLabel(target.index + 1)`) already do. The hidden-step branch then needs no
counting and can just `continue`. Add tests to
`src/ui/webview-react/test/hooks/useOutputContextMenu.test.tsx` for a missing middle step and for
out-of-order output.
