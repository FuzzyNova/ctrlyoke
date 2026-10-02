# Hosted workspace viewer breaks when the workspace root is reached through a symlink or junction

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`safeResolve`, viewer path conversion)
- **Severity:** medium

## Symptom

If the workspace root path goes through a symlink or junction (for example
`C:\x\link` -> `C:\x\real`, a symlinked home directory, or macOS `/tmp`), the
hosted explorer lists entries as `../real/...`. Opening any subdirectory
fails with "Path is not allowed", and saving an opened file fails with "Path
not allowed". This fails closed, so it is not an escape, but the viewer can't
be used.

## Steps to Reproduce

1. Create `real/src/a.txt` and a junction `link` -> `real`.
2. Root the hosted viewer service at `link`.
3. The top-level listing returns path `../real` with entries `../real/src`.
   Listing `../real/src` throws "Path is not allowed", and `readFile` returns
   path `../real/src/a.txt`, which `saveFile` then rejects (confirmed with an
   `npx tsx` probe).

## Root Cause

`safeResolve` returns `fs.realpathSync(resolved)` unless `preserveLexicalPath`
is set. Viewer paths are then computed relative to the lexical
`this.workspaceRoot`, so a realpath under a different prefix becomes
`../real/...`. When the client sends that path back, it resolves outside the
lexical root and is rejected.

## Suggested Fix

Keep the realpath containment check, but compute viewer paths in the lexical
space: map a realpath under a trusted root's realpath back onto that root's
lexical path before converting it to a viewer path, or return the lexical path
from `safeResolve` once the realpath check passes. Audit callers that use the
realpath return value so the security checks still use the real path. Add a
test with a junction or symlink root covering listing, a subdirectory listing,
read and save.
