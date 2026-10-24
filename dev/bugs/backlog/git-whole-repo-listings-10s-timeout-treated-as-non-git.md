# Whole-repository `git ls-files` listings use a fixed 10 s timeout, and callers treat the timeout as "not a git repo"

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/utils/GitUtils.ts`
- **Severity:** low

## Symptom

`getGitTrackedFiles` (`git ls-files --cached --others --exclude-standard -z`)
runs with the 10 s short timeout. Its own comment sizes `maxBuffer` at 500 MB
because "large monorepos can exceed 100 MB", which is more than a million
paths. Measured on this repo: 3,907 paths in about 0.1 s (~25 µs per path), so
10 s is reached at roughly 400k paths warm, and sooner with a cold Windows
cache or antivirus scanning the untracked walk. The timeout and the buffer
allowance contradict each other. `getGitTrackedAndUntrackedFiles`,
`getGitUntrackedFiles` and `getGitIgnoredEntries` get the same 10 s default
through `execGit`.

What makes this worse is how callers handle the timeout. They catch any error
and act as if the folder were not a git checkout:

- `HostedWorkspaceViewerService.searchRootFiles` falls back to
  `iterateSearchFiles`, which ignores `.gitignore`.
- `WorkspaceFileIndex` sets `gitSucceeded = false` and walks with only
  `DEFAULT_SKIP_DIRECTORIES`.
- `CompletionFileDiscovery.getSourceFiles` falls back to an unbounded walk.
- `CtrlYokeHostedServer` (`/api/workflow-files`) catches and uses `[]`.

So in exactly the repositories big enough to hit the timeout, the result is a
much slower filesystem walk that includes ignored build output, or wrong
metadata, instead of the git listing.

## Steps to Reproduce

1. Open a monorepo with ~500k tracked or untracked non-ignored files on
   Windows (or set `setGitTimeoutOverridesForTests({ shortTimeoutMs: 1 })` in a
   test).
2. Run a workspace search, or trigger the completion file index build.
3. `getGitTrackedFiles` rejects with a timeout error, and search/completions
   fall back to walking the tree, including git-ignored directories that are
   not in `DEFAULT_SKIP_DIRECTORIES`.

## Root Cause

- `src/utils/GitUtils.ts:11`: `const GIT_TIMEOUT_MS = 10_000;`
- `:1112-1123`: `getGitTrackedFiles` passes `timeout: GIT_TIMEOUT_MS` together
  with `maxBuffer: 500 * 1024 * 1024`.
- `:1126-1180`: the other listings go through `execGit` -> `execFileAsync`,
  whose default is `options.timeout ?? getGitTimeoutMs()` (`:235`).
- Callers that read any error as "not git": `src/server/HostedWorkspaceViewerService.ts:879-884`,
  `src/completions/WorkspaceFileIndex.ts:373-381`,
  `src/utils/CompletionFileDiscovery.ts:13-21`,
  `src/server/CtrlYokeHostedServer.ts:1471`.

## Suggested Fix

- Stream `ls-files -z` (spawn and yield NUL-separated chunks). Callers such as
  `searchRootFiles` already consume chunks, and a paged consumer like
  `src/server/WorkspaceSearchSession.ts` can start working while git is still
  listing. A no-progress (idle) timeout then replaces the fixed wall-clock
  limit, which still guards a hung git without capping legitimate work.
- If buffering stays, give whole-repo listings a size-appropriate timeout (for
  example the mutation timeout) instead of the 10 s query timeout.
- Have callers check `rev-parse --is-inside-work-tree` (or the error kind) and
  fall back to a non-git walk only for a real "not a repository" error. A
  timeout should be reported, not silently turned into a gitignore-blind walk.
