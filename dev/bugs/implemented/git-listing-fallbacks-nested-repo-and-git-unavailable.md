# Git-backed file listings: a broken nested repo, missing git, or a refused repo breaks the root; each entry is stat'ed one at a time

- **Found:** 2026-10-24 by bug-drain review of f12f06347, 82957401f and 9e2691cf2
- **Area:** `src/utils/GitUtils.ts`, `src/server/HostedWorkspaceViewerService.ts`, `src/completions/WorkspaceFileIndex.ts`, `src/utils/WorkflowFileDiscovery.ts`, `src/server/CtrlYokeHostedServer.ts`, `src/extension.ts`, `src/platform/VsCodeDashboardHostActions.ts`
- **Resolution:** fixed in this commit

## Symptom

1. **One broken nested repo or submodule breaks the whole root:** for example, a
   submodule whose `.git` file points at a moved gitdir. The whole outer root is
   then treated as non-git:
   - hosted search returns results twice, ignored build output included;
   - the `@` index drops to a degraded walk;
   - workflow discovery falls back to a full walk.
2. **Git missing or refused now breaks features:** with git not on PATH
   (`spawn git ENOENT`) or `fatal: detected dubious ownership`, these now fail
   where they used to fall back to a filesystem walk:
   - hosted search;
   - `/api/workflow-files` (500);
   - the VS Code "Select prompt file" and Load/Append Workflow pickers, which
     reject without catching the error.
3. **Every listed path costs a sequential `fs.lstat`** (and `fs.access` for
   directories). In the 400k-path repos f12f06347 targets, that adds seconds to
   tens of seconds to:
   - the `@` index's git-ready point;
   - workflow discovery;
   - hosted search.

## Root Cause

1. `getGitFilesIncludingNestedRepos` (`GitUtils.ts`, around lines 1201-1245)
   lets a nested repo's listing error propagate. The message matches
   `isNotGitRepositoryError`, so callers think the *outer* root is not a git
   repository. In `HostedWorkspaceViewerService` search (around line 907), the outer
   chunks were already yielded inside the `try`, so the fallback walk duplicates them.
2. `isNotGitRepositoryError` only matches `fatal: not a git repository`. Since
   f12f06347 and 9e2691cf2, every other error throws instead of falling back.
3. The same generator awaits `fs.lstat` for every entry, sequentially, to find
   nested repos. Only entries ending in `/` (untracked nested repos reported as
   directories) and gitlinks can be nested repos.

## Suggested Fix

1. Catch errors per nested repo inside the generator, `Log.warn` them and skip that
   repo (yield nothing for it). A nested failure must never surface as "root is not
   a Git repository". Make the hosted search fallback impossible after chunks were
   yielded (decide git vs walk before yielding).
2. Add one shared predicate, e.g. `isGitUnavailableError`, that also covers
   `ENOENT` on the git spawn and `detected dubious ownership`. Callers treat it like
   non-git and fall back to the walk. Wrap the VS Code picker callers
   (`extension.ts` around line 1191, `VsCodeDashboardHostActions.ts` around line 67)
   so an unexpected error shows a user-facing error instead of an unhandled
   rejection.
3. Only probe candidates: entries ending in `/`, plus gitlinks. Find gitlinks with
   `git ls-files -s` (mode `160000`) or `.gitmodules`; a single extra listing is
   fine. Do not stat ordinary files.
4. Remove the now-unused `WorkspaceFileIndexDependencies.getGitTrackedFiles`
   (`WorkspaceFileIndex.ts`, around line 81) if nothing uses it.

Add tests with real git: a broken submodule gitdir (the outer files are listed once
and the root is still treated as git), and a git spawn ENOENT (the callers fall
back to the walk).
