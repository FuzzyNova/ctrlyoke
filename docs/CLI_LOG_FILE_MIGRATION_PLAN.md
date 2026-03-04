# CLI Log File Migration Plan: Removing TUI Parsing

## Status: IMPLEMENTED (January–February 2026)

This document describes the migration from TUI screen parsing to JSONL log file monitoring for all three CLI providers. The migration is **complete** — TUI parsing code has been removed and all providers use log file monitoring in interactive mode.

---

## Summary of What Changed

**Before:** Interactive mode streamed TUI output, stripped ANSI codes, applied 100+ chrome-filter regex patterns, and used heuristic completion detection based on screen states.

**After:** Interactive mode spawns the CLI in a VS Code terminal (TUI still displays for user visibility), ignores all terminal output, and watches the provider's native JSONL log files for structured events.

| Before                                        | After                                                 |
| --------------------------------------------- | ----------------------------------------------------- |
| `TuiStreamProcessor.ts` (997 lines)           | **Deleted**                                           |
| 104 chrome-filter regex patterns              | **Removed**                                           |
| Heuristic completion detection                | Event-based (`turn.completed`, `stop_reason != null`) |
| `flightpath.copilotCliLogDir` setting         | **Removed**                                           |
| Copilot `--log-dir` / `--log-level` args      | **Removed**                                           |
| Debug `process-*.log` parsing for session IDs | Prompt-matching against native session logs           |

**Code reduction:** ~1,600 lines removed, ~600-700 lines added (net −1,000 lines).

---

## Implementation Files

### New Files Added

| File                                                 | Description                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/flightpath/cli/shared/interfaces/ILogParser.ts` | Log parser interface                                                       |
| `src/flightpath/cli/shared/BaseLogParser.ts`         | Abstract base: file watching, JSONL reading, session discovery             |
| `src/flightpath/cli/claude/ClaudeLogParser.ts`       | Claude log parser (`~/.claude/projects/`)                                  |
| `src/flightpath/cli/copilot/CopilotLogParser.ts`     | Copilot log parser (`~/.copilot/session-state/`), supports old+new formats |
| `src/flightpath/cli/codex/CodexLogParser.ts`         | Codex log parser (`~/.codex/sessions/YYYY/MM/DD/`)                         |

### Files Modified

| File                                                   | Change                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/flightpath/cli/CliIntegration.ts`                 | Replaced TUI streaming with `monitorLogFile()` using `provider.logParser`                                                                                         |
| `src/flightpath/cli/copilot/CopilotCliProvider.ts`     | Removed `--log-dir`, `--log-level`, debug log dir; added `logParser` field; `extractSessionIdFromLogs()` now delegates to `CopilotLogParser.discoverSessionLog()` |
| `src/flightpath/cli/claude/ClaudeCliProvider.ts`       | Added `logParser` field                                                                                                                                           |
| `src/flightpath/cli/codex/CodexCliProvider.ts`         | Added `logParser` field                                                                                                                                           |
| `src/flightpath/cli/shared/interfaces/ICliProvider.ts` | Added `readonly logParser: ILogParser` to interface; removed TUI config fields (`escapeIndicator`, `screenEndPattern`, `chromePatterns`)                          |
| `package.json`                                         | Removed `flightpath.copilotCliLogDir` setting                                                                                                                     |

### Files Deleted

| File                              | Description                               |
| --------------------------------- | ----------------------------------------- |
| `src/utils/TuiStreamProcessor.ts` | 997-line TUI parser — entire file removed |

### Tests

`src/test/suite/cli/LogParsers.test.ts` — Comprehensive unit tests for all three log parsers, covering:

- Response extraction from real log event structures
- Completion detection
- Session ID extraction
- Copilot old-format (flat file) and new-format (subdirectory) compatibility
- Concurrent session handling

---

## Architecture: How Log Monitoring Works

### Interactive Mode Flow (Post-Migration)

```
1. Spawn CLI in VS Code terminal
   └── TUI displays normally for user visibility
   └── FlightPath does NOT read terminal output

2. Discover session log file
   ├── Provider-specific log directory
   ├── Filter by files modified after startTime
   └── Match user.message content against promptText (first 100 chars)

3. Watch log file with fs.watch()
   └── On file change: read new JSONL events

4. Parse events
   ├── Extract response text and tool call output
   ├── Track token usage and metadata
   └── Check completion via isComplete(event)

5. On completion
   ├── Stream final response to Output channel
   ├── Extract session ID for tracking/resumption
   └── Close file watcher
```

### Headless Mode (Unchanged)

Headless mode continues to use stdout parsers (`ClaudeResponseParser`, `CodexResponseParser`, `CopilotResponseParser`) because:

- Stdout formats differ from log file formats (streaming JSON vs persistence JSONL)
- Headless provides immediate feedback without waiting for log files
- No TUI to ignore

### BaseLogParser Responsibilities

- **Incremental reading:** Tracks `lastReadPosition` (byte offset) to avoid re-reading
- **File watching:** `fs.watch()` for efficient change detection
- **JSONL parsing:** Line-by-line with error recovery for malformed lines
- **Session discovery:** `findModifiedSessionLogs()` utility for candidate filtering

### Provider-Specific Responsibilities

Each log parser implements four abstract methods:

- `extractResponse(events)` → `UniversalCliOutput`
- `isComplete(event)` → `boolean`
- `extractSessionId(events)` → `string | null`
- `discoverSessionLog(promptText, startTime, sessionId?)` → `string | null`

---

## Session Discovery: Prompt Content Matching

**Why not "most recently modified" log?** Multiple CLI sessions may run concurrently (e.g., user manually running Copilot while FlightPath runs another). Picking the most-recent file would be a race condition.

**Solution:** Match the first 100 characters of `promptText` against the `user.message` event in each candidate log. This is robust to concurrency.

**For Claude/Codex:** The `Start` hook also provides session IDs directly when available, enabling a faster path (no scanning needed).

**Copilot Format Compatibility:** `CopilotLogParser` checks for the new subdirectory format (`<session-id>/events.jsonl`) first, then falls back to the flat file format (`<session-id>.jsonl`) for compatibility with older CLI versions.

---

## Copilot-Specific: Session ID Extraction (Before vs After)

**Before (removed):**

```typescript
// CopilotCliProvider.ts - DELETED
private logDirectory = path.join(os.tmpdir(), 'flightpath-copilot-logs');

// buildCliArgs() added:
args.push('--log-dir', this.logDirectory);
args.push('--log-level', 'debug');  // Required for session ID to appear in logs

// extractSessionIdFromLogs() parsed process-*.log:
// "Flushed X events to session {GUID}"
```

**After (current):**

```typescript
// CopilotCliProvider.ts - CURRENT
readonly logParser = new CopilotLogParser();

async extractSessionIdFromLogs(promptText: string, startTime: Date) {
  const logPath = await this.logParser.discoverSessionLog(promptText, startTime);
  return logPath ? this.logParser.extractSessionIdFromLogPath(logPath) : undefined;
}
```

---

## Known Cleanup Items

The following stale references remain and should be cleaned up:

1. **Stale comment in `CopilotCliProvider.ts` line 77:** JSDoc comment still mentions `--log-dir` and `--log-level` as handled args, but the implementation no longer passes them.
2. **Stale docs in `.github/copilot-instructions.md`:** Still mentions `flightpath.copilotCliLogDir` setting (removed from package.json).
3. **Stale docs in `.github/instructions/harness-integrations.instructions.md`:** Same stale `copilotCliLogDir` reference.

---

## Log File Formats Reference

See [CLI_LOG_FILES_INVESTIGATION.md](./CLI_LOG_FILES_INVESTIGATION.md) for detailed JSONL event structures for all three providers.
