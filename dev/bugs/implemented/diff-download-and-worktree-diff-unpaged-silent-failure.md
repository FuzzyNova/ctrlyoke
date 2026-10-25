# Diff download and worktree-run diff fetch the whole patch in one 10 s / 50 MB git call and fail silently

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Resolution:** fixed in this commit

## Symptom

The paged diff view (`getGitRefDiffPage`) exists because whole-commit patches can
outgrow GitUtils' buffer. A test covers that case: "pages a commit whose full patch
exceeds GitUtils' default maxBuffer".

Two features still request the whole patch in one call:

- **Download.** Clicking Download in the workspace viewer's diff pane fetches the
  unpaged `/git-ref-diff` route. For a large commit, working tree or stash (generated or
  vendored files, lockfiles, a commit that adds thousands of assets) the server call
  times out, overflows the buffer, or starts one git process per binary file at the same
  time. The client swallows the error, so nothing happens and no message is shown. These
  large diffs are exactly the ones a user is most likely to want to download.
- **Worktree-run diff.** Viewing a managed worktree run's branch diff
  (`getWorktreeDiff`) fails the same way when the run produced a large diff. The pane
  stops loading and shows no diff and no error.

## Steps to Reproduce

1. Commit a change whose `git show --stat -p` output is larger than 50 MB, for example a
   large generated or vendored file. Alternatively, add a directory of a few thousand
   binary or image files.
2. In the hosted dashboard, open that commit in the workspace viewer. The paged view
   renders.
3. Click Download. No file is downloaded and no error is shown.
4. Separately, let a managed worktree run produce a similar change and open its worktree
   diff. The pane shows nothing.

## Root Cause

- `src/ui/webview-react/components/workspace-viewer/WorkspaceDiffPane.tsx:193-201`
  calls `await workspaceGitRefDiff(ref, ...)` and then has `catch { // ignore download
errors }`.
- `src/server/HostedWorkspaceViewerService.ts:3016-3108` (`getGitRefDiff`) gets the full
  patch with a single `getWorkingTreeDiff`, `getStagedDiff`, `getStashDiff` or
  `getCommitDiff` call. For example, `src/utils/GitUtils.ts:553-568` runs `git show
--stat -p` through `execFileAsync`, which uses `GIT_TIMEOUT_MS = 10_000` and
  `GIT_MAX_BUFFER = 50 MB` (`GitUtils.ts:11-13`).
- The same method also computes `nonTextEntries` through `buildNonTextDiffEntries`
  (`HostedWorkspaceViewerService.ts:2773-2850`). The download throws that result away.
  The method runs an unbounded `Promise.all` over every binary file in the change,
  spawning `git cat-file` and `git show` for each one at once, and base64-encodes every
  image side up to the per-side limit. The tree code bounds similar work with
  `mapWithBoundedConcurrency(..., 8)`.
- `getWorktreeDiff` (`HostedWorkspaceViewerService.ts:3118-3133`) uses one
  `getDiffBetweenRefs` call, with the same limits, for a run's whole branch diff.
  `src/ui/webview-react/store/workspaceViewerStore.ts:983-997` swallows the failure.

## Suggested Fix

- **Download:** stream the patch instead of buffering it. Add a download route that
  `spawn`s `git show`/`git diff` and pipes stdout to the HTTP response with a
  `Content-Disposition` header, with no `maxBuffer`. Use a timeout that resets while
  output is still arriving, or none at all, and let the browser download the response
  directly. Do not compute `nonTextEntries` for a download. As a smaller step, build the
  download by walking `getGitRefDiffPage` pages on the client. Either way, show the user
  an error when the download fails.
- **Worktree diff:** move it onto the same paged snapshot model as
  `getGitRefDiffPage`, using the base commit as the base ref and
  `refs/heads/<branch>` frozen to its hash as the target.
- Bound `buildNonTextDiffEntries` with `mapWithBoundedConcurrency` wherever it is still
  called on a whole change.

## Progress

The Download and worktree diff halves are fixed in this commit.
