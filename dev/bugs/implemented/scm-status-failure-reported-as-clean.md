# Workspace viewer SCM status failure (1 MiB maxBuffer or 10 s timeout) is reported as a clean working tree

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Resolution:** fixed in this commit

## Symptom

On a checkout with many changes, the hosted dashboard's source-control pane shows
"no changes". Real modifications are hidden and no error is shown. Two limits trigger
this:

- **Buffer limit.** `git status --porcelain=v1 -z` is run through a bare
  `promisify(execFile)`, so Node's default 1 MiB `maxBuffer` applies. Once there are
  roughly 15-20k changed entries (a codemod, a line-ending flip, a mass rename,
  regenerated files, or many untracked files under `-unormal` directories that are
  partly tracked), Node kills git with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
- **Timeout.** On a large checkout without fsmonitor (for example Windows with Defender),
  `git status` can take longer than the 10 s `GIT_COMMAND_TIMEOUT_MS`.

In both cases the result is indistinguishable from a clean tree.

Two other features read the same status:

- **Discard** (`discardFile`) uses it to detect untracked files. After a status
  failure, it treats an untracked file as tracked and runs `git restore`, which fails
  with a confusing error.
- **File diff** (`getFileDiff`) uses it to decide the file's change kind. After a
  failure, it falls back to `"modified"`.

## Steps to Reproduce

1. In a repo with about 20k tracked files, modify all of them, for example by appending
   a line to each file listed by `git ls-files`, or by reformatting a large tree.
2. Open the hosted dashboard's source-control pane.
3. It shows no changed files. `git status` in a terminal lists all of them.

Confirmed that Node's default limit applies: `promisify(execFile)` on a child that
writes 1.1 MB rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.

## Root Cause

- `src/server/HostedWorkspaceViewerService.ts:142`: `const execFileAsync =
promisify(execFile);` is the plain Node helper, not GitUtils' wrapper (which sets
  `GIT_MAX_BUFFER = 50 MB`).
- `HostedWorkspaceViewerService.ts:1606-1632` (`getRepoStatus`) runs `git status` with
  only `{ timeout: GIT_COMMAND_TIMEOUT_MS }`. On any failure (timeout, buffer overflow,
  lock contention), it returns `{ files: [], incomingCommitCount: 0,
outgoingCommitCount: 0 }`, with no error and no truncated flag.
- Callers: `getScmStatus` (line 1589), `getFileDiff` (line 1776) and `discardFile`
  (lines 1964-1975, the untracked check).

## Suggested Fix

- Run status with an explicit large `maxBuffer`, or better, `spawn` it and parse the
  NUL-separated stream incrementally. That removes the size limit entirely.
- Do not turn failure into "clean". Return an error state (for example `error:
"timeout" | "failed"`) that the SCM pane shows, with a retry, and let `discardFile`
  and `getFileDiff` fail loudly instead of guessing.
- The time cost grows with the size of the checkout, so use the longer GitUtils timeout
  for status (or make it configurable). If needed, report progress rather than a fixed
  10 s cut-off. Consider `--untracked-files=normal` explicitly, plus fsmonitor hints.
