# Workspace search and the @ file index never include files inside nested Git repositories or submodules

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (server-completions)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`
- **Severity:** medium

## Symptom

When a workspace folder contains a submodule or a nested Git repository that is not its
own workspace folder, workspace search never finds content or file names inside it.
Turning on "include git-ignored files" does not help either.

- The nested directory itself becomes a search candidate. If its name matches the query,
  it is returned as a `FILE` result even though it is a directory.
- Content search on that candidate silently matches nothing.
- With the default `ui.respectGitignoreForCompletions: true`, `@` completions are
  missing every file inside the nested repo, and the index stores an `inner/` path for
  the directory itself.

The viewer otherwise supports nested repos: `discoverRepos` finds them, and SCM, diff
and history are routed to the inner repo (see
`dev/bugs/implemented/nested-repo-files-resolved-to-outer-repo.md`).

## Steps to Reproduce

1. Create `outer/` as a Git repo containing `a.txt`. Inside it, create `inner/` as its
   own Git repo (or add it as a submodule) containing `b.txt` with the word `needle`.
2. Open `outer/` as the only workspace folder and search the workspace for `needle`, with
   and without "include git-ignored files".
3. Nothing is found. Typing `@b.t` in a prompt does not offer `inner/b.txt`.

Confirmed in a scratch repo:

- `git ls-files --cached --others --exclude-standard -z` prints only `a.txt` and
  `inner/`.
- `git ls-files --others --ignored --exclude-standard --directory` prints nothing.

## Root Cause

- `src/server/HostedWorkspaceViewerService.ts:875-887` (`searchRootFiles`) takes
  `getGitTrackedFiles(root)` (`src/utils/GitUtils.ts:1112-1123`) as the complete list of
  non-ignored candidates for a Git root and chunks it directly. Git reports an untracked
  nested repository as a single `inner/` entry and a submodule as a single gitlink path,
  never their files. Neither is ignored, so the `includeGitIgnored` walk (lines 889-917)
  does not reach them either. Search roots are workspace folders (`searchCandidates`,
  lines 843-864), not discovered repos, so the inner repo is never listed on its own.
- `WorkspaceSearchSession`'s file-name matching returns `WORKSPACE_ENTRY_KINDS.FILE` on
  a basename match without checking the entry type, and `scanSearchFile` returns `[]`
  when `!stat.isFile()` (around line 958).
- `src/completions/WorkspaceFileIndex.ts:371-385` (`performBuild`) builds the
  respect-gitignore `@` index from the same `getGitTrackedFiles` output. With
  `respectGitignore` on and Git succeeding, no walk follows (lines 395-399).

## Suggested Fix

Expand nested repositories when building candidate lists:

- Detect directory and gitlink entries in the `ls-files` output: a trailing `/`, or
  mode `160000` from `git ls-files -s`/`--stage`, or check `.git` existence. For each
  one, run `git ls-files --cached --others --exclude-standard` in that nested repo, and
  recurse with its own `.gitignore` rules. Do this lazily, as another source in the
  `searchRootFiles` generator, so the resumable session in
  `src/server/WorkspaceSearchSession.ts` keeps paging without enumerating everything up
  front.
- Do the same in `WorkspaceFileIndex.performBuild`, and never store a directory entry
  (`inner/`) as a file path.
- Separately, never return a directory as a `FILE` search result.

`--recurse-submodules` on `ls-files` covers initialized submodules but not
`--others` or plain nested repos, so an explicit expansion is still needed.
