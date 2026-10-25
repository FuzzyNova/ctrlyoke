# Streamed working-tree diff download omits the untracked-files list

- **Found:** 2026-10-24 by bug-drain review of 44cb1ea2d
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/utils/GitUtils.ts`, `src/ui/webview-react/utils/hostedApi.ts`
- **Severity:** low

## Symptom

Downloading "Working Tree Changes" from the hosted workspace viewer no longer
includes the "Untracked files:" section the old download had.

## Root Cause

`spawnGitRefDiffDownload` (`HostedWorkspaceViewerService.ts`, around line 3175)
rebuilds each git diff command inline instead of reusing the argument lists in
`GitUtils` (`getWorkingTreeDiff`, `getStagedDiff`, `getStashDiff`, `getCommitDiff`),
and the copies have already drifted: `getWorkingTreeDiff` appends the untracked
list, the stream does not. Separately, `hostedFetchBlob` in `hostedApi.ts` copies
`hostedFetch`'s header building. The route test stubs `spawnGitRefDiffDownload`, so
the real commands are never exercised.

## Suggested Fix

Export the git argument builders from `GitUtils` and use them in both the buffered
and the streamed paths. After the working-tree diff stream ends, append the
untracked section the same way `getWorkingTreeDiff` does. Share header building
between `hostedFetch` and `hostedFetchBlob`. Add a test with real git that the
streamed working-tree download includes an untracked file's name.

While there, delete the now-unused buffered worktree-diff path that 01bcfb502
replaced: the `/api/workspace-viewer/worktree-diff` route in
`CtrlYokeHostedServer.ts` (around line 2288), `getWorktreeDiff`, and
`workspaceWorktreeDiff` in `hostedApi.ts`. First confirm with grep that nothing
else calls them.
