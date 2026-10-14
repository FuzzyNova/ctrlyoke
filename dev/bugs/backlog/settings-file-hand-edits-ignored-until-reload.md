# Hand edits to `.ctrlyoke/settings.json` are ignored until the window reloads

- **Found:** 2026-10-14 by Claude Code (setting up the D19 near-limit warning screenshot)
- **Area:** `src/config/FileConfigBackend.ts`
- **Severity:** medium

## Symptom

Editing a ctrlyoke settings file outside the Settings drawer has no effect on a running
extension host. The drawer keeps showing the old value, and runs keep using it, until the
window is reloaded. No message says a reload is needed.

`docs/guide/settings.md` presents hand-editing as a normal workflow. It says "VS Code
validates both files against ctrlyoke's settings schema as you type" and, for an invalid
file, "Fix the file by hand". It also says "the CLI reads the same ones, so a value set in
one place applies everywhere". A value written by `ctrlyoke` or by a second VS Code window
is also invisible to a host that has already cached the file.

## Steps to Reproduce

1. With the dashboard open on a workspace, add to `<workspace>/.ctrlyoke/settings.json`:
   ```json
   "usageTracking": { "warningPercentUsed": 5 }
   ```
2. Open Settings → Stats & Usage, Workspace scope. **Usage warning threshold** still shows 80.
3. Start a workflow whose AI step's harness has fresh quota above 5%. No near-limit warning
   appears; the run uses the cached 80.

## Root Cause

`FileConfigBackend.getAll()` (`src/config/FileConfigBackend.ts:78-84`) returns
`state.cache` once it has been loaded. That cache is shared per path for the lifetime of the
process (`backendStatesByPath`, `:27-41`) and is cleared only by this backend's own `set()`
(`:116`). Nothing watches either settings file: no `createFileSystemWatcher` or `fs.watch`
covers `.ctrlyoke/settings.json` or `~/.ctrlyoke/settings.json` (the only watchers are for
completions, logs, statuslines, package.json and run coordination).

## Suggested Fix

Watch both settings files through the existing `FileWatcherFactory` (or `fs.watch` in the CLI
and MCP hosts, which are short-lived and can keep the current behaviour). On change, clear the
backend's cache, re-merge, and push the new settings to the dashboard the same way a drawer
write does, so every consumer that re-reads per use sees the new value. A cheaper alternative is
to compare the file's mtime in `getAll()` and reload when it changes. Add a test that edits the
file on disk and expects `getAll()` to return the new value. If some settings only apply at
startup (server bind address, port), say so in the settings reference.
