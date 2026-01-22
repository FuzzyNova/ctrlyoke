# Claude CLI Log File Structure

**Location:** `C:\Users\<username>\.claude\projects\<project-path>\<session-id>.jsonl`

**Format:** JSONL (JSON Lines) - One JSON object per line

This document describes the structure of all event types found in Claude CLI log files, based on real examples extracted from production logs.

---

## Table of Contents

1. [Session Events](#session-events)
2. [User Messages](#user-messages)
3. [Assistant Messages](#assistant-messages)
4. [Thinking Blocks](#thinking-blocks)
5. [Text Content](#text-content)
6. [Tool Use Events](#tool-use-events)
7. [Tool Result Events](#tool-result-events)
8. [File History Snapshots](#file-history-snapshots)
9. [Progress Events](#progress-events)
10. [System Events](#system-events)
11. [Summary Events](#summary-events)
12. [Queue Operation Events](#queue-operation-events)
13. [Token Usage](#token-usage)
14. [Field Reference](#field-reference)
15. [Notes and Observations](#notes-and-observations)

---

## Session Events

### Session Metadata (Common Fields)

All session events include these common fields:

```json
{
  "sessionId": "070f5ae3-61b7-49aa-a7a9-296be84ce30c",
  "version": "2.0.76",
  "gitBranch": "main",
  "cwd": "C:\\dev\\FlightPath",
  "userType": "external",
  "isSidechain": false
}
```

**Field Descriptions:**
- `sessionId` - Unique UUID for this Claude session
- `version` - Claude CLI version (e.g., "2.0.76", "2.1.12", "2.1.15")
- `gitBranch` - Current git branch (if in a git repository)
- `cwd` - Current working directory (absolute path)
- `userType` - Always "external" for CLI usage
- `isSidechain` - Boolean indicating if this is a sidechain conversation

---

## User Messages

User messages represent prompts sent to Claude.

### Structure

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "070f5ae3-61b7-49aa-a7a9-296be84ce30c",
  "version": "2.0.76",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "Follow instructions in @.flightpath\\temp\\1768795660-investigate-log-files-1.prompt.md "
  },
  "uuid": "2c9d635e-c3ac-41fa-b610-099d2b471b5a",
  "timestamp": "2026-01-19T04:07:45.273Z",
  "thinkingMetadata": {
    "level": "high",
    "disabled": false,
    "triggers": []
  },
  "todos": []
}
```

### Example 2 (with permissionMode)

```json
{
  "parentUuid": "3ba6377d-c3a5-4e46-9637-9d09c7a606f3",
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "ebe9243e-f833-4bb1-b543-4941c40c93f2",
  "version": "2.1.15",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "Follow instructions in @.flightpath\\temp\\1769038138-more-formatting-log-file-1.prompt.md "
  },
  "uuid": "05dabbd4-2fd5-4a27-8ad1-5e78f75e9fad",
  "timestamp": "2026-01-21T23:29:06.797Z",
  "thinkingMetadata": {
    "level": "high",
    "disabled": false,
    "triggers": []
  },
  "todos": [],
  "permissionMode": "acceptEdits"
}
```

**Field Descriptions:**
- `type` - Always "user" for user messages
- `message.role` - Always "user"
- `message.content` - The prompt text sent to Claude
- `uuid` - Unique identifier for this message
- `parentUuid` - UUID of parent message (null for first message)
- `timestamp` - ISO 8601 timestamp
- `thinkingMetadata` - Configuration for thinking behavior
  - `level` - Thinking level ("high", "normal", "low")
  - `disabled` - Whether thinking is disabled
  - `triggers` - Array of thinking triggers
- `todos` - Array of todo items (usually empty for user messages)
- `permissionMode` - Optional permission mode (e.g., "acceptEdits")

---

## Assistant Messages

Assistant messages contain Claude's responses.

### Example 1: Assistant Message with Thinking

```json
{
  "parentUuid": "2c9d635e-c3ac-41fa-b610-099d2b471b5a",
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "070f5ae3-61b7-49aa-a7a9-296be84ce30c",
  "version": "2.0.76",
  "gitBranch": "main",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "id": "msg_01P4yTR4JnqNg1eVBKGd4xSb",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user is asking me to follow instructions in a file they've provided. Let me read that file to understand what I need to do...",
        "signature": "Er0GCkYICxgCKkCeL6IhLSecYk5CWMuHZV+Rm0mMqdz4bwlysC+w56fjgclRkh9snZa0J1kxH3Jz..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 15009,
      "cache_read_input_tokens": 12834,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 15009,
        "ephemeral_1h_input_tokens": 0
      },
      "output_tokens": 8,
      "service_tier": "standard"
    }
  },
  "requestId": "req_011CWR1CzQMMmcup1dJuL6Mm",
  "type": "assistant",
  "uuid": "a9dc4882-0ad8-42a9-a8a7-0daa58c52adf",
  "timestamp": "2025-12-24T06:02:26.241Z"
}
```

### Example 2: Assistant Message with Text Content

```json
{
  "parentUuid": "a9dc4882-0ad8-42a9-a8a7-0daa58c52adf",
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "070f5ae3-61b7-49aa-a7a9-296be84ce30c",
  "version": "2.0.76",
  "gitBranch": "main",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "id": "msg_01P4yTR4JnqNg1eVBKGd4xSb",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "I've read the prompt file. It's asking me to call a tool called `flightpath_append_queue`..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 15009,
      "cache_read_input_tokens": 12834,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 15009,
        "ephemeral_1h_input_tokens": 0
      },
      "output_tokens": 857,
      "service_tier": "standard"
    }
  },
  "requestId": "req_011CWR1CzQMMmcup1dJuL6Mm",
  "type": "assistant",
  "uuid": "a71663fd-b2d8-4d44-9316-49ba4baf92dc",
  "timestamp": "2025-12-24T06:02:26.416Z"
}
```

**Field Descriptions:**
- `type` - Always "assistant" for assistant messages
- `message.role` - Always "assistant"
- `message.model` - Model used (e.g., "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929")
- `message.id` - Anthropic API message ID (format: "msg_...")
- `message.content` - Array of content blocks (see below)
- `message.stop_reason` - Reason for stopping (null if ongoing, "end_turn" when complete)
- `message.stop_sequence` - Stop sequence that triggered end (usually null)
- `message.usage` - Token usage statistics (see Token Usage section)
- `requestId` - Anthropic API request ID (format: "req_...")
- `uuid` - Unique identifier for this message event
- `timestamp` - ISO 8601 timestamp

---

## Content Blocks

Assistant messages contain an array of content blocks. Each block has a `type` field.

### Content Types

1. **thinking** - Claude's reasoning process
2. **text** - Regular text response
3. **tool_use** - Tool call/invocation
4. **tool_result** - Result from tool execution

---

## Thinking Blocks

Thinking blocks contain Claude's internal reasoning.

### Structure

```json
{
  "type": "thinking",
  "thinking": "The user wants me to investigate log files for Claude CLI...",
  "signature": "Er0GCkYICxgCKkCeL6IhLSecYk5CWMuHZV+Rm0mMqdz4bwlysC+w56fjgclRkh9s..."
}
```

**Field Descriptions:**
- `type` - Always "thinking"
- `thinking` - The thinking text (can be very long, often 1000+ characters)
- `signature` - Cryptographic signature (base64-encoded, very long string)

**Notes:**
- Thinking content can be multi-paragraph
- Signature is typically 2000-5000+ characters
- Thinking is only included if thinking mode is enabled

---

## Text Content

Text blocks contain Claude's regular text responses.

### Structure

```json
{
  "type": "text",
  "text": "I've read the prompt file. It's asking me to call a tool..."
}
```

**Field Descriptions:**
- `type` - Always "text"
- `text` - The response text (can contain markdown, code blocks, etc.)

**Notes:**
- Text can include markdown formatting
- Code blocks use triple backticks
- Can be split across multiple text blocks

---

## Tool Use Events

Tool use blocks represent calls to tools (Edit, Write, Read, Bash, etc.).

### Example 1: Read Tool Use

```json
{
  "type": "tool_use",
  "id": "toolu_01Awhb6mcH4aiTNWM2B1r5pQ",
  "name": "Read",
  "input": {
    "file_path": "c:\\dev\\FlightPath\\.flightpath\\temp\\1767475629-prompt-2.prompt.md"
  }
}
```

### Example 2: Read Tool Use with Pagination

```json
{
  "type": "tool_use",
  "id": "toolu_01PZEF4RcVf43pjMtUMsv4BM",
  "name": "Read",
  "input": {
    "file_path": "C:\\Users\\natha\\.claude\\projects\\C--dev-FlightPath\\0995b9fd-726e-47f7-b8d0-4b70ca60dbe5.jsonl",
    "offset": 0,
    "limit": 50
  }
}
```

### Example: Bash Tool Use

```json
{
  "type": "tool_use",
  "id": "toolu_016LWWDavEJe2ksCSc4hjdfx",
  "name": "Bash",
  "input": {
    "command": "head -50 \"C:\\Users\\natha\\.claude\\projects\\C--dev-FlightPath\\0995b9fd-726e-47f7-b8d0-4b70ca60dbe5.jsonl\"",
    "description": "Read first 50 lines of a large JSONL log file"
  }
}
```

### Example: Grep Tool Use

```json
{
  "type": "tool_use",
  "id": "toolu_01XYZ...",
  "name": "Grep",
  "input": {
    "pattern": "\"type\":\"user\"",
    "path": "C:\\Users\\natha\\.claude\\projects\\C--dev-FlightPath",
    "glob": "0995b9fd-726e-47f7-b8d0-4b70ca60dbe5.jsonl",
    "output_mode": "content",
    "head_limit": 3
  }
}
```

### Example: Edit Tool Use

```json
{
  "type": "tool_use",
  "id": "toolu_01ABC...",
  "name": "Edit",
  "input": {
    "file_path": "C:\\dev\\FlightPath\\src\\example.ts",
    "old_string": "const oldValue = 123;",
    "new_string": "const newValue = 456;"
  }
}
```

### Example: Write Tool Use

```json
{
  "type": "tool_use",
  "id": "toolu_01DEF...",
  "name": "Write",
  "input": {
    "file_path": "C:\\dev\\FlightPath\\docs\\new-file.md",
    "content": "# New Document\n\nContent goes here..."
  }
}
```

**Field Descriptions:**
- `type` - Always "tool_use"
- `id` - Unique tool call ID (format: "toolu_...")
- `name` - Tool name ("Read", "Write", "Edit", "Bash", "Grep", "Glob", etc.)
- `input` - Object containing tool parameters (varies by tool)

**Common Tools:**
- **Read** - Read file contents
  - `file_path` - Absolute path to file
  - `offset` - Optional line offset
  - `limit` - Optional line limit
- **Write** - Write/create file
  - `file_path` - Absolute path to file
  - `content` - File content
- **Edit** - Edit file in place
  - `file_path` - Absolute path to file
  - `old_string` - Text to replace
  - `new_string` - Replacement text
- **Bash** - Execute bash command
  - `command` - Command to execute
  - `description` - Human-readable description
  - `timeout` - Optional timeout in milliseconds
- **Grep** - Search file contents
  - `pattern` - Search pattern (regex)
  - `path` - Directory or file path
  - `glob` - Optional file glob pattern
  - `output_mode` - "content", "files_with_matches", or "count"
  - `head_limit` - Limit results
- **Glob** - Find files by pattern
  - `pattern` - Glob pattern (e.g., "*.ts")
  - `path` - Optional directory path

---

## Tool Result Events

Tool result blocks contain the output from executed tools.

### Example 1: Read Tool Result

```json
{
  "parentUuid": "35c59826-add2-41a2-b1ce-0e28a2e1216c",
  "isSidechain": false,
  "userType": "external",
  "cwd": "c:\\dev\\FlightPath",
  "sessionId": "091e7b3d-c283-4e05-bbaf-fc3c42d734c3",
  "version": "2.0.76",
  "gitBranch": "main",
  "slug": "synthetic-sniffing-wind",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01Awhb6mcH4aiTNWM2B1r5pQ",
        "type": "tool_result",
        "content": "     1→yeah, fix it.\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware...\n</system-reminder>\n"
      }
    ]
  },
  "uuid": "7313ce74-eda3-4b53-ba24-3b2bcc3cfdf0",
  "timestamp": "2026-01-03T21:27:17.570Z",
  "toolUseResult": {
    "type": "text",
    "file": {
      "filePath": "c:\\dev\\FlightPath\\.flightpath\\temp\\1767475629-prompt-2.prompt.md",
      "content": "yeah, fix it.",
      "numLines": 1,
      "startLine": 1,
      "totalLines": 1
    }
  }
}
```

**Field Descriptions:**
- `type` - "user" (tool results are sent as user messages)
- `message.role` - "user"
- `message.content[].type` - "tool_result"
- `message.content[].tool_use_id` - References the tool_use ID
- `message.content[].content` - Tool output (string or structured data)
- `toolUseResult` - Structured metadata about the result
  - `type` - Result type ("text", "error", etc.)
  - `file` - File metadata (for Read tool)
    - `filePath` - Path to file
    - `content` - File content
    - `numLines` - Number of lines read
    - `startLine` - Starting line number
    - `totalLines` - Total lines in file
- `slug` - Optional human-readable slug (e.g., "synthetic-sniffing-wind")

**Notes:**
- Tool results are sent as user messages (role: "user")
- Results reference the original tool_use via `tool_use_id`
- Content includes both raw output and structured metadata
- System reminders may be appended to content

---

## File History Snapshots

File history snapshots track file modifications during a session.

### Example 1: Empty Snapshot

```json
{
  "type": "file-history-snapshot",
  "messageId": "66c74717-41d2-4b78-93fb-047c7bdbe4fc",
  "snapshot": {
    "messageId": "66c74717-41d2-4b78-93fb-047c7bdbe4fc",
    "trackedFileBackups": {},
    "timestamp": "2026-01-21T23:29:06.099Z"
  },
  "isSnapshotUpdate": false
}
```

### Example 2: Snapshot with File Backups

```json
{
  "type": "file-history-snapshot",
  "messageId": "15dcfc92-8bbe-405b-958c-54950f2db922",
  "snapshot": {
    "messageId": "15dcfc92-8bbe-405b-958c-54950f2db922",
    "trackedFileBackups": {
      "src\\flightpath\\cli\\CliIntegration.ts": {
        "backupFileName": "c912590346f725e1@v1",
        "version": 1,
        "backupTime": "2026-01-17T17:38:06.177Z"
      },
      "src\\utils\\TuiStreamProcessor.ts": {
        "backupFileName": "206ea966999aeae4@v1",
        "version": 1,
        "backupTime": "2026-01-17T17:38:24.288Z"
      }
    },
    "timestamp": "2026-01-17T17:33:34.949Z"
  },
  "isSnapshotUpdate": false
}
```

**Field Descriptions:**
- `type` - Always "file-history-snapshot"
- `messageId` - Associated message UUID
- `snapshot.trackedFileBackups` - Object mapping file paths to backup info
  - Key: Relative file path (backslash-separated)
  - Value: Backup metadata
    - `backupFileName` - Backup file identifier or null
    - `version` - Version number (increments with each edit)
    - `backupTime` - ISO 8601 timestamp
- `snapshot.timestamp` - Snapshot creation time
- `isSnapshotUpdate` - Whether this updates an existing snapshot

**Notes:**
- Snapshots are created at message boundaries
- Files are tracked when edited via Edit or Write tools
- Backup files are stored in `.claude/projects/<project>/backups/`

---

## Progress Events

Progress events track hook execution and other background tasks.

### Example: Hook Progress Event

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "ebe9243e-f833-4bb1-b543-4941c40c93f2",
  "version": "2.1.15",
  "gitBranch": "main",
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:startup",
    "command": "node \"c:/dev/FlightPath/out/scripts/flightpath-claude-hook.js\" \"c:/dev/FlightPath/.flightpath/temp/claude-notifications\""
  },
  "parentToolUseID": "c9a45be4-ae3a-4e59-ba49-1c330288f883",
  "toolUseID": "c9a45be4-ae3a-4e59-ba49-1c330288f883",
  "timestamp": "2026-01-21T23:29:05.897Z",
  "uuid": "3ba6377d-c3a5-4e46-9637-9d09c7a606f3"
}
```

**Field Descriptions:**
- `type` - Always "progress"
- `data.type` - Progress type (e.g., "hook_progress")
- `data.hookEvent` - Hook event name ("SessionStart", "SessionStop")
- `data.hookName` - Full hook name (e.g., "SessionStart:startup")
- `data.command` - Command executed for the hook
- `parentToolUseID` - Parent tool use ID (may equal toolUseID)
- `toolUseID` - Associated tool use ID
- `timestamp` - ISO 8601 timestamp
- `uuid` - Unique identifier

**Hook Events:**
- **SessionStart** - Runs when session starts
- **SessionStop** - Runs when session ends/stops

---

## System Events

System events provide information about hook execution and other system-level activities.

### Example: Stop Hook Summary

```json
{
  "parentUuid": "a71663fd-b2d8-4d44-9316-49ba4baf92dc",
  "isSidechain": false,
  "userType": "external",
  "cwd": "C:\\dev\\FlightPath",
  "sessionId": "070f5ae3-61b7-49aa-a7a9-296be84ce30c",
  "version": "2.0.76",
  "gitBranch": "main",
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 1,
  "hookInfos": [
    {
      "command": "node \"c:/dev/FlightPath/out/scripts/flightpath-claude-stop-hook.js\" \"c:/dev/FlightPath/.flightpath/temp/claude-notifications\""
    }
  ],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": false,
  "level": "suggestion",
  "timestamp": "2025-12-24T06:02:26.541Z",
  "uuid": "9b8c6059-0780-4b75-8426-bf4b5271e985",
  "toolUseID": "54125eb2-61da-4272-ab2b-4c29b451a5ba"
}
```

**Field Descriptions:**
- `type` - Always "system"
- `subtype` - System event subtype (e.g., "stop_hook_summary")
- `hookCount` - Number of hooks executed
- `hookInfos` - Array of hook execution info
  - `command` - Command executed
- `hookErrors` - Array of errors (empty if successful)
- `preventedContinuation` - Whether hook prevented continuation
- `stopReason` - Reason for stopping (empty if normal)
- `hasOutput` - Whether hook produced output
- `level` - Event level ("suggestion", "info", "warning", "error")
- `timestamp` - ISO 8601 timestamp
- `uuid` - Unique identifier
- `toolUseID` - Associated tool use ID

---

## Summary Events

Summary events provide a brief summary of the conversation or action.

### Example

```json
{
  "type": "summary",
  "summary": "FlightPath Queue Tool Unavailable in Claude Code",
  "leafUuid": "a71663fd-b2d8-4d44-9316-49ba4baf92dc"
}
```

**Field Descriptions:**
- `type` - Always "summary"
- `summary` - Brief summary text (usually 1-10 words)
- `leafUuid` - UUID of the leaf message (final message in this branch)

**Notes:**
- Summaries are generated by Claude
- Used for conversation history and navigation
- Appears at the end of a conversation turn

---

## Queue Operation Events

Queue operation events track queue management operations (used by MCP tools).

### Example

```json
{
  "type": "queue-operation",
  "operation": "dequeue",
  "timestamp": "2026-01-03T21:27:12.440Z",
  "sessionId": "091e7b3d-c283-4e05-bbaf-fc3c42d734c3"
}
```

**Field Descriptions:**
- `type` - Always "queue-operation"
- `operation` - Operation type (e.g., "dequeue", "enqueue")
- `timestamp` - ISO 8601 timestamp
- `sessionId` - Session UUID

**Notes:**
- Used for tracking MCP tool queue operations
- Typically appears at the start of sessions
- May be logged by external tools (e.g., FlightPath)

---

## Token Usage

Token usage statistics are included in assistant messages.

### Structure

```json
{
  "usage": {
    "input_tokens": 10,
    "cache_creation_input_tokens": 15009,
    "cache_read_input_tokens": 12834,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 15009,
      "ephemeral_1h_input_tokens": 0
    },
    "output_tokens": 857,
    "service_tier": "standard"
  }
}
```

**Field Descriptions:**
- `input_tokens` - New input tokens (not cached)
- `cache_creation_input_tokens` - Tokens used to create cache
- `cache_read_input_tokens` - Tokens read from cache
- `cache_creation` - Cache creation breakdown
  - `ephemeral_5m_input_tokens` - Tokens in 5-minute cache
  - `ephemeral_1h_input_tokens` - Tokens in 1-hour cache
- `output_tokens` - Tokens in response
- `service_tier` - Service tier used ("standard")

**Notes:**
- Cache significantly reduces token costs
- Cache is shared within a session
- Input tokens = new + cache_creation + cache_read

---

## Field Reference

### Common Fields Across All Events

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Event type identifier |
| `uuid` | string | Unique identifier (UUID v4) |
| `timestamp` | string | ISO 8601 timestamp |
| `sessionId` | string | Session UUID |
| `version` | string | Claude CLI version |
| `parentUuid` | string \| null | Parent message UUID |

### Event Types

| Type | Description |
|------|-------------|
| `user` | User message/prompt |
| `assistant` | Assistant response |
| `file-history-snapshot` | File modification tracking |
| `progress` | Background task progress |
| `system` | System-level events |
| `summary` | Conversation summary |
| `queue-operation` | Queue management operations |

### Content Block Types

| Type | Description |
|------|-------------|
| `thinking` | Claude's reasoning process |
| `text` | Regular text response |
| `tool_use` | Tool call/invocation |
| `tool_result` | Tool execution result |

### Message Roles

| Role | Description |
|------|-------------|
| `user` | User prompt |
| `assistant` | Claude response |

---

## Notes and Observations

### Log File Naming

- Format: `<session-id>.jsonl` (e.g., `070f5ae3-61b7-49aa-a7a9-296be84ce30c.jsonl`)
- Session IDs are UUID v4
- One log file per session
- Files persist across VS Code restarts

### Session Continuity

- Session ID is consistent throughout conversation
- Session ID used for resuming conversations
- Log files allow full conversation replay

### File Paths

- Windows paths use backslashes in JSON strings
- Paths are absolute (e.g., `C:\\dev\\FlightPath`)
- Relative paths in backups use backslashes

### Versioning

- Version format: `major.minor.patch` (e.g., "2.0.76", "2.1.15")
- Version appears in every session event
- Helps identify CLI capabilities

### Stop Reasons

Assistant messages include a `stop_reason` field indicating why generation stopped:

- `null` - Generation ongoing (partial message)
- `"end_turn"` - Normal completion
- `"tool_use"` - Stopped to execute tools
- `"max_tokens"` - Reached token limit
- `"stop_sequence"` - Hit stop sequence

### Thinking Behavior

- Controlled by `thinkingMetadata` in user messages
- Levels: "high", "normal", "low"
- Can be disabled (`disabled: true`)
- Thinking signatures are very long (2000-5000+ chars)

### Sidechain Conversations

- Agent/subagent conversations marked with `isSidechain: true`
- Agent conversations include `agentId` field (e.g., "a4f1822")
- Agent log files named `agent-<agentId>.jsonl`
- Sidechain sessions can have different `sessionId` than parent

### Message Streaming

**Important:** Assistant messages are logged incrementally as they stream:

1. **First message** (thinking block) - Contains thinking content with `stop_reason: null`
2. **Second message** (same message ID) - Contains full response with complete content
3. Multiple events with same `message.id` represent streaming updates
4. **Final event** has `stop_reason: "end_turn"` or `"tool_use"`

**Example sequence:**
- Event 1: `msg_01ABC...` with thinking block, `stop_reason: null`
- Event 2: `msg_01ABC...` with text content, `stop_reason: "end_turn"`

**Key points:**
- Same `parentUuid` and `message.id` for all streaming chunks
- Different `uuid` for each log event
- Token usage appears in each event (may be incremental)
- Final event contains complete message with all content blocks

### Tool Execution

- Tools are invoked via `tool_use` content blocks
- Tool results appear in separate `tool_result` blocks (not shown in examples above)
- Tool IDs format: `toolu_<base58-like-string>`
- Tools can fail (permission denied, errors)

### Hooks

- SessionStart hooks run before first message
- SessionStop hooks run after conversation ends
- Hooks can execute custom scripts
- Hook execution logged in progress events

### Caching

- Prompt caching significantly reduces costs
- Cache types: 5-minute ephemeral, 1-hour ephemeral
- Cache is session-specific
- Cache usage shown in token statistics

---

## Parsing Strategies

### For Real-time Streaming

When monitoring log files during active sessions:

1. **Watch for new lines** - Use file watching or tailing
2. **Parse incrementally** - Each line is valid JSON
3. **Track message.id** - Group streaming chunks by message ID
4. **Wait for stop_reason** - Message complete when not null
5. **Handle duplicates** - Same message.id may appear multiple times

### For Session Resumption

To resume a previous session:

1. **Read entire log file** - Parse all JSONL lines
2. **Find sessionId** - Extract from any event
3. **Reconstruct conversation** - Build thread using `parentUuid` links
4. **Get last state** - Last assistant message shows conversation state
5. **Extract tool results** - Replay tool execution history

### For Response Detection

To detect when Claude has finished responding:

```typescript
// Pseudocode for completion detection
const events = parseJsonlFile(logPath);
const assistantMessages = events.filter(e => e.type === 'assistant');
const lastMessage = assistantMessages[assistantMessages.length - 1];

if (lastMessage?.message?.stop_reason === 'end_turn') {
  // Response complete
  const finalText = lastMessage.message.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}
```

### For Token Tracking

```typescript
// Calculate total tokens used
const assistantMessages = events.filter(e => e.type === 'assistant');
const totalTokens = assistantMessages.reduce((sum, msg) => {
  const usage = msg.message?.usage;
  return sum + (usage?.output_tokens || 0);
}, 0);
```

### Key Parsing Patterns

1. **Filter by type** - `events.filter(e => e.type === 'assistant')`
2. **Group by message ID** - Group streaming chunks
3. **Follow parent chain** - Use `parentUuid` to rebuild conversation
4. **Check stop_reason** - Determine completion state
5. **Extract content blocks** - Different types need different handling

---

## Conclusion

Claude CLI log files provide a complete, structured record of all interactions, including:

- User prompts and assistant responses
- Tool calls and results
- File modifications and backups
- Token usage and caching statistics
- Hook execution and system events
- Conversation summaries

This JSONL format enables:

- **Session resumption** - Continue conversations across restarts
- **Debugging** - Full audit trail of all actions
- **Cost tracking** - Token usage per request
- **File recovery** - Backup tracking for all edits
- **Hook monitoring** - Track custom script execution
- **Real-time streaming** - Monitor active conversations
- **External integration** - Parse and process programmatically

The structure is stable and well-defined, making it suitable for programmatic parsing and integration with external tools like FlightPath.

### FlightPath Integration

For FlightPath's Claude CLI integration, the log file provides:

1. **Response completion detection** - Monitor `stop_reason` field
2. **Session ID tracking** - Extract from first event for resumption
3. **Token usage stats** - Display to user after each prompt
4. **Tool execution monitoring** - Track all tool calls and results
5. **Error detection** - Check for tool failures or system errors

**Recommended approach:**
- Use log file for completion detection (reliable)
- Parse incrementally during active sessions
- Extract session ID on first run
- Track `stop_reason` to detect end of response
- Display token usage from final assistant message
