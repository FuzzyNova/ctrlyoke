# Staging or unstaging the repository root path acts on the whole repository

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced in a scratch repo)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`stageFile`, `unstageFile`), `literalGitPathspec`
- **Severity:** low

## Symptom

`stageFile("")` or `stageFile(".")` on a single-root workspace that is the repo toplevel succeeds
and stages every modified and untracked file (`M app/a.txt`, `M b.txt`, `A new.txt`).
`unstageFile` likewise unstages everything. Before 0abcd650c git refused the call.

## Steps to Reproduce

Create a repo with modified and untracked files, open it as the workspace, call
`HostedWorkspaceViewerService.stageFile("")` (or `"."`), then `git status --short`.

## Root Cause

0abcd650c (`fix: treat git file paths literally`) wraps paths with `literalGitPathspec`. For the
repo root the relative path is `""`; before, `git add -- ""` failed with "empty string is not a
valid pathspec", but `:(literal)` with an empty path matches everything. `discardFile` rejects
the exact workspace root; `stageFile`/`unstageFile` (~2307-2336) have no such check. The SCM pane
only sends file entries, so this needs a crafted or buggy request, and staging can be undone.

## Suggested Fix

Reject an empty relative path in `literalGitPathspec` (throw), or have `stageFile` and
`unstageFile` reject the repository root the way `discardFile` does. Add a test in
`src/test/unit/HostedWorkspaceViewerService.test.ts`.
