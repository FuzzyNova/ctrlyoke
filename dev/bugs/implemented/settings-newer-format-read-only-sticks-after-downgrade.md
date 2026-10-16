# Settings stay read-only after a newer-format settings file returns to a supported version

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/config/FileConfigBackend.ts`
- **Resolution:** fixed in this commit

## Symptom

Once a `settings.json` with a newer `schemaVersion` has been read, that backend
stays read-only for the rest of the session. This holds even after the file goes
back to a supported version, for example after a branch switch or a revert. The
settings drawer keeps showing "These settings use a newer format…", and every
save fails with "written by a newer version (format N)" until the window is
reloaded. Commit 730b164ed made the extension re-read edited settings files
without a restart, so the new content is loaded but the read-only flag is not
cleared.

## Steps to Reproduce

1. Write `.ctrlyoke/settings.json` as `{ "schemaVersion": 999 }` and let
   ctrlyoke read it (`getAll()`).
2. Rewrite it as `{ "schemaVersion": 1, "ui": { "showCostEstimates": false } }`.
3. `getAll()` returns the new content, but `isReadOnly` is still `true` and
   `set("ui.showCostEstimates", true)` throws the newer-version error.

Reproduced against the compiled `out/config/FileConfigBackend.js`.

## Root Cause

`load()` (`FileConfigBackend.ts` ~133) resets `this.hasInvalidContent = false`
on every call, but `this.newerSchemaVersion` is only ever assigned (~164), never
cleared. `isReadOnly` (~81) and the write guard in `set()` (~111) both read it.

## Suggested Fix

Reset `this.newerSchemaVersion = undefined` next to
`this.hasInvalidContent = false` at the top of `load()`. Add a test: write a
newer file and read it, write a v1 file and read it, then check that
`isReadOnly` is false and `set()` succeeds.
