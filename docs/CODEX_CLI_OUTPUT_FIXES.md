# Codex CLI Output Formatting

**Status**: IMPLEMENTED  
**Originally Fixed**: 2026-02-02  
**Last Verified**: 2026-02-25

---

## Overview

This document describes Codex CLI-specific output handling in FlightPath — ANSI code stripping, the diff unavailability limitation, and Codex-specific event parsing. The implementation lives in `src/flightpath/harness/codex/CodexResponseParser.ts`.

> **Note on webview migration**: The original bug-fix document (in `docs/research/`) referenced `src/ui/webview/output-manager.js` and `src/ui/webview/dashboard.scss`. Those files were part of the legacy JavaScript webview that has been replaced by the React webview (`src/ui/webview-react/`). The behaviors described there are now handled by React components with Tailwind CSS.

---

## 1. ANSI Escape Code Stripping

### Problem

Codex CLI captures raw terminal output from PowerShell, including ANSI color codes (e.g., `\u001b[32;1mPath\u001b[0m`) from colored terminal tools.

### Implementation

`CodexResponseParser.ts` strips all ANSI sequences before creating events:

```typescript
private stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
```

Called in two places:

- **`parseItemToEvents()`** — strips `item.aggregated_output` from completed command outputs
- **`processStreamingChunk()`** — strips streaming deltas in real time

This ensures the React webview and VS Code Output panel never receive raw escape sequences.

---

## 2. File Edit: No Diff Available

### Limitation

Codex CLI `file_change` events are metadata-only. They do not include file content or diff information:

```json
{
  "type": "file_change",
  "changes": [{ "path": "src/foo.ts", "kind": "update" }],
  "status": "completed"
}
```

There is no `oldContent`, `newContent`, or `structuredPatch`.

### Current Behavior

`FileEditData` events from Codex will have only `path` and `status` set. The React webview component (`ToolCallOutput.tsx`) renders file edit events conditionally:

- If `structuredPatch` is present → renders unified diff visualization
- If `oldContent`/`newContent` is present → renders computed diff
- Otherwise → renders file path only (shows the edit happened without diff detail)

**Comparison across harnesses:**
| Harness | Diff Support |
|---|---|
| Claude CLI | ✅ `structuredPatch` with accurate line numbers |
| Copilot CLI | ✅ `oldContent`/`newContent` for diff generation |
| Codex CLI | ❌ Path and kind only |

### Future Consideration

If Codex CLI adds diff data in future versions, update `CodexResponseParser.ts` to extract it into `FileEditData.structuredPatch` or `FileEditData.oldContent`/`newContent`. No changes needed elsewhere — the React component already handles all cases.

---

## 3. Status and Badge Styling (React Webview)

The legacy `dashboard.scss` `.status-badge` styling has been replaced by Tailwind utility classes in the React webview. Execution state badges (running, paused, completed, error) are styled via:

- **`src/ui/webview-react/utils/status.ts`** — `EXECUTION_STATE_BADGE_CLASSES` map and `getExecutionStateBadgeClass()` helper
- **`src/ui/webview-react/tailwind.config.js`** — badge color variables (`badge-bg`, `badge-fg`) mapped to VS Code theme tokens
- **`src/ui/webview-react/styles/globals.css`** — execution state badge background CSS variables

---

## Codex CLI Event Parsing Summary

`CodexResponseParser.ts` handles two sources of Codex output:

1. **Interactive mode** — JSONL events read from a log file via `CodexLogParser.ts` (notify hook)
2. **Headless mode** — JSONL `{"type":"turn.completed"}` events from a background process

The parser normalizes Codex-specific field names into the universal `CliEvent` format. Notably:

- Both `input` and `arguments` fields in tool call events are normalized to `parameters`
- `reasoningBlocks` are emitted as top-level `CLI_EVENT_TYPES.THINKING` events (not nested in metadata)
- `reasoningOutputTokens` is included in `TokenUsage` for accurate token accounting
