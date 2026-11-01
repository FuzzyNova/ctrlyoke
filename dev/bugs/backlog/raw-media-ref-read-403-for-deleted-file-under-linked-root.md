# Raw media "before" image returns 403 for a deleted file under a symlinked workspace root

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`getRawMedia`)
- **Severity:** medium

## Symptom

When the workspace root is a symlink or Windows junction, the hosted
workspace viewer cannot show the "before" side of a deleted image, video,
audio or PDF file. `GET` of the raw media route with `ref=<commit>` (or the
index ref) returns `403 Path not allowed` for a file that exists in that
commit, so the diff shows a broken image. The same request works when the
workspace is opened through its real path, and it works under the linked
root for files that still exist in the working tree.

~33d5184ff fixed git actions under linked roots, but its `getRawMedia` test
(`src/test/unit/HostedWorkspaceViewerService.test.ts`, the junction test in
`suite("getRawMedia")`) only covers a file that still exists.

## Steps to Reproduce

1. Create `real/` as a git repo with `old.png` committed, then delete
   `old.png` from the working tree.
2. Create `link` as a junction (or symlink) to `real/` and construct
   `new HostedWorkspaceViewerService(link)`.
3. `await service.getRawMedia("old.png", undefined, <HEAD sha>)` rejects
   with `403 Path not allowed`. With `real` as the root it returns the bytes.

Reproduced against the current build: `link old.png ERR 403 Path not allowed`,
`real old.png OK`, `link kept.png OK`.

## Root Cause

In the `ref !== undefined` branch, `getRawMedia` resolves the path with
`this.safeResolve(requestedPath)`, which returns a real path. For a file
that no longer exists, `safeResolveWorkspacePath` falls back to its
closest-existing-ancestor branch and returns the *lexical* `link\old.png`.
The containment check that follows,
`isPathWithinAnyDirectory(resolved, this.realpathsOf(this.trustedRoots))`,
compares only against the real roots, so a lexical path under a linked root
can never pass it.

## Suggested Fix

A git blob read never touches the working tree, so the ref branch does not
need real-path resolution at all. In the `ref !== undefined` branch, resolve
with `this.safeResolve(requestedPath, { preserveLexicalPath: true })`, check
containment against the lexical `this.trustedRoots`, find the repo and build
`gitPath` from that lexical path, and take the media type from it too. Keep
the working-tree branch (no `ref`) on the real path, because `sendFile` opens
it. This one change also fixes
`dev/bugs/backlog/raw-media-ref-read-follows-working-tree-symlinked-directory.md`.

Add a test next to the existing junction test in `suite("getRawMedia")` for
a committed-then-deleted file under a junction root (skip with `this.skip()`
when the link can't be created, as the existing test does).
