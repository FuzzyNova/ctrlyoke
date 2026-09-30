# Empty or non-object settings.json blocks writes, crashes reads, or loses writes

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/config/FileConfigBackend.ts` (`load`, `set`), `src/config/CtrlYokeConfigService.ts` (`deepMerge`, `filterWorkspaceSettings`)
- **Resolution:** fixed in this commit

## Symptom

Reproduced with the real `CtrlYokeConfigService` + `FileConfigBackend`:

- **Empty file** (also whitespace-only or comment-only): every `set()` throws
  "Cannot update settings file because it contains invalid JSON". An empty
  `settings.json` is easy to create (`New-Item`, a new file in the editor) and
  has nothing to protect. Settings writes from the dashboard fail until the user
  deletes the file by hand.
- **Root is `null`**: `getAll()` throws "Cannot convert undefined or null to
  object" and `set()` throws "Cannot use 'in' operator … in null". A committed
  workspace `.ctrlyoke/settings.json` containing `null` breaks the extension
  and the CLI the same way through `filterWorkspaceSettings`.
- **Root is `[]`**: `set("ui.showCliCommand", false)` resolves successfully,
  but the file stays `[]`. The write is silently lost.
- **A section is `null` or a primitive** (e.g. `{"diagnostics": null}`): it
  replaces the whole defaults object, so `get("diagnostics").verboseLogging`
  throws.

## Steps to Reproduce

1. Create an empty `~/.ctrlyoke/settings.json`.
2. Change any setting from the dashboard settings page.
3. The write fails with the invalid-JSON error.

## Root Cause

`jsonc-parser` reports a `ValueExpected` error for empty/comment-only input,
so `load()` sets `hasInvalidContent` (the protection added for
`settings-file-unparseable-json-overwritten-on-write`). `load()` also accepts
any JSON value as the root, not just a plain object. `deepMerge` lets `null` or
a primitive replace an object-typed default.

## Suggested Fix

- In `load()`, treat content that is only whitespace/comments (after BOM strip)
  as `{}` without setting `hasInvalidContent`.
- Treat a root that is not a plain object as invalid content (set
  `hasInvalidContent`, return `{}`), so reads fall back to defaults and writes
  refuse rather than silently dropping.
- In `deepMerge`, don't let `null` or a primitive replace an object-typed
  default section. Leaves the schema allows to be `null` should still pass
  through; see `settings-default-toolpermissions-null-crashes`.
- Unit tests for each case.
