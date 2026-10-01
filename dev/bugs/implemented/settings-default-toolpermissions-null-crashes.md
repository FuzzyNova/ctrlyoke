# Schema-valid `defaults.toolPermissions: null` crashes workflow load and harness spawn

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/ConfigurationUtils.ts` (`getCliToolPermissions`, `getCliAllowedTools`, `getCliDeniedTools`, `resolveSpawnToolPermissions`)
- **Resolution:** fixed in this commit

## Symptom

`schemas/settings-schema.json` types `defaults.toolPermissions` as
`workflow.json#/$defs/toolPermissions`, whose `oneOf` allows `null`. So
`{"defaults":{"toolPermissions":null}}` validates in the editor. With that value:

- `getCliToolPermissions()` and `resolveSpawnToolPermissions(undefined)` throw
  "Cannot read properties of null (reading 'mode')".
- This breaks `PromptFileLoader` (~616-622) for any workflow without its own
  `toolPermissions`, every harness spawn path, and the settings sync to the
  webview (`WebviewSettingsSync.ts` ~897).

Expected: `null` means "pass no permission flags", as it already does at
workflow and step level.

## Steps to Reproduce

1. Put `{"defaults":{"toolPermissions":null}}` in `~/.ctrlyoke/settings.json`.
2. Load or run any workflow that doesn't set `toolPermissions`.
3. It fails with the null-dereference error.

## Root Cause

`deepMerge` replaces the default object with `null`, and the getters read
`.toolPermissions.mode` / `.allowedTools` / `.deniedTools` directly.

## Suggested Fix

Honour the schema: treat a `null` settings value as mode `none` with empty
lists in the getters, and have `resolveSpawnToolPermissions` return `null`
("pass no flags") when the settings layer is `null`, matching workflow-level
`null`. Single-source the null handling in one helper that the getters share.
Add unit tests for the null settings value.
