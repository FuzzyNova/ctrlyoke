# Discarding an untracked workspace root in the hosted viewer deletes the whole root

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`discardFile`, `parsePorcelainV1`)
- **Resolution:** fixed in this commit

## Symptom

A workspace root can be a directory that git reports as wholly untracked, for example a new
subfolder of a repo opened as the workspace, or one root of a multi-root workspace. Its SCM
change list then contains one untracked entry for the root itself. That entry has viewer path `""`,
or `<rootName>` in multi-root. Discarding it runs a recursive `rm` on the workspace root, so every
file in it is lost.

## Steps to Reproduce

Verified by an agent against the compiled `HostedWorkspaceViewerService`:

1. `git init repo`, commit one file, then create `repo/sub/precious.txt` (untracked).
2. Set the viewer's trusted root to `repo/sub`.
3. `getStatus()` returns `[{ path: "", kind: "untracked", ... }]`.
4. `discardFile("")` deletes it: afterwards `repo/sub` no longer exists.

Expected: the discard is refused ("Path not allowed"), as `deleteEntry` already refuses exact
roots.

## Root Cause

Git reports a wholly-untracked directory as a single `?? sub/` entry. `parsePorcelainV1` keeps it
because it lies within a trusted root, and `relativePath()` maps it to the root's viewer path.
`discardFile` (around lines 1947-1966) handles `UNTRACKED` with
`fs.promises.rm(lexicalPath, { recursive: true, force: true })`. Unlike `deleteEntry` and the
transfer paths, it has no `isExactRoot` guard. The `/api/workspace-viewer/discard` route only
checks that `path` is a string.

## Suggested Fix

- In `discardFile`, reject when `this.isExactRoot(resolved)`, the same guard `deleteEntry` uses.
- Consider also skipping, in `parsePorcelainV1`, entries whose absolute path is exactly a trusted
  root, so the UI doesn't offer the action at all.
- Add a regression test with a temp git repo whose untracked subfolder is the root, for single and
  multi-root layouts. Assert that discard throws and the folder survives.
