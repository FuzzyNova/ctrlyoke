# CLI Log Files: Cross-Provider Reference

## Status: IMPLEMENTED (January 2026)

**This document captures the investigation findings that led to the CLI log file migration. The approach was fully adopted — all three CLI providers now use JSONL log file monitoring in interactive mode instead of TUI screen parsing.**

**Related:** [CLI Log Parsing Status](./CLI_LOG_PARSING_STATUS.md)

---

## Overview

All three CLI providers (Claude Code, GitHub Copilot, OpenAI Codex) maintain structured JSONL log files that FlightPath uses as the primary data source for interactive mode response monitoring. This eliminated the need for TUI screen parsing, ANSI stripping, and screen deduplication.

**Implementation:** `src/flightpath/cli/shared/BaseLogParser.ts` + three provider-specific subclasses.

---

## Quick Reference: Log File Locations

| Provider    | Log Directory                        | File Naming                                                                       | Index File                             |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------- |
| **Claude**  | `~/.claude/projects/<project-path>/` | `<session-id>.jsonl`                                                              | `sessions-index.json`                  |
| **Copilot** | `~/.copilot/session-state/`          | **Old:** `<session-id>.jsonl`<br>**New (v0.0.384+):** `<session-id>/events.jsonl` | `history-session-state/session_*.json` |
| **Codex**   | `~/.codex/sessions/YYYY/MM/DD/`      | `rollout-<timestamp>-<session-id>.jsonl`                                          | None (date-based organization)         |

**⚠️ Copilot Format Change:** Copilot changed its log format in version 0.0.384 (mid-January 2026). `CopilotLogParser` supports both old (flat file) and new (subdirectory) formats.

---

## Implementation Files

| Provider    | Log Parser           | Location                                             |
| ----------- | -------------------- | ---------------------------------------------------- |
| Shared base | `BaseLogParser`      | `src/flightpath/cli/shared/BaseLogParser.ts`         |
| Claude      | `ClaudeLogParser`    | `src/flightpath/cli/claude/ClaudeLogParser.ts`       |
| Copilot     | `CopilotLogParser`   | `src/flightpath/cli/copilot/CopilotLogParser.ts`     |
| Codex       | `CodexLogParser`     | `src/flightpath/cli/codex/CodexLogParser.ts`         |
| Interface   | `ILogParser`         | `src/flightpath/cli/shared/interfaces/ILogParser.ts` |
| Tests       | `LogParsers.test.ts` | `src/test/suite/cli/LogParsers.test.ts`              |

---

## Claude CLI Log File Structure

### Directory Location

```
~/.claude/projects/<project-path>/
```

Example for FlightPath project (Windows):

```
C:\Users\natha\.claude\projects\C--dev-FlightPath\
```

### File Organization

- One `.jsonl` file per session: `<session-id>.jsonl`
- One directory per session (for subagents): `<session-id>/subagents/`
- Agent sessions: `agent-<short-id>.jsonl`
- Index file: `sessions-index.json`

### Sessions Index Format (`sessions-index.json`)

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "0052ba5f-5354-48cd-bede-558c1258090b",
      "fullPath": "C:\\Users\\natha\\.claude\\projects\\c--dev-FlightPath\\0052ba5f-5354-48cd-bede-558c1258090b.jsonl",
      "fileMtime": 1768152401858,
      "firstPrompt": "Follow instructions in @.flightpath\\temp\\...",
      "messageCount": 6,
      "created": "2026-01-11T17:23:14.658Z",
      "modified": "2026-01-11T17:26:41.858Z",
      "gitBranch": "main",
      "projectPath": "c:\\dev\\FlightPath",
      "isSidechain": false
    }
  ]
}
```

**Session Discovery:** `ClaudeLogParser.discoverSessionLog()` uses `sessions-index.json` to find the correct session by matching `firstPrompt` content and `created` timestamp.

### JSONL Event Types

| Event Type        | Description                                        |
| ----------------- | -------------------------------------------------- |
| `user`            | User prompt messages                               |
| `assistant`       | Claude response (with `stop_reason` when complete) |
| `queue-operation` | FlightPath-specific dequeue markers                |

### Completion Detection

`ClaudeLogParser.isComplete()` returns `true` when an `assistant` event has a non-null `stop_reason` field (e.g., `"end_turn"`, `"max_tokens"`).

---

## Copilot CLI Log File Structure

### Directory Location

```
~/.copilot/session-state/
```

### File Organization

**Old Format (pre-v0.0.384):**

```
session-state/
├── <session-id>.jsonl    ← Flat file per session
└── history-session-state/
    └── session_<id>_<timestamp>.json
```

**New Format (v0.0.384+):**

```
session-state/
├── <session-id>/
│   └── events.jsonl      ← Subdirectory per session
└── history-session-state/
    └── session_<id>_<timestamp>.json
```

`CopilotLogParser` detects format automatically: checks for subdirectory first, falls back to flat file.

### Key JSONL Event Types

| Event Type                | Description                                |
| ------------------------- | ------------------------------------------ |
| `session.start`           | Session initialization with `sessionId`    |
| `session.info`            | Auth, MCP connection info                  |
| `session.model_change`    | Model selection                            |
| `user.message`            | User prompt with optional file attachments |
| `assistant.turn_start`    | Response begins                            |
| `assistant.message`       | Response text chunks                       |
| `assistant.turn_end`      | **Completion signal** (new format only)    |
| `tool.execution_start`    | Tool call initiated                        |
| `tool.execution_complete` | Tool call finished                         |

### Session Discovery

`CopilotLogParser.discoverSessionLog()` uses **prompt content matching** (not most-recent-file heuristic) because multiple Copilot CLI sessions may run concurrently. The method:

1. Finds session logs modified after `startTime`
2. Reads first 10 events from each candidate
3. Matches `user.message.data.content` against first 100 chars of `promptText`
4. Returns the first matching log path

**Session ID Extraction:** Extracted from `session.start` event's `data.sessionId` field (replaces the old `--log-dir`/`--log-level debug` hack that parsed `process-*.log` files).

### Completion Detection

`CopilotLogParser` uses a stateful approach: buffers events per-turn and resolves when `assistant.turn_end` is found (new format) or via heuristic for old format.

---

## Codex CLI Log File Structure

### Directory Location

```
~/.codex/sessions/YYYY/MM/DD/
```

Example:

```
~/.codex/sessions/2026/01/19/
├── rollout-1737252891-abc123.jsonl
└── rollout-1737252940-def456.jsonl
```

### JSONL Event Types

| Event Type                                         | Description                           |
| -------------------------------------------------- | ------------------------------------- |
| `session_meta`                                     | Session metadata including session ID |
| `response_item`                                    | Response content (text, tool calls)   |
| `event_msg` with `payload.type = "turn.completed"` | **Completion signal**                 |
| `turn_context`                                     | Context window metadata               |

### Session Discovery

`CodexLogParser.discoverSessionLog()` walks the date-based directory hierarchy, filtering files modified after `startTime`, then matches `session_meta.sessionId` or prompt content.

### Completion Detection

`CodexLogParser.isComplete()` returns `true` when an `event_msg` event has `payload.type === "turn.completed"`.

---

## Session Discovery Strategy (All Providers)

FlightPath uses **prompt content matching** as the universal session discovery strategy:

1. Find log files modified after the CLI process started (`startTime`)
2. Read the first few events from each candidate
3. Match the user message content against the first 100 characters of `promptText`
4. Return the matching session's log path

**For Claude/Codex:** The `Start` hook also provides session IDs directly when available (faster path).

**Why not most-recent file?** Multiple CLI sessions may run concurrently. Matching on prompt content is robust to race conditions.

---

## Investigation Date

2026-01-18 (findings validated by implementation, January-February 2026)
