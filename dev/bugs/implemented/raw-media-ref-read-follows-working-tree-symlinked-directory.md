# Raw media at a git ref returns a different file's blob when a directory is now a symlink

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`getRawMedia`)
- **Resolution:** fixed in this commit

## Symptom

The hosted raw media route promises the bytes stored at `<ref>:<path>`. When
a directory on that path has since been replaced in the working tree by a
symlink or junction, the route follows the working-tree link and serves the
blob of a different path. A diff's "before" image is then silently the wrong
file. If the link points outside the workspace, the request returns 403 for a
blob that is inside the repository.

## Steps to Reproduce

1. In a repo, commit `assets/logo.png` (contents `ASSETS-logo`) and
   `public/logo.png` (contents `PUBLIC-logo`).
2. In the working tree, replace `assets/` with a junction (or symlink) to
   `public/`.
3. `git show <sha>:assets/logo.png` prints `ASSETS-logo`, but
   `service.getRawMedia("assets/logo.png", undefined, <sha>)` returns
   `PUBLIC-logo`.

Reproduced against the current build.

## Root Cause

In the `ref !== undefined` branch, `getRawMedia` resolves the requested path
with `this.safeResolve(requestedPath)`, which follows working-tree symlinks to
a real path (`public/logo.png`). `requireRepoRootForPath` maps it back onto the
lexical root but cannot undo a symlink *inside* the workspace, so `gitPath` is
built from `public/logo.png`. Git trees are lexical and ignore working-tree
links, so the blob read targets the wrong path. The read still runs with
`git -C <repoRoot>` against a commit in that repo, so this is a correctness
bug, not a containment escape.

## Suggested Fix

Same change as
`dev/bugs/backlog/raw-media-ref-read-403-for-deleted-file-under-linked-root.md`:
in the ref branch, resolve with `{ preserveLexicalPath: true }`, check
containment against the lexical trusted roots, and build the repo match and
`gitPath` from that lexical path. Add a test in `suite("getRawMedia")` of
`src/test/unit/HostedWorkspaceViewerService.test.ts` that commits two files,
replaces one directory with a junction, and asserts the commit's own blob is
returned.
