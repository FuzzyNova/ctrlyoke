# Commit log reads the entire history up front under a 10 s timeout and 50 MB buffer, and keeps up to 32 full copies

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Resolution:** fixed in this commit

## Symptom

In a repository with a long history, the workspace viewer's history pane shows nothing,
not even the first page. `/api/workspace-viewer/commit-log` returns 500 because the
single `git log` call that builds the snapshot either outgrows the 50 MB `maxBuffer` or
runs past the 10 s timeout. Projects in that range include Linux (about 1.3M commits),
LLVM, Chromium, gecko and many company monorepos.

Below those limits the history does load, but each initial load, branch or repo switch
and refresh keeps another frozen copy of the whole history in memory. Up to 32 copies
are kept for 5 minutes each. On a repo with about 100k commits that means millions of
small objects on the extension host, which is the heap-OOM pattern described in the
crash-investigation notes.

## Steps to Reproduce

1. Open the hosted dashboard on a clone of a repository with more than about 280k
   commits, for example `git clone https://github.com/torvalds/linux`.
2. Open the workspace viewer's history tab.
3. The request fails and the history list stays empty.

Measured on this repo: `git log --decorate=full
--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%P%x00%D` produces 987,460 bytes for 5,258
commits (about 188 B per commit) in about 0.3 s. At that rate the output passes 50 MB
at about 280k commits, and a slow or cold disk reaches 10 s sooner.

## Root Cause

- `src/server/HostedWorkspaceViewerService.ts:2497-2505`: when there is no `historyId`,
  `getCommitLog` calls `getRecentCommits(repoRoot, undefined, 0, safeBranch, true)`. A
  comment says omitting max-count is intentional, because the complete result is the
  frozen snapshot that every later page is served from. Only `pageSize` rows are ever
  returned per request.
- `src/utils/GitUtils.ts:363-373`: with `limit === undefined`, no `-n` is passed, and
  the call goes through `execGit`, which uses `GIT_TIMEOUT_MS = 10_000` and
  `GIT_MAX_BUFFER = 50 MB` (`GitUtils.ts:11-13`, `225-244`). Either limit throws, and
  the whole request fails.
- `HostedWorkspaceViewerService.ts:165-166`, `2402-2408`, `2520-2531`: every
  snapshot-creating request stores the full `commits` array, and up to
  `COMMIT_LOG_SNAPSHOT_MAX_COUNT = 32` of them stay in memory for
  `COMMIT_LOG_SNAPSHOT_TTL_MS` (5 minutes).

The cost and memory grow with the length of the history, while each response is a
fixed-size page. This is the same "enumerate everything, then hit a constant budget"
design that broke workspace search.

## Suggested Fix

Page from git instead of snapshotting the whole history:

- To freeze the snapshot, record only the resolved tip commit hash (`rev-parse` of the
  branch hint or HEAD) and the metadata in the snapshot, not the commits.
- Serve each page with `git log -n <pageSize> --skip=<offset> <frozenTip>`. Because the
  tip is a fixed hash, pages stay stable without holding the list in memory.
  `--skip` costs grow with the offset, but only for users who scroll that far. A cursor
  (continuing from the last hash seen) would avoid even that.
- The total commit count, if the UI needs it, can come from `git rev-list --count
  <tip>`. That call is cheap and has a small output. It can also be left out, with the
  client paging until a short page comes back.

This removes the buffer limit, keeps each git call proportional to one page, and
reduces each snapshot to a few fields, so the 32-copy retention no longer matters.
