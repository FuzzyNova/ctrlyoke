# The hosted git diff routes read working-tree files through links that point outside the workspace

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed on Windows with a directory junction and a scratch `npx tsx` script against `HostedWorkspaceViewerService`)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`readWorkingTreeDiffBytes`, `buildGitRefDiffPageEntry`, `buildNonTextDiffEntries`, `getGitRefDiff`)
**Resolution:** fixed in this commit

## Symptom

A tracked file reached through an in-workspace symlink or junction that points
outside the workspace is blocked by `readFile` ("Path not allowed") and by
`getDiff`. The `~diff` change views still serve its contents:

- `GET /api/workspace-viewer/git-ref-diff-page?ref=~diff` returns the outside
  file as the entry's `newContent`.
- `/git-ref-diff` returns it inside `unifiedDiff`, because Git for Windows
  follows the junction itself.

On Linux and macOS, a tracked symlink whose target was changed (status `M`/`T`)
leaks the same way, including targets such as `~/.ssh/id_rsa`.
`.github/instructions/server.instructions.md` says `safeResolve()` "must reject
anything outside the workspace", so following the link here is not intended.

## Steps to Reproduce

1. Create a git repo `ws` and commit `j/secret.txt` with the content "tracked".
2. Replace `ws/j` with a junction (Windows) or a symlink to `outside/`, which
   holds `secret.txt` = `OUTSIDE-SECRET-CONTENT`. Git now reports
   `M j/secret.txt`.
3. `svc.readFile("j/secret.txt")` returns "Path not allowed", and
   `svc.getDiff("j/secret.txt")` throws "Path not allowed".
4. `svc.getGitRefDiffPage("~diff")` returns
   `{ path: "j/secret.txt", newContent: "OUTSIDE-SECRET-CONTENT\n" }`, and
   `svc.getGitRefDiff("~diff").unifiedDiff` contains `+OUTSIDE-SECRET-CONTENT`.

## Root Cause

`readWorkingTreeDiffBytes` (`src/server/HostedWorkspaceViewerService.ts:2725-2732`)
builds the working-tree path with a plain `path.join(repoRoot, gitPath)` and
reads it. That follows links without the real-path check that `safeResolve()`
applies. It is reached from `buildGitRefDiffPageEntry` (paged `~diff`) and
`buildNonTextDiffEntries` (binary entries of `/git-ref-diff`). The visibility
filters (`isVisibleGitChangedFile` and similar) check only the lexical path. The
unified diff text comes straight from `git diff`, which also follows the link.

## Suggested Fix

- In `readWorkingTreeDiffBytes`, resolve the path through `safeResolve()` (or
  realpath it and check it against the trusted roots). When it falls outside,
  treat the working-tree side as unavailable instead of reading it.
- For `/git-ref-diff`, exclude changed files whose working-tree real path is
  outside the roots before running `git diff`, e.g. pass only the in-root
  changed paths as `:(literal)` pathspecs. Alternatively, drop those files'
  hunks from the unified output.

In-root files and in-root links diff exactly as before, so no intended
behaviour changes.

Tests: `src/test/unit/HostedWorkspaceViewerService.test.ts` already creates
junctions on Windows and dir symlinks elsewhere. Add a tracked file reached
through an in-root link to an outside directory, and assert that neither
`getGitRefDiffPage("~diff")` nor `getGitRefDiff("~diff")` contains the outside
content.
