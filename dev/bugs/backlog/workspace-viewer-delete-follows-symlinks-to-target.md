# Workspace viewer delete/move acts on a symlink's target, and the root guard misses symlinked roots

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/server/CtrlYokeHostedServer.ts`
- **Severity:** high

## Symptom

Two data-loss problems in the hosted workspace viewer's file operations:

1. **Deleting a symlink or junction deletes what it points to.** Deleting the entry `link`
   (a junction to `src/`) recursively deletes `src/` and all its files, and leaves `link` behind as
   a dangling junction. `moveEntry` likewise renames the target instead of the link.
2. **The "don't delete/move the workspace root" guard is bypassed** when the workspace was opened
   through a symlink or junction (a junctioned dev folder, a symlinked home, macOS
   `/tmp` → `/private/tmp`). A single authenticated `DELETE /api/workspace-viewer/entry` with no
   `path` recursively deletes the whole workspace. The same call on a non-symlinked root correctly
   fails with `Path not allowed`.

## Steps to Reproduce

These were confirmed by bundling the real service with esbuild (with a stubbed `vscode` module) and
using Windows junctions, which need no admin rights.

1. Create `ws/src/important.ts` and a junction `ws/link -> ws/src`. Run
   `new HostedWorkspaceViewerService(ws, …).deleteEntry("link")`.
   - Actual: `ws/src` no longer exists; `ws/link` is still there, dangling.
   - Expected: only `ws/link` is removed.
2. Create `realws/keep.txt` and a junction `wsjunction -> realws`. Build the service rooted at
   `wsjunction` and call `deleteEntry("")`.
   - Actual: it succeeds and `realws` is gone.
   - Expected: `Path not allowed` (which is what a service rooted at `realws` returns).

## Root Cause

- `safeResolve` (around lines 628-665) checks containment on the realpath, which is right, but then
  **returns** the realpath (`return realResolved;`). `deleteEntry` (around line 1458) passes that to
  `fs.promises.rm(resolved, { recursive: true })`, and `resolveTransferPaths` (around line 1492)
  passes it to `rename`/`cp`. So they act on the link's target, not the entry the client named.
- `isExactRoot` (around lines 498-501) compares that realpath against `this.trustedRoots`, which
  have only been through `path.resolve` and were never realpath'd. When a root is itself reached
  through a link, the realpath never equals it, and the guard lets the root through.
- The `DELETE /entry` route (`CtrlYokeHostedServer.ts`, around lines 1122-1140) turns a missing
  `path` into `""` instead of rejecting it.

## Suggested Fix

- Keep realpath-based containment as the security check, but perform mutations on the lexical path
  (the link itself). For example, give `safeResolve` a mutation mode that returns the lexical path
  after the realpath check passes, and use it in `deleteEntry` and `resolveTransferPaths`. Check
  whether the other `safeResolve` callers (write, rename, create) have the same problem.
- Make `isExactRoot` compare both the lexical path against `trustedRoots` and the realpath against
  `realpathsOf(trustedRoots)`.
- Reject a missing or empty `path` in the delete (and move) routes with 400.
- Add regression tests in `src/test/unit/HostedWorkspaceViewerService.test.ts` that use real temp
  directories with symlinks. Use `fs.symlinkSync(target, link, "junction")` for directories so the
  tests run on Windows without admin rights. Cover: deleting a directory link keeps its target;
  deleting a file symlink keeps its target file; moving a link moves the link; deleting `""` or
  the root through a junctioned root is rejected.
