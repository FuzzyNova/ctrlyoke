# `capabilities.json` is torn by overlapping non-atomic writes, which breaks `list_harnesses`

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; found corrupt in this worktree, race reproduced)
- **Area:** `src/ui/WebviewSettingsSync.ts` (`refreshCapabilitiesFile`, `writeCapabilities`), `src/mcp-server.ts` (`readCapabilities`)
- **Severity:** medium

## Symptom

This worktree's `.ctrlyoke/capabilities.json` (4792 bytes) was invalid JSON. It ended in `}}`,
the leftover tail of an earlier, longer write. While the file is torn, and it stays torn until the
next write:

- `list_harnesses` throws "capabilities.json not found. Start a workflow in VS Code first…", which
  is misleading because the file exists;
- `validateStepHarnessAndModelCapabilities` returns early (`mcp-server.ts:1570`), so `append_step`
  and `edit_step` accept any harness or model.

## Steps to Reproduce

1. Start the extension. Harness detection and model discovery both refresh the file at startup.
2. When the two writes overlap and the second is shorter, the file keeps the first write's tail.
   Two concurrent `fs.writeFile` calls of slightly different lengths tore the file in 395 of 500
   trials.
3. Call `list_harnesses` from an MCP client. It reports the file as missing.

## Root Cause

`sendModelOptionsUpdate` (`WebviewSettingsSync.ts:355`) and `sendHarnessStatusUpdate` (`:369`)
both fire `void this.refreshCapabilitiesFile(...)` without awaiting it. The write (`:833-837`) is a
plain `fs.writeFile`, not an atomic temp-file-and-rename. `readCapabilities`
(`mcp-server.ts:1551-1563`) returns `null` on a parse error, the same as for a missing file.

## Suggested Fix

- Write through `writeFileAtomic` from `src/utils/AtomicFileUtils.ts`.
- Serialize the refreshes so a later refresh can't be overtaken by an earlier one, e.g. with a
  promise chain or the existing `AsyncWriteQueue`.
- In `readCapabilities`, tell "missing" apart from "unparseable", so the error says what is
  actually wrong.
