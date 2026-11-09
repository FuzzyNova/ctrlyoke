# Saving a file in the hosted viewer resets its permissions (drops +x, widens 0600 to 0644)

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced against the compiled service)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`saveFile`, ~1645-1709), `src/utils/AtomicFileUtils.ts` (`writeFileAtomic`)
- **Severity:** high

## Symptom

Saving through the hosted workspace viewer's editor changes the file mode:

- `run.sh` 0755 → 0644, so the script stops being executable (`permission denied`).
- `.env` 0600 → 0644, so an owner-only credential file becomes world-readable.

The user settings file (`~/.ctrlyoke/settings.json`, saved via the same route through
`safeResolveForSettingsEdit`) is affected too.

## Steps to Reproduce

1. Create `run.sh` with mode 0755 and `.env` with mode 0600 in the workspace.
2. Call `HostedWorkspaceViewerService.saveFile` on each with its current `baseModifiedAt`.
3. `stat` them: both are now 0644 (with the default umask).

## Root Cause

`saveFile` ends with `writeFileAtomic(resolved, content)` (~1708). `writeFileAtomic` creates a new
temp file with `fs.open(tmp, "wx")` (0666 minus umask) and renames it over the target; it only
applies a mode when `options.mode` is passed. `saveFile` already `stat`s the existing file
(`latest`) but drops its mode. `writeTextFileAtomic` in the same module preserves the mode for
exactly this reason.

## Suggested Fix

Pass `{ mode: latest.mode & 0o7777 }` to `writeFileAtomic` when the file exists (leave it
undefined for a new file). Add a `saveFile` test in
`src/test/unit/HostedWorkspaceViewerService.test.ts` asserting 0755 and 0600 survive a save
(skip on Windows).
