# Hosted workspace viewer lets delete, move and copy reach `~/.ctrlyoke/settings.json`

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; code reading, not yet reproduced over HTTP)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`safeResolve`, `resolveOwnedUserSettingsFile`, `deleteEntry`, `resolveTransferPaths`)
- **Resolution:** fixed in this commit

## Symptom

The user-scope settings file lives outside every workspace root. The viewer has a deliberate
exception so **Open settings file** can read, save and refresh it. But that exception sits in
`safeResolve`, which every viewer operation shares, so an authenticated dashboard client can also:

- `DELETE /api/workspace-viewer/entry?path=~/.ctrlyoke/settings.json` (or its absolute path, or
  the `../`-relative path `relativePath()` returns): deletes the user's global settings.
- `POST /api/workspace-viewer/move {sourcePath:<settings path>, destDir:""}`: moves it into the
  workspace, where it can be staged and committed.
- `POST /api/workspace-viewer/copy`: duplicates it into the workspace.

None of these is part of the "Open settings file" flow the exception exists for.

## Steps to Reproduce

1. Start the hosted server and read the token from `.ctrlyoke/dev/server-url.txt`.
2. Send an authenticated `POST /api/workspace-viewer/copy` with `sourcePath` set to the absolute
   path of the user settings file and `destDir: ""`.
3. `settings.json` now exists in the workspace root. A `DELETE` of the same source path removes
   the original.

## Root Cause

`safeResolve()` (`HostedWorkspaceViewerService.ts:647`) returns
`resolveOwnedUserSettingsFile(requestedPath)` before running `safeResolveWorkspacePath`'s
containment check. Its doc comment (`:617-627`) limits the exception to open/save/refresh, but
`deleteEntry` (`:1471`) and `resolveTransferPaths` (`:1507`, used by copy and move) call the same
`safeResolve`, and only reject the exact workspace root.

## Suggested Fix

Split the resolver: keep `safeResolve` strictly root-contained, and add a
`safeResolveForSettingsEdit()` (or an option) that applies the user-settings exception, used only
by the read-file and save-file paths. Check every other `safeResolve` caller (stage, discard,
diff, history, watch) and keep the exception out of each unless it is needed for the
settings-file editor. Add unit tests that delete, move and copy of the user settings path throw
"Path not allowed" while read and save still work.
