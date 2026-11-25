# Statusline wrapper ignores settings files that use comments, trailing commas or a BOM

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, code review and reproduction)
- **Area:** `src/scripts/ctrlyoke-statusline-wrapper.js` (`readSettingsFile`, `findWorkspaceSettingsFromCwd`), `src/config/JsoncObjectFile.ts`
- **Severity:** medium

## Symptom

`docs/guide/settings.md` says the settings files "accept comments and trailing commas",
and the extension and CLI read them that way. The provider statusline wrapper does not.
When `~/.ctrlyoke/settings.json` contains a comment, a trailing comma or a UTF-8 BOM,
the wrapper silently treats the file as missing:

- `statusLine.byHarness.<harness>.enabled: false`, `customCommand`,
  `useCtrlyokeStyle`, the format settings and `usageTracking.percentDirection` all
  fall back to defaults. A statusline the user turned off comes back on, and a
  custom command is not run.
- The newer-version guard is skipped. A JSONC settings file written by a newer
  ctrlyoke (`schemaVersion` above current) should disable the statusline
  (`userSettings.unsupported`), but it never reaches `migrateToCurrent`.
- In the cwd fallback, `findWorkspaceSettingsFromCwd` treats the unparsable
  project file as absent and keeps walking up, so it can pick up an ancestor
  directory's `.ctrlyoke/settings.json` instead.

## Steps to Reproduce

1. Write `<home>/.ctrlyoke/settings.json`:
   ```jsonc
   {
     // disable the Claude statusline
     "schemaVersion": 2,
     "statusLine": { "byHarness": { "claude-cli": { "enabled": false, "customCommand": "echo hi" } } },
   }
   ```
2. From the compiled `out/scripts/ctrlyoke-statusline-wrapper.js`, call
   `resolveStatusLineSettings("claude", home, { workspaceRoot: "/nonexistent" })`.
3. Observed: `enabled: true`, `customCommand: ""` (defaults). With the same content as
   plain JSON, the result is `enabled: false`. Plain JSON with a leading BOM also gives
   `enabled: true`. A JSONC file with `"schemaVersion": 99` is not reported as unsupported.

## Root Cause

`readSettingsFile` (`src/scripts/ctrlyoke-statusline-wrapper.js` ~82-107) does
`JSON.parse(fs.readFileSync(settingsPath, "utf8"))`. Any parse error falls into the outer
`catch`, which returns `{ found: false, settings: {} }`. Every other settings reader
goes through `readJsoncObjectFile` (`src/config/JsoncObjectFile.ts:24`), which strips a
BOM and accepts comments and trailing commas (`FileConfigBackend.load()`).

## Suggested Fix

- Parse with the same JSONC reader. The wrapper is plain JS that already `require`s
  the `out/scripts/ctrlyoke-format-migrations.js` bundle, built from
  `src/utils/FormatMigrations.ts` (`esbuild.js` ~432-443). Either re-export the
  JSONC parsing helper from that entry point, or add a small bundled entry for
  it. Don't hand-roll a second JSONC parser in the wrapper.
- Treat a file that exists but cannot be parsed as `found: true` with empty settings, so
  the cwd walk stops at the project's own file.
- Add cases to `src/test/unit/StatuslineWrapper.test.ts` for comments, trailing
  commas, a BOM, a JSONC file with a newer `schemaVersion` (it must disable the
  statusline), and an unparsable project file that stops the cwd walk.
