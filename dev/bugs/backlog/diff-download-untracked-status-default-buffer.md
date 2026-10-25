# Working-tree diff download fails when the untracked-file status is large or slow

- **Found:** 2026-10-25 by bug-drain review of 015008464
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/utils/GitUtils.ts` (`matchesPathspecs`)
- **Severity:** medium

## Symptom

1. In a worktree with tens of thousands of untracked, non-ignored files (or a slow
   `git status` in a large repo), the "Working Tree Changes" download returns 500.
   Before 015008464 it streamed; this undoes the changelog's "no size cap" promise.
2. When the workspace is the repo root and the only pathspecs are
   `:(exclude,literal)…` entries, the untracked section is always empty, in both the
   buffered and streamed paths. This is older than 015008464.

## Steps to Reproduce

1. Create more than ~1 MiB of untracked file paths in a repo opened in the hosted
   dashboard, then download the working-tree diff. The response is 500.

## Root Cause

1. The streamed download (around `HostedWorkspaceViewerService.ts:3279`) runs
   `git status --porcelain --untracked-files=all -z` through the service's own
   `promisify(execFile)` (around line 154). That has Node's default 1 MiB `maxBuffer` and
   a 10 s timeout, not GitUtils' `GIT_MAX_BUFFER` wrapper. It also runs before the diff
   spawn, outside the streaming error handling, so a failure fails the whole request.
2. `matchesPathspecs` (around `GitUtils.ts:225`) uses `some()` over the include
   pathspecs. With only exclude pathspecs there are no includes, so nothing matches.
   Git semantics: exclude-only pathspecs mean "everything except the excluded paths".

## Suggested Fix

1. Get the untracked list through GitUtils (move the status call into a GitUtils
   helper using `execGit`/`GIT_MAX_BUFFER` and the whole-repo timeout, or reuse an
   existing untracked-files helper there). Treat a failure as "no untracked section"
   with a `Log.warn`, never as a failed download.
2. Fix `matchesPathspecs` so exclude-only pathspecs match every path not excluded.
3. Tests: a status failure still streams the diff without the section (fake
   dependency); exclude-only pathspecs list untracked files; the existing real-git
   untracked test still passes.
