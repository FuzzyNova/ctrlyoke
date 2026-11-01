# Hosted viewer git actions and git-ref media fail when the workspace root is a symlink or junction

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`requireRepoRootForPath` callers), `src/utils/WorkspaceRepoDiscovery.ts`
- **Severity:** medium

## Symptom

When the workspace root path goes through a symlink or junction (for example
`C:\x\link` -> `C:\x\real`, a symlinked home directory, or macOS `/tmp` ->
`/private/tmp`), every hosted-viewer operation that looks up the file's git
repository fails:

- the commit and index sides of a media diff, and history images
  (`GET` raw media with `ref=<sha>` or `ref=:`), return **500 Internal server
  error**;
- the SCM diff, stage, unstage, discard, file history and file-history diff
  fail with "File is not inside a git repository".

Working-tree reads still work. It fails closed, so nothing leaks, but the
viewer's git features are unusable for that workspace.

## Steps to Reproduce

1. Create a git repo `real/`, commit `a.png` and `a.txt`, then make a junction
   (or symlink) `link` -> `real`.
2. Construct `new HostedWorkspaceViewerService(<path to link>)`.
3. `getRawMedia("a.png", undefined, <sha>)` and `getDiff("a.txt")` both throw
   `Error: File is not inside a git repository`. The same calls on a service
   rooted at `real` succeed. (Confirmed with a probe against the compiled
   `out/server/HostedWorkspaceViewerService.js` on Windows.)

## Root Cause

`safeResolve` (`HostedWorkspaceViewerService.ts:878`) returns the **real**
path unless `preserveLexicalPath` is set. Repo discovery deliberately stores
the **lexical** workspace root as `rootPath` when `realpath(root)` equals the
git toplevel (`WorkspaceRepoDiscovery.ts:50-56`). `requireRepoRootForPath`
(`:821`) then calls `findRepoForPath(realPath, repos)`, whose containment
check compares the real path against the lexical root, so it never matches.

Affected call sites: `getRawMedia` (`:572` then `:603`; the following
`isPathWithinAnyDirectory(resolved, this.trustedRoots)` check at `:604` would
also compare real against lexical and return 403), `getDiff` (`:2101`),
`stageFile` (`:2269`), `unstageFile` (`:2280`), `discardFile` (`:2291`), file
history (`:2481`) and file-history diff (`:2556`).

The route's catch (`CtrlYokeHostedServer.ts` raw media handler) turns the
plain `Error` into a 500. The earlier fix
`dev/bugs/implemented/hosted-viewer-symlinked-workspace-root-breaks-navigation.md`
covered only viewer path conversion, not repo lookup.

## Suggested Fix

Keep the realpath containment check, but do repo lookup and git pathspecs in
the lexical space: after `safeResolve` passes, map the real path back onto the
trusted root's lexical path (the existing `toLexicalViewerPath` logic near
`:917`, or `safeResolve(p, { preserveLexicalPath: true })`), and pass that to
`requireRepoRootForPath` / `relativeToRepo`. Alternatively make
`requireRepoRootForPath` compare against `realpathsOf` the repo roots. Compare
the `:604` trusted-root check against `realpathsOf(this.trustedRoots)`. Apply
one shared helper to every call site listed above rather than patching each.
Add tests with a junction/symlink-rooted service covering raw media with a
commit ref and the index ref, `getDiff`, and stage/unstage.
