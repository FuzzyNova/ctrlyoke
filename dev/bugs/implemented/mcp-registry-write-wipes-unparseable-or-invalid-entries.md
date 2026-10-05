# Saving an MCP server wipes the registry when servers.json is unparseable, BOM-prefixed, or has one invalid entry

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced against the compiled `McpRegistryFileManager`
- **Area:** `src/utils/McpRegistryFileManager.ts` (`readJsonFile`, `readScope`, `addOrUpdate`, `remove`, `writeJsonFileAtomic`), caller `src/ui/McpManagerService.ts` (`handleSaveRegistryServer`, `handleDeleteRegistryServer`)
- **Resolution:** fixed in this commit

## Symptom

`addOrUpdate` and `remove` are read-modify-write over `readScope`, and `readScope`
returns `[]` for a file it cannot parse and silently drops entries that fail
`isMcpServerConfig`. The write then persists only what survived. Reproduced by
calling `addOrUpdate({ id: "c", command: "z" }, "workspace")` on
`.ctrlyoke/mcp/servers.json` with:

| Existing file                                                             | Result after the save                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `﻿[{"id":"a","command":"x"}]` (UTF-8 BOM, as Notepad/PowerShell write it) | `["c"]` — `a` deleted                                   |
| `[{"id":"a","command":"x"},]` (hand-edit typo)                            | `["c"]` — `a` deleted                                   |
| `[{"id":"a",...},{"id":"b","command":"y","env":{"PORT":3000}}]`           | `["a","c"]` — `b` deleted (one `Log.warn`, no UI error) |

The same happens for **Delete** of any server, and for rename (which is a `remove` then
an `addOrUpdate`). The workspace file is typically committed and shared, so one click in
the MCP manager can delete a team's servers; the user scope file holds every personal
server.

This is the same class as the settings bugs fixed in
`dev/bugs/implemented/settings-file-unparseable-json-overwritten-on-write.md` and
`workflow-file-utf8-bom-breaks-json-and-frontmatter.md`, applied to a store those fixes
didn't cover.

## Steps to Reproduce

1. Put `[{"id":"a","command":"x"},]` (or a BOM-prefixed valid array) in
   `<workspace>/.ctrlyoke/mcp/servers.json`.
2. In the dashboard's MCP manager, add a workspace-scoped server `c`, or delete another
   one.
3. `servers.json` now contains only `c`.

## Root Cause

`readJsonFile` swallows parse errors as `null` and doesn't strip a BOM; `readScope` maps
both "unreadable" and "not an array" to `[]` and filters out invalid entries; the
mutating methods write back `readScope`'s filtered view. `writeJsonFileAtomic` also uses
a per-process temp name (`<file>.<pid>.tmp`), so two concurrent saves in one process
share a temp file, and there is no write queue, so concurrent saves lose updates.

## Suggested Fix

- Strip a leading BOM before parsing (reuse the shared helper the workflow/settings fix
  introduced, if one exists).
- Split reading for display from reading for mutation. For mutation, distinguish
  missing file (start from `[]`) from unparseable/non-array content (throw a clear
  error naming the file, so the UI shows "fix servers.json first" rather than
  overwriting it).
- Preserve entries that fail validation verbatim on write: operate on the raw parsed
  array, replacing/removing only the entry whose `id` matches.
- Use a unique temp name (pid + random, like `TrustDecisionFile.ts`/settings) and
  serialize writes per resolved path.

Unit tests for each table row (entry preserved or error raised, file untouched) and a
rename.
