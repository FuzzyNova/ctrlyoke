# Hosted full-diff routes include files outside the workspace root in a nested repo

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`getGitRefDiff`, `getWorktreeDiff`)
- **Resolution:** fixed in this commit

## Symptom

When the workspace root is a subdirectory of a larger git repository (root
`repo/app`, git toplevel `repo/`), `GET /api/workspace-viewer/git-ref-diff`
returns a unified diff covering the whole repository, including files in
sibling directories such as `repo/private/`. The dashboard's "Download diff"
button (`WorkspaceDiffPane.tsx`) uses this route, so an ordinary click produces
a `.diff` containing out-of-root content. Every other viewer git surface
(status, paged diff, binary entries, file history) is filtered to the trusted
roots.

## Steps to Reproduce

1. Create a repo with `app/a.txt` and `private/notes.txt`, then modify both.
2. Root the hosted viewer service at `repo/app`.
3. Status and paged diff list only `a.txt`, but `getGitRefDiff("~diff")`'s
   `unifiedDiff` includes `private/notes.txt` and its content (confirmed with
   an `npx tsx` probe).

## Root Cause

`getGitRefDiff` calls `getWorkingTreeDiff`, `getStagedDiff`, `getStashDiff`
and `getCommitDiff` on the repo root with no pathspec, and returns the result
unfiltered. `getWorktreeDiff` (`getDiffBetweenRefs`) has the same gap.

## Suggested Fix

Restrict these diffs to the trusted roots inside the repo. Either pass
repo-relative pathspecs (`-- app/`) through the git helpers, adding an
optional pathspec parameter rather than a second copy of each helper, or
filter the unified diff per file with the same visibility predicate the paged
diff uses (`isVisibleGitChangedFile`). Filter the untracked file list the same
way. When the root is the repo toplevel, the output must be unchanged. Add a
nested-root test for each ref kind.
