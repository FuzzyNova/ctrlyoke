# openToWorktreeDiff has no stale-response guard, so a late reply can replace a newer diff view

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/store/workspaceViewerStore.ts`
- **Resolution:** fixed in this commit

## Symptom

In the hosted dashboard, the Source Control diff pane can show a stale multi-file worktree diff labelled "Branch <older branch>" in place of the diff the user asked for last. The stale diff can replace another run's worktree diff or a single-file diff picked from the SCM list. A late failure can also clear the loading spinner while a newer request is still running.

The cause is that `openToWorktreeDiff` awaits `workspaceWorktreeDiff()` and then sets `diffFiles`, `diffNonTextEntries` and `diffRefLabel` without checking that its request is still the current one. Later calls to `openToWorktreeDiff`, `selectDiff` or `clearDiff` do not cancel a request already in flight. Because the pane renders a non-null `diffFiles` before the single-file diff, the reply that arrives last wins, not the request that was made last.

## Steps to Reproduce

1. Open the hosted browser dashboard, where VS Code git diff is unavailable and `canOpenGitDiff` is false. Have two runs with managed worktrees: run A with a large (slow) diff and run B with a small one.
2. In run A's `RunSummaryBanner`, click **View Diff**. `openToWorktreeDiff(A)` starts and `diffRefLoading` becomes true.
3. Before A's git diff returns, click **View Diff** for run B, or click a changed file in the Source Control list (`selectDiff`).
4. B's diff (or the single-file diff) renders first. A's `workspaceWorktreeDiff` then resolves and sets `diffFiles`, `diffNonTextEntries` and `diffRefLabel = "Branch <A>"`.
5. `WorkspaceDiffPane` checks `diffFiles !== null` before `selectedDiffPath`, so the pane switches back to A's multi-file diff, which is not the diff the user asked for last.

## Root Cause

`src/ui/webview-react/store/workspaceViewerStore.ts:970-984`: after `await workspaceWorktreeDiff(...)`, both the success path (976-981) and the catch path (983) call `set()` without checking that this request is still the latest one.

`selectDiff` (766-782), `clearDiff` (784-806) and later `openToWorktreeDiff` calls (953-969) only reset state synchronously. None of them can cancel or invalidate the earlier promise.

`src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx:377` renders `diffFiles` before it reaches the `selectedDiffPath` branch at line 484, so the stale result takes precedence.

The diff is triggered from `src/ui/webview-react/components/output/RunSummaryBanner.tsx:324-331`.

## Suggested Fix

Add a request counter, either at module level or held in the store, e.g. `let worktreeDiffRequestSeq = 0`.

- In `openToWorktreeDiff`, capture `const seq = ++worktreeDiffRequestSeq`.
- Also increment the counter in `selectDiff`, `clearDiff` and `openToGitRef`, so that each of them invalidates any reply still in flight.
- After the await, and in the catch block, return early when `seq !== worktreeDiffRequestSeq`.

Add two store tests:

- Start two `openToWorktreeDiff` calls with deferred mocks, resolve them out of order, and assert that the later request's label and files win.
- Call `selectDiff` while an `openToWorktreeDiff` call is pending, and assert that the single-file selection is not overwritten when the pending call resolves.

## Decision

Request sequences invalidate stale diff responses, with selected-path checks as a store-level backstop.
