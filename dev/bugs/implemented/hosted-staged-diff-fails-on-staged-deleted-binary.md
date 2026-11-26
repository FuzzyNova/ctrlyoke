# Hosted staged diff fails when a binary file is staged for deletion

- **Found:** 2026-11-25 by bug-hunt workflow final step (subagent; git message confirmed with git 2.56)
- **Area:** `src/utils/GitUtils.ts` (`getBlobBytes` ~955-970), `src/server/HostedWorkspaceViewerService.ts` (`buildNonTextDiffEntries` ~3236-3247, staged sources ~3078)
- **Resolution:** fixed in this commit

## Symptom

With a non-media binary file staged for deletion (`git rm bin.dat`), opening the
**staged** changes diff in the hosted workspace viewer fails for the whole request,
instead of listing `bin.dat` as a deleted binary next to the other staged changes.

## Steps to Reproduce

1. In a repo, commit a binary file `bin.dat`, then run `git rm bin.dat`.
2. `getChangedFilesWithBinaryStatus(repo, ["diff","--cached"])` returns
   `[{"path":"bin.dat","isBinary":true,"status":"D"}]`.
3. `getBlobBytes(repo, ":", "bin.dat")` throws instead of returning `null`:
   `fatal: path 'bin.dat' does not exist (neither on disk nor in the index)`.
4. In the hosted viewer, open the staged diff. The `getGitRefDiff` request rejects.

## Root Cause

`getBlobBytes` treats a path as missing only when git's stderr contains
`"does not exist in"` (e.g. `path 'x' does not exist in 'HEAD'`) or
`"exists on disk, but not in"`. For the index spec `:path`, when the path is in neither
the index nor the work tree, git (with `LC_ALL=C` from `gitProbeEnv`) instead prints
`path '<p>' does not exist (neither on disk nor in the index)`. That message matches
neither string, so `getBlobBytes` rethrows.

The staged diff sets `targetRef: ":"`. For every binary file, `buildNonTextDiffEntries`
reads the new side with `readGitDiffBytes(repoRoot, ":", file.path)` whatever the file's
status is. The media branch already skips the missing side by status, but the generic
binary branch does not.

## Suggested Fix

- In `getBlobBytes`, also treat `"does not exist (neither on disk nor in the index)"` as a
  missing path. Matching `/does not exist/` covers all three messages.
- In `buildNonTextDiffEntries`, skip reading the new side when the status is `D`, and the
  old side when it is `A`, as the media branch does.
- Add a `GitUtils` test for `getBlobBytes(repo, ":", path)` after `git rm`, plus a
  `HostedWorkspaceViewerService` staged-diff test with a staged-deleted binary.
