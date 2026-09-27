# An unparseable settings file is silently overwritten by the next settings write

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/config/FileConfigBackend.ts` (`load`, `set`)
- **Severity:** high

## Symptom

If `.ctrlyoke/settings.json` (or the user-level settings file) exists but does not parse
as JSON, the next `set()` replaces the whole file with only the one setting just changed.
Every other setting is lost, with no prompt and only a `console.warn`.

Ordinary edits trigger it:

- a UTF-8 BOM (VS Code "UTF-8 with BOM", Notepad, PowerShell 5.1 `Set-Content -Encoding UTF8`)
- a trailing comma or a `//` comment left by a hand edit

Reproduced by running the real `FileConfigBackend` under `npx tsx`. The file held
`{ "worktrees": {"root":"D:/wt"}, "execution": {"injectMode":"x"} }`, once with a leading
`\uFEFF` and once with a trailing comma, and then:

```ts
const b = new FileConfigBackend(p); b.getAll(); await b.set("ui.showCostEstimates", false);
```

Output (the same for both files):

```
[ctrlyoke] Settings file has invalid JSON and will be treated as empty: C:/tmp/cyk-cfg/BOM.json
BOM getAll(): {}
BOM file after set(): { "ui": { "showCostEstimates": false }, "schemaVersion": 1 }
```

## Steps to Reproduce

1. Save `.ctrlyoke/settings.json` with several settings as "UTF-8 with BOM", or add a
   trailing comma.
2. Change any setting from the dashboard settings UI (or anything that calls
   `FileConfigBackend.set`).
3. The file now holds only that one setting plus `schemaVersion`.

## Root Cause

`load()` (`FileConfigBackend.ts:~74-107`) catches the `JSON.parse` failure and returns
`{}`. `set()` (`:~50-66`) calls `load()`, writes the single path into that empty object,
and `save()`s it over the real file. There is no BOM stripping before `JSON.parse`.

The catch comment justifies the fallback as "interrupted prior write". But `save()`
already writes atomically (tmp + rename), and its own comment says the atomic write
exists to stop a corrupt file "which would cause the next set() call to silently wipe
all settings". That is what this path still does for a file the user edited by hand.

`set()` already refuses to write when the file declares a newer schema version
(`refuseNewerSchema`). A file that exists but can't be parsed deserves the same
protection.

## Suggested Fix

- Strip one leading `\uFEFF` before parsing. Share the helper with the BOM stripping that
  `PromptFileParser` gained in `d5945992` instead of adding a second copy.
- Consider parsing with the existing JSONC helper (`src/utils/JsoncUtils.ts`,
  `stripJsonComments`) so comments and trailing commas that VS Code's JSON editor allows
  are accepted.
- When the file exists but still won't parse, remember that in `load()`. `set()` should
  then throw a clear error naming the file instead of saving over it, the same way it
  does for a newer schema. Reads can keep treating it as empty.
- Tests: a BOM file loads and keeps its keys through a `set()`; an invalid file makes
  `set()` reject and leaves the file byte-for-byte unchanged; a missing file still works
  as before.
