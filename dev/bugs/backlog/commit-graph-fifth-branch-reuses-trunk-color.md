# Commit graph gives the fifth side branch the trunk color, and the fifth branch color is never used

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/ui/webview-react/utils/commitGraphLayout.ts`, `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitHistoryPane.tsx`
- **Severity:** low

## Symptom

In the workspace viewer's commit history graph, side branches cycle through colors
`1, 2, 3, 4, 0, 1, …`. Every fifth side branch is drawn in color 0, the trunk color, so it is
indistinguishable from the mainline. The fifth branch palette entry (`text-scm-graph-fg5`) is
never rendered.

`TRUNK_COLOR_INDEX`'s doc comment says index 0 is "Reserved for the mainline (first-parent)
chain; never assigned by rotation", so this is not intended.

## Steps to Reproduce

Run `computeCommitGraphLayout` on a history of five mainline commits, each merging a side branch
whose parent is the next mainline commit:

```ts
const commits = [];
for (let i = 1; i <= 5; i++) {
  commits.push({ hash: `M${i}`, parentHashes: [`M${i + 1}`, `S${i}`] });
  commits.push({ hash: `S${i}`, parentHashes: [`M${i + 1}`] });
}
commits.push({ hash: "M6", parentHashes: [] });
```

The mainline lane has `colorIndex` 0 and the five side lanes get `[1, 2, 3, 4, 0]`.

## Root Cause

`rotateColor` (around line 30) computes `(colorIndex + offset) % COMMIT_GRAPH_COLOR_COUNT` with
`COMMIT_GRAPH_COLOR_COUNT = 5`, so rotation wraps back onto 0. Meanwhile
`WorkspaceCommitHistoryPane.resolveLaneColorClass` maps 0 to the trunk class and `k` to
`GRAPH_BRANCH_COLOR_CLASSES[k - 1]` (five entries), so index 5 would be needed to reach `fg5` but
rotation never produces it.

## Suggested Fix

Keep the first lane of the first commit at `TRUNK_COLOR_INDEX`, and make rotation cycle over the
branch colors only (`1..COMMIT_GRAPH_COLOR_COUNT`), for example
`1 + (colorIndex % COMMIT_GRAPH_COLOR_COUNT)` after the initial trunk assignment. Existing tests
pin the opening `0, 1, 2, 3` sequence; keep that and add a test with five or more side branches
asserting no side lane gets `TRUNK_COLOR_INDEX` and that index 5 is used.
