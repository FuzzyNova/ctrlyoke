# Diff gap expand buttons write rendered-hunk index into state keyed by base-hunk index, so later gaps cannot be expanded

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/components/output/DiffView.tsx`
- **Severity:** medium

## Symptom

Once any earlier gap in a diff has been fully expanded, the "Show N hidden lines" and "Show all" buttons on later gaps stop working. Clicking them again and again never reveals the hidden context.

## Steps to Reproduce

1. Open a diff in the dashboard where old content is available (expandable source). The file needs at least 3 hunks A, B and C, with a gap of 25 lines or fewer between A and B and a gap of more than 25 lines between B and C.
2. Click "Show N hidden lines" on the A-B gap. The gap fills completely, and react-diff-view merges A, the inserted lines and B into one rendered hunk. The rendered hunks are now `[AB, C]`.
3. Click "Show 25 of M hidden lines" or "Show all" on the gap between AB and C.
4. Observed: nothing changes, on any click. Expected: the B-C gap expands. A 1-line gap between A and B causes the same problem without any click, because that gap is auto-expanded and merged on first render.

## Root Cause

The gap decorations in `DiffView.tsx:740-786` loop over the rendered hunks, which are already expanded and merged. They call `handleExpand(i, prevHunk, hunk, ...)` with the rendered index `i`. `handleExpand` (`DiffView.tsx:416-454`) stores `nextExpandedToLine` under that index: in uncontrolled mode through `setUncontrolledExpandedGaps` (line 447), and in controlled mode through `onExpandGap` (line 451).

Every consumer of that state treats the key as a base-hunk gap index:

- The single-line auto-expansion memo (`DiffView.tsx:392-407`) keys entries by `i` over `baseHunks`.
- `applyDiffGapExpansionStateWithStats` (`src/ui/webview-react/utils/outputRenderUtils.ts:390-416`) reads `baseHunks[gapIndex - 1]` and `baseHunks[gapIndex]`, then clamps the target to that base gap's end (`Math.min(expandedToLine, gapEnd)`).

When a gap is fully filled, react-diff-view's `expandFromRawCode` -> `insertHunk` -> `appendOrMergeHunk` merges the neighbouring hunks, so every rendered index after it shifts down by one. `handleExpand` still works out the correct line target from the rendered neighbours, but it stores that target under an earlier base gap that is already filled. The clamp then discards it, so the gap the user clicked never opens. The lookup `activeExpandedGaps.get(gapIndex)` at line 428 reads the wrong entry for the same reason.

Controlled callers are hit too: `DiffFileCard`, `DiffRefDiffList`, `DiffFileList` and the virtualized output rows all receive the wrong index through `onExpandGap`.

## Suggested Fix

Key each gap by something that survives merging.

- **Option 1:** map the clicked rendered gap back to its base gap index. The gap ends at `hunk.oldStart`, so find the base index `j` where `baseHunks[j].oldStart === hunk.oldStart`, or else the first base hunk with `oldStart >= hunk.oldStart`. Pass `j` to `handleExpand` and `onExpandGap`, and use it for the `activeExpandedGaps.get` lookup.
- **Option 2:** key `DiffGapExpansionState` by the gap's base end line (`nextHunk.oldStart`) rather than by an array index.

Add a Vitest case under `src/ui/webview-react/test` with three hunks: fully expand gap 1, then expand gap 2, and assert that gap 2's lines render. Also check the index passed to `onExpandGap` in controlled mode.
