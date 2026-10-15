# MCP export overwrites the whole harness config when the read fails for any reason other than a missing file

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/HarnessMcpExporter.ts`
- **Resolution:** fixed in this commit

## Symptom

Exporting or removing an MCP server can silently replace a harness's entire config file with only the exported section. No error is shown. `~/.claude.json` loses every key except `mcpServers`, and `~/.codex/config.toml` keeps only the `[mcp_servers.*]` blocks. This happens whenever reading the existing file fails with anything other than `ENOENT`: EBUSY/EPERM from a concurrent writer or an antivirus lock on Windows, EACCES, EISDIR, or a transient I/O error.

The damage is serious. For Claude user scope the target is `~/.claude.json`, which also holds all of Claude Code's per-project state, auth and onboarding flags, and history. For Codex user scope it is `~/.codex/config.toml`, which holds the model, profile and approval settings.

There is a second problem. A JSON target that is a symlink (for example a dotfile-managed `~/.claude.json` or `opencode.json`) is replaced by a regular file, which breaks the link.

## Steps to Reproduce

1. Have an existing `~/.claude.json` (Claude CLI user scope) that contains other keys, such as `projects`, `oauthAccount` and `numStartups`.
2. Make the file unreadable while its directory stays writable. Either deny read with an ACL (`icacls ~/.claude.json /deny %USERNAME%:R`) or hit the window in which a running `claude` process is replacing the file by rename.
3. In the ctrlyoke MCP manager, export any server to Claude CLI at user scope. `src/ui/McpManagerService.ts:180` calls `HarnessMcpExporter.export`.
4. `readTextForEdit` swallows the EACCES/EPERM and returns `"{}"`. `writeJsonServerMap` applies only the `mcpServers` edit, and `writeTextFileAtomic` renames the temp file over `~/.claude.json`.
5. `~/.claude.json` now contains only `{ "mcpServers": { ... } }`, and every other key is gone. Codex user scope fails the same way: `~/.codex/config.toml` is rewritten with only the exported blocks.

## Root Cause

`src/utils/HarnessMcpExporter.ts:51-57` (`readTextForEdit`) and `:59-65` (`readTextFile`) catch every read error, not just `ENOENT`, and return an empty base (`"{}"` or `""`). The callers then overwrite the target from that empty base:

- `writeJsonServerMap`: reads at `:333`, writes at `:349`
- `removeJsonServerMapEntries`: reads at `:358`, writes at `:375`
- `writeCodexTomlFile`: reads at `:383`, writes at `:441-442`
- `removeCodexTomlServers`: reads at `:455`, writes at `:497-502`

Separately, `writeTextFileAtomic` (`:67-80`) renames over `filePath` without resolving it with `realpath`, so a symlinked target is replaced by a regular file. Its temp name (`${filePath}.${process.pid}.tmp`) also has no random suffix. The Codex TOML paths skip the atomic writer altogether and call a plain `fs.promises.writeFile`.

The sibling `src/utils/HarnessLspExporter.ts` already handles both cases correctly. Its `read` (`:32-39`) maps only `ENOENT` to `"{}"` and rethrows everything else. Its `write` (`:40-56`) resolves `realpath` before the rename (`:43-47`) and uses a `randomUUID()` temp suffix.

## Suggested Fix

- Change both read helpers to return the empty base only when `(error as NodeJS.ErrnoException).code === "ENOENT"` and to rethrow anything else. The export or remove then fails with a visible error instead of discarding data.
- Make `writeTextFileAtomic` resolve `fs.promises.realpath(filePath)` before the rename, tolerating `ENOENT`, and give the temp file a random suffix.
- Send the Codex TOML writes through the same atomic writer instead of a plain `writeFile`.
- Better still, move the read and atomic-write helpers into one shared utility used by both `HarnessMcpExporter` and `HarnessLspExporter` (DRY).
- Add unit tests in `src/test/unit/HarnessMcpExporter.test.ts` for an unreadable existing file (export and remove must reject and leave the file untouched) and for a symlinked target (the link must survive and its target must be updated).
