# File history runs an unbounded `git log --follow` over the whole history under the 10 s default timeout

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Severity:** medium

## Symptom

In a large or long-lived repository, opening a file's history in the workspace viewer
fails with a 500 error and the history pane stays empty, even for a file that was
changed in the latest commit. Fetching only the first page (30 entries) would have been
cheap.

## Steps to Reproduce

1. Open the hosted dashboard on a repository with a few hundred thousand commits, for
   example a Linux kernel clone.
2. In the workspace viewer explorer, open the file history of any file.
3. The request times out after 10 s and no history is shown.

Measured on this repo (5,258 commits): `git log --follow -z --name-status --format=%H --
src/server/HostedWorkspaceViewerService.ts` takes about 184 ms for the full history
(about 35 µs per commit of total history). The same call with `-n 30` takes about
109 ms. At that rate, roughly 280k commits of total history pass 10 s for any file.

## Root Cause

- `src/server/HostedWorkspaceViewerService.ts:2162-2167`: a request without a
  `historyId` calls `getFileHistoryCommits(repoRoot, gitPath, undefined, 0, headHash,
  true)`. A comment says omitting max-count is intentional, because the full result is
  the frozen snapshot that later pages are served from.
- `src/utils/GitUtils.ts:427-454`: the function runs `git log --follow -z
  --name-status` with no `-n` when `limit` is undefined, through `execFileAsync` with
  the default 10 s `getGitTimeoutMs()` and the 50 MB buffer. `--follow` makes git diff
  trees with rename detection for every commit in the history, so the cost grows with
  the total history, not with how many commits touched the file. With `-n`, git stops
  once it has found that many matching commits.

## Suggested Fix

Page with git, against the frozen `headHash` that is already resolved and passed as
`ref`:

- Store only `headHash`, the path and the metadata in the snapshot. Serve each page
  with `getFileHistoryCommits(repoRoot, gitPath, pageSize + 1, offset, headHash, true)`,
  where the extra row tells the client whether more pages exist. Because the ref is a
  fixed hash, pages are as stable as they are with today's full snapshot.
- If an exact total is needed, compute it lazily, or drop it in favour of a "has more"
  flag. This is the same continuation model as `src/server/WorkspaceSearchSession.ts`.

Caveat: `--follow` combined with `--skip` follows renames correctly, because git
applies skip after its own path filtering. Add a test for a renamed file that spans a
page boundary.

See also `commit-log-full-history-snapshot-timeout-and-buffer.md`, which has the same
full-snapshot design.
