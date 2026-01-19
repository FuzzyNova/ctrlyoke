# CLI Log Files: Cross-Provider Investigation and Analysis

## Executive Summary

This document investigates chat log files for **all three CLI providers** (Claude Code, GitHub Copilot, and OpenAI Codex) as an alternative to TUI screen parsing for response streaming. The investigation reveals that **all three CLIs maintain structured JSONL logs** with clean, parseable JSON objects.

**Key Finding:** All three CLI providers maintain JSONL log files that eliminate the complexity of TUI parsing, ANSI code stripping, and screen deduplication. While each provider uses a different event structure, the fundamental approach is the same - structured JSON events in line-delimited format.

**Critical Implication:** Since all three providers support JSONL logs, FlightPath can **completely remove the complex TUI parsing logic** (~1000 lines) and replace it with a unified JSONL-based approach (~100-200 lines per provider).

## Investigation Date

2026-01-18

## Quick Reference: Log File Locations

| Provider | Log Directory | File Naming | Index File |
|----------|--------------|-------------|------------|
| **Claude** | `~/.claude/projects/<project-path>/` | `<session-id>.jsonl` | `sessions-index.json` |
| **Copilot** | `~/.copilot/session-state/` | **Old:** `<session-id>.jsonl`<br>**New (v0.0.384+):** `<session-id>/events.jsonl` | `history-session-state/session_*.json` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-<timestamp>-<session-id>.jsonl` | None (date-based organization) |

**⚠️ Note:** Copilot changed log format in version 0.0.384 (mid-January 2026). FlightPath must support both old and new formats.

## Claude CLI Log File Structure

### Directory Location

```
C:\Users\<username>\.claude\projects\<project-path>\
```

Example for FlightPath project:
```
C:\Users\natha\.claude\projects\C--dev-FlightPath\
```

### File Organization

**Session Files:**
- One `.jsonl` file per session: `<session-id>.jsonl`
- One directory per session (for subagents): `<session-id>/`
- Agent sessions: `agent-<short-id>.jsonl`

**Index File:**
- `sessions-index.json` - Master index of all sessions with metadata

**Example Directory Contents:**
```
0052ba5f-5354-48cd-bede-558c1258090b.jsonl
0052ba5f-5354-48cd-bede-558c1258090b/
  └── subagents/
agent-afe734d.jsonl
agent-a00a438.jsonl
sessions-index.json
```

## Sessions Index Format

The `sessions-index.json` file tracks metadata for all sessions:

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "0052ba5f-5354-48cd-bede-558c1258090b",
      "fullPath": "C:\\Users\\natha\\.claude\\projects\\c--dev-FlightPath\\0052ba5f-5354-48cd-bede-558c1258090b.jsonl",
      "fileMtime": 1768152401858,
      "firstPrompt": "Follow instructions in @.flightpath\\temp\\1768152190-let-s-make-a-plan-for-20260111-112310-1.prompt.md",
      "messageCount": 6,
      "created": "2026-01-11T17:23:14.658Z",
      "modified": "2026-01-11T17:26:41.818Z",
      "gitBranch": "main",
      "projectPath": "c:\\dev\\FlightPath",
      "isSidechain": false
    }
  ]
}
```

**Key Fields:**
- `sessionId` - Unique session identifier (UUID)
- `fullPath` - Absolute path to the JSONL file
- `fileMtime` - File modification timestamp (for tracking updates)
- `firstPrompt` - First message in the session (useful for session identification)
- `messageCount` - Total number of messages in the session
- `created` / `modified` - Session timestamps
- `gitBranch` - Git branch when session was created
- `projectPath` - Workspace directory
- `isSidechain` - Whether this is a subagent/task session

## JSONL File Format

Each session file (`<session-id>.jsonl`) contains one JSON object per line. Each line represents an event in the conversation.

### Event Types

**1. Queue Operations** (FlightPath-specific):
```json
{
  "type": "queue-operation",
  "operation": "dequeue",
  "timestamp": "2026-01-11T17:23:12.790Z",
  "sessionId": "0052ba5f-5354-48cd-bede-558c1258090b"
}
```

**2. User Messages:**
```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "c:\\dev\\FlightPath",
  "sessionId": "0052ba5f-5354-48cd-bede-558c1258090b",
  "version": "2.1.3",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": "Follow instructions in @.flightpath\\temp\\1768152190-let-s-make-a-plan-for-20260111-112310-1.prompt.md "
  },
  "uuid": "64f2143e-5972-46c3-baa2-0dbf3837c636",
  "timestamp": "2026-01-11T17:23:14.658Z"
}
```

**3. Assistant Messages:**
```json
{
  "parentUuid": "64f2143e-5972-46c3-baa2-0dbf3837c636",
  "isSidechain": false,
  "userType": "external",
  "cwd": "c:\\dev\\FlightPath",
  "sessionId": "0052ba5f-5354-48cd-bede-558c1258090b",
  "version": "2.1.3",
  "gitBranch": "main",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_017cqnrzJcDP1PGBxKSQPjJB",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "I'll help you create a comprehensive plan..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 42999,
      "cache_read_input_tokens": 13178,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 42999,
        "ephemeral_1h_input_tokens": 0
      },
      "output_tokens": 1,
      "service_tier": "standard"
    }
  },
  "requestId": "req_011CX1yhRPCEuhWTsRbWm2ig",
  "type": "assistant",
  "uuid": "9ead3a51-7c00-46a6-ab2a-40b8ce384876",
  "timestamp": "2026-01-11T17:23:18.702Z"
}
```

### Message Structure Details

**Metadata Fields (Common to All Events):**
- `type` - Event type: "user", "assistant", "queue-operation"
- `uuid` - Unique identifier for this message
- `parentUuid` - UUID of the message this is responding to (null for user prompts)
- `timestamp` - ISO 8601 timestamp
- `sessionId` - Session identifier
- `version` - Claude CLI version
- `gitBranch` - Git branch at time of message
- `cwd` - Working directory
- `userType` - "external" for human users
- `isSidechain` - true for agent/task sessions
- `agentId` - Present for agent sessions (e.g., "afe734d")

**Message Content (message field):**
- `role` - "user" or "assistant"
- `content` - String (user) or Array of content blocks (assistant)
  - Content block types: "text", "thinking", "tool_use", "tool_result"
- `model` - Model identifier (assistant only)
- `id` - Message ID from API (assistant only)
- `stop_reason` - Why generation stopped (assistant only)
- `usage` - Token counts and costs (assistant only)

**Usage Statistics (assistant messages):**
```json
"usage": {
  "input_tokens": 3,
  "cache_creation_input_tokens": 42999,
  "cache_read_input_tokens": 13178,
  "cache_creation": {
    "ephemeral_5m_input_tokens": 42999,
    "ephemeral_1h_input_tokens": 0
  },
  "output_tokens": 1,
  "service_tier": "standard"
}
```

## Copilot CLI Log File Structure

### Directory Location

```
C:\Users\<username>\.copilot\session-state\
```

### File Organization

**⚠️ IMPORTANT: Copilot changed their log format around version 0.0.384 (mid-January 2026)**

**Old Format (pre-v0.0.384):**
- One `.jsonl` file per session in root directory: `<session-id>.jsonl`
- No subdirectories

**New Format (v0.0.384+, current as of Jan 18, 2026):**
- One subdirectory per session: `<session-id>/`
- Log file inside subdirectory: `<session-id>/events.jsonl`

**History Files (both formats):**
- `history-session-state/session_<session-id>_<timestamp>.json` - Session metadata

**Example Directory Contents (Mixed Old/New):**
```
session-state/
├── ff5d67ac-6252-496a-a8e1-0c739361f6b2.jsonl          # Old format (flat file)
├── 00332a51-da0c-46d4-8c12-95b83c54c50d.jsonl          # Old format (flat file)
├── 6e2ec013-11bd-4862-ab32-c5b4d5a71131/                # New format (directory)
│   └── events.jsonl
├── d6d35cc1-fc0f-4b64-ad86-1ce3534a124d/                # New format (directory)
│   └── events.jsonl
└── ...

history-session-state/
├── session_002e2767-a77a-4f44-b64f-d0609f97e5bd_1758948483055.json
└── ...
```

**FlightPath Implication:** Parser must support **both formats** for backward compatibility. Check for subdirectory first, fall back to flat file.

### JSONL Event Format

Copilot uses a **type-based event system** with granular event types for every action.

**Event Types (New Format - v0.0.384+):**
- `session.start` - Session initialization
- `session.info` - Session info (authentication, MCP connections)
- `session.model_change` - Model selection
- `user.message` - User prompts
- `assistant.turn_start` - Turn begins
- `assistant.turn_end` - Turn completes
- `session.truncation` - Context window management
- `assistant.message` - Assistant text responses
- `tool.execution_start` - Tool call initiated
- `tool.execution_complete` - Tool call finished (new!)
- `tool.execution_result` - Tool call result (deprecated in new format)

**Event Types (Old Format - pre-v0.0.384):**
- Same as above but without `session.info`, `assistant.turn_end`, and `tool.execution_complete`

**Sample Session Start (New Format):**
```json
{
  "type": "session.start",
  "data": {
    "sessionId": "6e2ec013-11bd-4862-ab32-c5b4d5a71131",
    "version": 1,
    "producer": "copilot-agent",
    "copilotVersion": "0.0.384",
    "startTime": "2026-01-19T01:36:05.196Z",
    "selectedModel": "gpt-5-mini"
  },
  "id": "fe8205a9-d2d4-4f5b-8ced-6ee7da13efe1",
  "timestamp": "2026-01-19T01:36:05.198Z",
  "parentId": null
}
```

**Sample Session Info (New in v0.0.384+):**
```json
{
  "type": "session.info",
  "data": {
    "infoType": "authentication",
    "message": "Logged in as user: nhickster"
  },
  "id": "68b68c70-c812-4e8e-b9ce-74789cfb69b1",
  "timestamp": "2026-01-19T01:36:05.576Z",
  "parentId": "fe8205a9-d2d4-4f5b-8ced-6ee7da13efe1"
}
```

```json
{
  "type": "session.info",
  "data": {
    "infoType": "mcp",
    "message": "Connected to GitHub MCP Server"
  },
  "id": "7496c579-576c-4d10-9d7b-903ada71ae41",
  "timestamp": "2026-01-19T01:36:06.330Z",
  "parentId": "68b68c70-c812-4e8e-b9ce-74789cfb69b1"
}
```

**Sample User Message (Enhanced in New Format):**
```json
{
  "type": "user.message",
  "data": {
    "content": "Follow instructions in @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md",
    "transformedContent": "<current_datetime>2026-01-19T01:36:08.274Z</current_datetime>\n\nFollow instructions...",
    "attachments": [{
      "type": "file",
      "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md",
      "displayName": "@.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md",
      "mentionIndex": 23
    }]
  },
  "id": "d919f62c-60dc-42ad-ad6e-d019b10e613b",
  "timestamp": "2026-01-19T01:36:08.274Z",
  "parentId": "64c42b68-66b7-4680-bc9c-4068786746dc"
}
```

**Sample Assistant Message:**
```json
{
  "type": "assistant.message",
  "data": {
    "messageId": "78be95a8-5cd1-486b-96a0-a5aea2bfb5ff",
    "content": "Opening the specified prompt file...",
    "toolRequests": []
  },
  "id": "14b05241-3d9e-4abd-8609-6fa6de99f89a",
  "timestamp": "2026-01-10T20:07:20.325Z",
  "parentId": "b1a7d67f-e60a-4e74-be21-ff5008463b0e"
}
```

**Sample Tool Call:**
```json
{
  "type": "assistant.message",
  "data": {
    "messageId": "a4684eb8-2be3-4ba2-9627-f005baccbd27",
    "content": "",
    "toolRequests": [{
      "toolCallId": "call_QHzc9P78VBl2CuDfGdOZ2sgU",
      "name": "view",
      "arguments": {
        "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md"
      }
    }]
  },
  "id": "608dfaf8-df71-4bcb-864c-2a2fc8824276",
  "timestamp": "2026-01-19T01:36:19.566Z",
  "parentId": "161e520b-3784-4b97-a87a-c988abedaf4a"
}
```

**Sample Tool Execution Complete (New in v0.0.384+):**
```json
{
  "type": "tool.execution_complete",
  "data": {
    "toolCallId": "call_QHzc9P78VBl2CuDfGdOZ2sgU",
    "success": true,
    "result": {
      "content": "File too large to read at once (57.9 KB)..."
    },
    "toolTelemetry": {
      "properties": {
        "command": "view",
        "fileExtension": ".md",
        "viewType": "file",
        "largeOutputAvoided": "true"
      },
      "metrics": {
        "resultLength": 220,
        "responseTokenLimit": 32000
      }
    }
  },
  "id": "0c307cba-71ac-4b62-84df-ddd85ff64add",
  "timestamp": "2026-01-19T01:36:19.569Z",
  "parentId": "d9c93718-6515-41b3-b679-353be9f76e63"
}
```

**Sample Assistant Turn End (New in v0.0.384+):**
```json
{
  "type": "assistant.turn_end",
  "data": {
    "turnId": "1"
  },
  "id": "068b8efb-78b7-4a02-8348-2d5efe6c6816",
  "timestamp": "2026-01-19T01:36:19.569Z",
  "parentId": "1a30008e-56ae-4ba1-9a45-d2fd709fabed"
}
```

### Key Features

**Metadata Fields:**
- `type` - Event type (hierarchical: category.action)
- `id` - Unique event identifier (UUID)
- `parentId` - Parent event ID (forms event chain)
- `timestamp` - ISO 8601 timestamp
- `data` - Event-specific payload

**Advantages:**
- **Granular events**: Separate events for each action (turn start, truncation, etc.)
- **Event chains**: `parentId` links events into conversation flow
- **Tool tracking**: Full tool execution lifecycle (start → complete) with telemetry
- **Session metadata**: Version, producer, model selection, authentication, MCP connections
- **Explicit turn boundaries**: `assistant.turn_start` and `assistant.turn_end` events (new format)
- **Enhanced attachments**: File attachments with full metadata (path, displayName, mentionIndex)

**Challenges:**
- **Multi-event responses**: Assistant responses split across multiple events
- **Reconstruction needed**: Must aggregate events to get full response
- **No built-in session index**: Must scan directory for session discovery
- **Format migration**: Must support both old (flat file) and new (subdirectory) formats
- **Completion detection complexity**: More sophisticated in new format with explicit turn boundaries

## Codex CLI Log File Structure

### Directory Location

```
C:\Users\<username>\.codex\sessions\YYYY\MM\DD\
```

Example:
```
C:\Users\natha\.codex\sessions\2026\01\17\
```

### File Organization

**Date-Based Hierarchy:**
- Sessions organized by year/month/day directories
- No session index file (use directory structure for discovery)

**File Naming:**
```
rollout-<timestamp>-<session-id>.jsonl
```

Example:
```
rollout-2026-01-17T15-47-25-019bcded-64fd-7b21-b80b-be2a50ec8767.jsonl
```

**Example Directory Structure:**
```
.codex/sessions/
├── 2025/
│   └── 12/
│       └── 30/
│           └── rollout-2025-12-30T10-15-30-<session-id>.jsonl
└── 2026/
    └── 01/
        ├── 01/
        ├── 04/
        └── 17/
            ├── rollout-2026-01-17T10-36-57-019bccd1-249e-77b3-bac1-89238b4647c7.jsonl
            └── rollout-2026-01-17T15-47-25-019bcded-64fd-7b21-b80b-be2a50ec8767.jsonl
```

### JSONL Event Format

Codex uses a **payload-based event system** with comprehensive session metadata.

**Event Types:**
- `session_meta` - Session initialization with full context
- `response_item` - Individual response items (user/assistant messages, permissions, environment)
- `event_msg` - System events (user_message, token_count, turn.completed)
- `turn_context` - Turn configuration (approval_policy, sandbox_policy, model)
- `reasoning` - Internal reasoning blocks (encrypted)

**Sample Session Metadata:**
```json
{
  "timestamp": "2026-01-17T21:47:25.875Z",
  "type": "session_meta",
  "payload": {
    "id": "019bcded-64fd-7b21-b80b-be2a50ec8767",
    "timestamp": "2026-01-17T21:47:25.821Z",
    "cwd": "C:\\dev\\FlightPath",
    "originator": "codex_cli_rs",
    "cli_version": "0.87.0",
    "instructions": "Always read the main project instructions...",
    "source": "cli",
    "model_provider": "openai",
    "git": {
      "commit_hash": "6d2a783eeea0fc082bd4cac66818aab83ac40fdc",
      "branch": "main",
      "repository_url": "https://github.com/nhickster/flightpath.git"
    }
  }
}
```

**Sample User Message:**
```json
{
  "timestamp": "2026-01-17T21:47:27.672Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [{
      "type": "input_text",
      "text": "Follow instructions in .flightpath\\temp\\1768686441-wow-looks-like-2-things-1.prompt.md"
    }]
  }
}
```

**Sample Turn Context:**
```json
{
  "timestamp": "2026-01-17T21:47:27.672Z",
  "type": "turn_context",
  "payload": {
    "cwd": "C:\\dev\\FlightPath",
    "approval_policy": "on-request",
    "sandbox_policy": {
      "type": "workspace-write",
      "writable_roots": ["c:\\dev\\FlightPath"],
      "network_access": false
    },
    "model": "gpt-5.2-codex",
    "effort": "medium",
    "summary": "auto",
    "user_instructions": "...",
    "truncation_policy": {
      "mode": "tokens",
      "limit": 10000
    }
  }
}
```

**Sample Tool Call:**
```json
{
  "timestamp": "2026-01-17T21:47:29.906Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "shell_command",
    "arguments": "{\"command\":\"Get-Content -Path .flightpath\\\\temp\\\\1768686441-wow-looks-like-2-things-1.prompt.md\"}",
    "call_id": "call_Q0mtPu3Ec90Fqm8k1CulZY6q"
  }
}
```

**Sample Reasoning Block:**
```json
{
  "timestamp": "2026-01-17T21:47:29.494Z",
  "type": "response_item",
  "payload": {
    "type": "reasoning",
    "summary": [],
    "content": null,
    "encrypted_content": "gAAAAABpbANyGJEH3ezksCKCbQ7Uldz-MNKrIOdM5iM98b4SUjT8jpYIijka..."
  }
}
```

**Sample Event Messages:**
```json
{
  "timestamp": "2026-01-17T21:47:27.672Z",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "message": "Follow instructions in .flightpath\\temp\\1768686441-wow-looks-like-2-things-1.prompt.md",
    "images": [],
    "local_images": [],
    "text_elements": []
  }
}
```

```json
{
  "timestamp": "2026-01-17T21:47:28.550Z",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": null,
    "rate_limits": {
      "primary": null,
      "secondary": null,
      "credits": null,
      "plan_type": null
    }
  }
}
```

### Key Features

**Metadata Fields:**
- `timestamp` - ISO 8601 timestamp
- `type` - Top-level event type
- `payload` - Event data with nested structure
  - `type` - Payload type (for response_item and event_msg)
  - Provider-specific fields

**Advantages:**
- **Rich context**: Full session metadata including git info, approval policies, sandbox settings
- **Reasoning blocks**: Internal reasoning captured (encrypted for now)
- **Date-based organization**: Easy to find sessions by date
- **Turn context**: Detailed configuration per turn (model, effort, truncation)
- **Permission tracking**: Sandbox and approval policies logged
- **Environment capture**: Working directory, shell, instructions

**Challenges:**
- **No session index**: Must traverse directory tree to discover sessions
- **Nested payloads**: Two-level type system (event type + payload type)
- **Encrypted reasoning**: Reasoning blocks not immediately readable
- **Completion detection**: Must watch for specific event types (turn.completed, etc.)

## Cross-Provider Comparison

### Log File Organization

| Provider | Organization | Session Discovery | Subagents | Format Changes |
|----------|--------------|------------------|-----------|----------------|
| **Claude** | Project-based | sessions-index.json | Subdirectories | Stable |
| **Copilot** | Flat directory (old)<br>Session subdirs (new) | history-session-state/*.json | Not tracked | **Changed v0.0.384** (Jan 2026) |
| **Codex** | Date hierarchy (YYYY/MM/DD) | Directory traversal | Not tracked | Stable |

### Event Structure

| Provider | Event Model | Response Assembly | Metadata Richness |
|----------|-------------|------------------|------------------|
| **Claude** | Simple (user/assistant) | Single event per message | Medium (tokens, model, stop_reason) |
| **Copilot** | Granular (type.action) | Multi-event aggregation | High (truncation, turn tracking) |
| **Codex** | Nested payloads | Multi-event aggregation | Very High (git, sandbox, reasoning) |

### Key Events for Response Streaming

| Event | Claude | Copilot | Codex |
|-------|--------|---------|-------|
| **Session Start** | `type: "user"` (first) | `type: "session.start"` | `type: "session_meta"` |
| **User Prompt** | `type: "user"` | `type: "user.message"` | `type: "event_msg"` (payload.type: "user_message") |
| **Assistant Text** | `type: "assistant"` | `type: "assistant.message"` | `type: "response_item"` (payload.type: "message", role: "assistant") |
| **Tool Call** | `content[].type: "tool_use"` | `toolRequests[]` | `type: "response_item"` (payload.type: "function_call") |
| **Thinking** | `content[].type: "thinking"` | Not tracked | `type: "response_item"` (payload.type: "reasoning") |
| **Completion** | `stop_reason !== null` | Custom (last event) | `type: "event_msg"` (payload.type: "turn.completed") |
| **Token Counts** | `usage` object | `type: "event_msg"` (payload.type: "token_count") | `type: "event_msg"` (payload.type: "token_count") |

### Parsing Complexity

| Aspect | Claude | Copilot | Codex |
|--------|--------|---------|-------|
| **Event Parsing** | Simple | Medium (event aggregation) | Medium (nested payloads) |
| **Session Discovery** | Easy (index file) | Medium (history files, **check subdirs first**) | Hard (directory traversal) |
| **Response Extraction** | Easy (single event) | Medium (multi-event) | Medium (multi-event) |
| **Tool Call Tracking** | Easy (content blocks) | Easy (toolRequests array) | Easy (function_call type) |
| **Metadata Extraction** | Easy (top-level fields) | Medium (event-specific) | Easy (session_meta, turn_context) |
| **Format Versioning** | Stable | **Two formats** (old/new) | Stable |
| **Completion Detection** | Simple (stop_reason) | **Complex** (assistant.turn_end in new, heuristic in old) | Simple (turn.completed event) |

## Current TUI Parsing Approach (FlightPath)

FlightPath currently uses `TuiStreamProcessor.ts` to parse Claude CLI output by reading the terminal TUI directly.

### Current Implementation Overview

**File:** `src/utils/TuiStreamProcessor.ts` (997 lines)

**Key Responsibilities:**
1. Stream TUI output from `TerminalShellExecution.read()`
2. Strip ANSI escape codes and terminal control sequences
3. Detect TUI readiness (first complete screen)
4. Parse TUI screens from buffer using regex patterns
5. Extract new content deltas (deduplication via line occurrence counting)
6. Filter TUI chrome (status bars, spinners, escape indicators)
7. Detect completion (escape indicator disappearing for 2+ consecutive screens)
8. Handle CLI errors in output
9. Support two modes: screen-based (Claude/Copilot) vs time-based (Codex)

### Current Parsing Challenges

**1. ANSI Code Stripping (lines 709-724):**
```typescript
stripAnsiCodes(text: string): string {
  return text
    // OSC sequences
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
    // CSI sequences
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
    // Other escape sequences
    .replace(/\x1B[@-Z\\-_]/g, "")
    // Standalone BEL character
    .replace(/\x07/g, "")
    // Zero-width characters
    .replace(/[\u200B-\u200F]/g, "");
}
```

**2. Screen Parsing (lines 511-537):**
- Uses CLI-specific regex patterns to detect screen boundaries
- Must extract complete screens from partial buffer chunks
- Requires CLI-specific configuration (escapeIndicator, screenEndPattern)

**3. Content Deduplication (lines 556-677):**
- Tracks line occurrence counts between screens
- Handles progressive updates where annotations get added
- Complex logic to prevent duplicate output while preserving new content
- Must collapse excessive blank lines (max 2 consecutive)

**4. TUI Chrome Filtering (lines 691-702):**
- Filters status indicators like "(Esc to cancel)"
- Removes spinner-only lines and pure UI chrome
- Uses CLI-specific patterns from each integration

**5. Completion Detection (lines 381-407):**
- Watches for escape indicator appearing (CLI generating)
- Waits for indicator to disappear for 2+ consecutive screens
- Requires careful state tracking across chunks

**6. Error Detection (lines 734-793):**
- Distinguishes real errors from pasted prompt content
- Checks for TUI chrome before/after error patterns
- Extracts error messages with stack traces

### Current Implementation Complexity

**Complexity Metrics:**
- **Total lines:** 997
- **Complex methods:**
  - `processStream()` - 394 lines (main processing loop)
  - `extractNewContent()` - 121 lines (delta extraction)
  - `stripAnsiCodes()` - 16 lines (regex replacements)
  - `detectCliError()` - 41 lines (error detection)
  - `deduplicateContent()` - 86 lines (deduplication)
  - `extractScreensFromBuffer()` - 27 lines (screen parsing)

**State Management:**
- Multiple boolean flags (tuiReady, promptTextSent, promptSubmitted, completed, errorDetected, fileEchoDetected, indicatorEverSeen)
- Line occurrence counting maps (lastEmittedContent)
- Screen buffers and echo buffers
- Consecutive blank line counters
- Recent lines buffer (Set with 100-line limit)

**Configuration Complexity:**
```typescript
export interface TuiStreamConfig {
  useTimeBasedExtraction?: boolean;
  escapeIndicator: string;
  screenEndPattern: RegExp;
  tuiChromePatterns: RegExp[];
  streamingEmitter: vscode.EventEmitter<string>;
  responseCompleteEmitter: vscode.EventEmitter<string>;
  fileSilenceMs?: number;
  maxConsecutiveBlankLines?: number;
}
```

## Comparison: TUI Parsing vs JSONL Log Files (All Providers)

### Data Quality

| Aspect | TUI Parsing | JSONL Log Files (All 3 Providers) |
|--------|-------------|-----------------------------------|
| **Structured Data** | ❌ Unstructured text | ✅ Clean JSON objects |
| **ANSI Codes** | ❌ Must strip manually | ✅ No ANSI codes |
| **TUI Chrome** | ❌ Must filter status bars, spinners | ✅ No TUI chrome |
| **Content Format** | ❌ Plain text with markdown | ✅ Typed content blocks (text, thinking, tool_use) |
| **Metadata** | ❌ Not available | ✅ Full metadata (model, tokens, timestamps, UUIDs) |
| **Tool Calls** | ❌ Embedded in text | ✅ Structured objects (all providers) |
| **Token Counts** | ❌ Must parse from statistics string | ✅ Structured usage/event objects |
| **Session ID** | ⚠️ Must parse from logs | ✅ In session metadata (all providers) |
| **Reasoning** | ❌ Not captured | ✅ Available (Claude thinking blocks, Codex encrypted reasoning) |

### Implementation Complexity

| Aspect | TUI Parsing | JSONL Log Files |
|--------|-------------|-----------------|
| **Lines of Code** | ❌ ~1000 lines (shared) | ✅ ~100-200 lines per provider |
| **Parsing Logic** | ❌ Complex regex, state machines | ✅ Simple line-by-line JSON.parse() |
| **Deduplication** | ❌ Manual line occurrence counting | ✅ Not needed (each line is unique event) |
| **Screen Parsing** | ❌ Complex buffer management | ✅ Not needed (line-delimited) |
| **Error Handling** | ❌ Must distinguish errors from content | ✅ Structured error/event objects |
| **Provider Differences** | ❌ 3 different TUI formats (shared processor) | ✅ 3 different event schemas (separate parsers) |
| **Code Reuse** | ⚠️ Some shared TUI logic, provider-specific patterns | ✅ Shared log monitoring, provider-specific event parsing |

### Reliability

| Aspect | TUI Parsing | JSONL Log Files |
|--------|-------------|-----------------|
| **Breaking Changes** | ❌ TUI UI changes break parsing | ✅ Stable format (versioned) |
| **Race Conditions** | ⚠️ Buffer timing issues | ✅ File system provides ordering |
| **Partial Reads** | ❌ Must handle incomplete screens | ✅ Complete JSON objects per line |
| **Error Recovery** | ❌ Complex state recovery | ✅ Simply continue from next line |

### Features

| Aspect | TUI Parsing | JSONL Log Files |
|--------|-------------|-----------------|
| **Real-time Streaming** | ✅ Yes (via terminal read) | ✅ Yes (via file watching) |
| **Historical Access** | ❌ Lost after stream ends | ✅ Persistent history |
| **Thinking Blocks** | ⚠️ Embedded in text | ✅ Separate content block type |
| **Tool Call Details** | ❌ Text summary only | ✅ Full tool name and input parameters |
| **Multi-turn Context** | ❌ Only current response | ✅ Full conversation history |
| **Subagent Tracking** | ❌ Not available | ✅ isSidechain, agentId fields |

### Performance

| Aspect | TUI Parsing | JSONL Log Files |
|--------|-------------|-----------------|
| **CPU Usage** | ❌ High (regex, deduplication) | ✅ Low (simple JSON parsing) |
| **Memory Usage** | ⚠️ Screen buffers, line sets | ✅ Minimal (line-by-line) |
| **Latency** | ✅ Immediate (terminal stream) | ⚠️ File system polling delay |

## Recommended Approach: Hybrid Strategy

Based on the investigation, the optimal solution is a **hybrid approach** that combines both methods:

### Phase 1: Initial Response (TUI Streaming)

**Use TUI parsing for real-time streaming during active generation:**
- Provides immediate feedback to user
- Shows streaming responses as they're generated
- No file system polling overhead
- Optimal user experience

### Phase 2: Final Response (JSONL Verification)

**Use JSONL log files for final verification and metadata extraction:**
- Parse complete message from log file after generation completes
- Extract structured metadata (model, tokens, tool calls, thinking blocks)
- Verify TUI parsing accuracy
- Recover from any TUI parsing errors
- Store complete conversation history

### Implementation Strategy

**1. Log File Discovery:**
```typescript
// Use sessions-index.json to find the current session
const indexPath = path.join(os.homedir(), '.claude', 'projects', workspacePath, 'sessions-index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
const session = index.entries.find(e => e.sessionId === currentSessionId);
const logPath = session.fullPath;
```

**2. Real-time Log Monitoring:**
```typescript
// Watch JSONL file for new lines
const watcher = fs.watch(logPath, async (eventType) => {
  if (eventType === 'change') {
    const newLines = await readNewLines(logPath, lastReadPosition);
    for (const line of newLines) {
      const event = JSON.parse(line);
      if (event.type === 'assistant') {
        processAssistantMessage(event);
      }
    }
  }
});
```

**3. Message Extraction:**
```typescript
function processAssistantMessage(event: any) {
  const content = event.message.content;

  // Extract text content
  const textBlocks = content.filter(c => c.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  // Extract thinking blocks
  const thinkingBlocks = content.filter(c => c.type === 'thinking');

  // Extract tool calls
  const toolCalls = content.filter(c => c.type === 'tool_use');

  // Extract metadata
  const metadata = {
    model: event.message.model,
    messageId: event.message.id,
    tokens: event.message.usage,
    stopReason: event.message.stop_reason,
    timestamp: event.timestamp,
    uuid: event.uuid
  };

  return { fullText, thinkingBlocks, toolCalls, metadata };
}
```

**4. Completion Detection:**
```typescript
// Instead of watching for TUI indicators, watch for final assistant message
// with non-null stop_reason
function isResponseComplete(event: any): boolean {
  return (
    event.type === 'assistant' &&
    event.message.stop_reason !== null &&
    event.message.stop_reason !== undefined
  );
}
```

### Benefits of Hybrid Approach

1. **Best of Both Worlds:**
   - Real-time streaming from TUI (immediate feedback)
   - Clean structured data from logs (reliable metadata)
   - Fallback when TUI parsing fails (error recovery)

2. **Progressive Enhancement:**
   - Start with TUI streaming (current behavior)
   - Add log file verification (improve reliability)
   - Gradually migrate more features to log files (reduce TUI dependency)

3. **Backward Compatibility:**
   - Existing TUI parsing continues to work
   - Log file features are additive
   - Can be rolled out incrementally

4. **Future-Proofing:**
   - Less dependent on TUI UI stability
   - Can deprecate TUI parsing over time
   - Easier to add new features (thinking blocks, tool calls)

## Implementation Considerations

### File System Watching

**Options:**
1. **fs.watch()** - Native Node.js file watching
   - Pros: No dependencies, event-driven
   - Cons: Platform inconsistencies, may miss rapid writes

2. **chokidar** - Robust file watching library
   - Pros: Reliable, cross-platform, handles rapid changes
   - Cons: Additional dependency

3. **Polling** - Periodic file read
   - Pros: Simple, guaranteed to work
   - Cons: Higher latency, more I/O

**Recommendation:** Start with `fs.watch()` and fall back to polling if needed.

### Race Conditions

**Challenge:** JSONL file updates may lag behind TUI output.

**Solution:**
- Use TUI for primary streaming (no lag)
- Use JSONL for verification after completion detected in TUI
- Track last read position in JSONL to avoid re-reading

### Session ID Correlation

**Challenge:** Must correlate FlightPath execution with Claude session ID.

**Current Approach (TuiStreamProcessor):**
- Waits for TUI to output session ID
- Parses from terminal output

**JSONL Approach:**
- Session ID is in every log entry
- Can read from first line of new JSONL file
- More reliable than TUI parsing

**Recommendation:**
- Continue using TUI for session ID extraction during startup
- Use JSONL session ID as verification/fallback

### Multi-Session Handling

**Challenge:** Multiple sessions may be active (main + agents).

**JSONL Advantages:**
- Each session has its own file
- `isSidechain` flag identifies agent sessions
- `agentId` field for agent tracking
- Subagent files in session subdirectories

**Implementation:**
- Track active session IDs in FlightPath
- Monitor multiple JSONL files simultaneously
- Correlate agent sessions with parent workflow

## Migration Path

### Phase 1: Validation (Low Risk)

**Goal:** Validate JSONL approach without changing user-facing behavior.

**Tasks:**
1. Add JSONL log file monitoring alongside TUI parsing
2. Compare TUI output with JSONL content
3. Log discrepancies for analysis
4. Collect metrics on JSONL reliability

**Success Criteria:**
- JSONL content matches TUI output 99%+ of the time
- No performance degradation
- Clean error handling for missing/corrupted logs

### Phase 2: Metadata Enhancement (Medium Risk)

**Goal:** Add features that only JSONL can provide.

**Tasks:**
1. Extract and display token counts from JSONL usage field
2. Parse and display tool calls as structured data
3. Extract thinking blocks (if present in future Claude versions)
4. Show conversation UUIDs for debugging

**Success Criteria:**
- Users see richer metadata in dashboard
- Token counts are accurate
- Tool calls are clearly displayed

### Phase 3: Hybrid Streaming (High Risk)

**Goal:** Use JSONL as primary source, TUI as fallback.

**Tasks:**
1. Implement file watching for real-time JSONL updates
2. Stream content from JSONL instead of TUI
3. Fall back to TUI if JSONL unavailable/delayed
4. Add user setting to choose mode (TUI/JSONL/Hybrid)

**Success Criteria:**
- Streaming latency comparable to TUI
- No visual glitches or missing content
- Smooth fallback when needed

### Phase 4: TUI Deprecation (Future)

**Goal:** Reduce dependency on TUI parsing.

**Tasks:**
1. Mark TuiStreamProcessor as deprecated
2. Move all streaming to JSONL-based approach
3. Keep minimal TUI parsing for error detection only
4. Remove complex deduplication/chrome filtering code

**Success Criteria:**
- Code complexity reduced by 50%+
- Maintenance burden significantly lower
- Breaking TUI changes don't affect FlightPath

## Conclusion and Recommendations

### Key Findings

**All three CLI providers (Claude, Copilot, Codex) maintain structured JSONL log files:**

✅ **Structured data** - Clean JSON instead of parsed text (all providers)
✅ **Reliability** - No ANSI codes, TUI chrome, or deduplication needed (all providers)
✅ **Simplicity** - ~5x less code complexity (~1000 lines → ~100-200 per provider)
✅ **Features** - Rich metadata, tool calls, thinking/reasoning blocks, history (all providers)
✅ **Maintainability** - Versioned formats, less fragile (all providers)

### Critical Implications for FlightPath

**TUI parsing can be completely removed:**
- Current approach: 997-line `TuiStreamProcessor.ts` shared across all providers
- JSONL approach: ~100-200 lines per provider (3 separate parsers)
- **Net reduction**: ~400-600 lines of code (60-80% reduction)
- **Maintenance**: Provider-specific parsers are simpler than unified TUI processor
- **Reliability**: No more TUI format changes breaking FlightPath

**Provider-Specific Considerations:**

1. **Claude** - Easiest to implement
   - Simple event model (user/assistant)
   - Built-in session index
   - Single event per response
   - Subagent tracking built-in

2. **Copilot** - Medium complexity
   - Granular event system
   - Multi-event response aggregation
   - History files for session metadata
   - Tool execution lifecycle tracking

3. **Codex** - Most metadata, hardest discovery
   - Rich session context (git, sandbox, permissions)
   - Nested payload structure
   - Date-based organization (no index)
   - Encrypted reasoning blocks (future potential)

### Recommended Implementation Strategy

**Phase 1: Log-Based Verification (Low Risk)**
- Add JSONL monitoring alongside TUI parsing
- Compare outputs for accuracy validation
- Collect metrics on reliability and performance
- **Success metric**: 99%+ match rate across all providers

**Phase 2: Hybrid Streaming (Medium Risk)**
- Use JSONL as primary source with TUI fallback
- Implement provider-specific log parsers:
  - `ClaudeLogParser` - Parse Claude JSONL events
  - `CopilotLogParser` - Aggregate Copilot multi-event responses
  - `CodexLogParser` - Parse Codex nested payloads
- Add file watching for real-time streaming
- **Success metric**: Latency comparable to TUI, smooth fallback

**Phase 3: TUI Deprecation (High Risk)**
- Mark `TuiStreamProcessor` as deprecated
- Move all streaming to JSONL
- Keep minimal TUI for error detection only
- **Success metric**: 50%+ code reduction, stable performance

**Phase 4: Metadata Enhancement (Future)**
- Extract thinking blocks (Claude) and reasoning (Codex)
- Display tool calls as structured data
- Show rich metadata (tokens, models, timing)
- Track approval policies and sandbox settings (Codex)
- **Success metric**: New features unavailable with TUI

### Architecture Changes

**Current Architecture:**
```
CliIntegration
  ├── CopilotCliProvider
  ├── ClaudeCliProvider
  └── CodexCliProvider
      └── TuiStreamProcessor (shared, 997 lines)
```

**JSONL Architecture:**
```
CliIntegration
  ├── CopilotCliProvider
  │   └── CopilotLogParser (~150 lines)
  ├── ClaudeCliProvider
  │   └── ClaudeLogParser (~100 lines)
  └── CodexCliProvider
      └── CodexLogParser (~150 lines)
```

**Shared utilities:**
- `LogFileMonitor` - File watching and line reading (shared)
- `ILogParser` - Interface for provider-specific parsers
- Session discovery helpers (provider-specific)

### Recommended Next Steps

1. **Immediate** (Week 1-2):
   - Create `ILogParser` interface
   - Implement `ClaudeLogParser` (simplest provider)
   - Add validation alongside TUI parsing
   - Collect accuracy metrics

2. **Short-term** (Month 1):
   - Implement `CopilotLogParser` and `CodexLogParser`
   - Add file watching infrastructure
   - Test hybrid streaming with all providers
   - Validate completion detection

3. **Medium-term** (Month 2-3):
   - Enable JSONL as primary source (feature flag)
   - Deprecate TUI parsing
   - Remove complex TUI logic
   - Monitor for regressions

4. **Long-term** (Month 4+):
   - Add metadata features (thinking blocks, tool tracking)
   - Implement reasoning block decryption (Codex)
   - Historical session replay
   - Advanced debugging features

### Migration Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| **Log file delays** | Keep TUI as fallback, measure latency in Phase 1 |
| **Missing log files** | Check file existence before parsing, fail gracefully |
| **Format changes** | Version detection, backward compatibility |
| **Copilot format migration** | **Support both old (flat) and new (subdirectory) formats, check subdirs first** |
| **Session discovery** | Provider-specific discovery strategies, caching |
| **Multi-event assembly** | State machine for Copilot/Codex event aggregation |
| **File watching issues** | Fallback to polling on watch failures |
| **Completion detection changes** | **Use assistant.turn_end when available, fallback to heuristics** |

### Expected Benefits

**Code Quality:**
- 60-80% reduction in CLI parsing code
- Simpler, more maintainable parsers
- Provider-specific logic isolated
- Clear separation of concerns

**Reliability:**
- No TUI format dependencies
- Structured error handling
- Complete conversation history
- Accurate metadata extraction

**Features:**
- Thinking blocks (Claude)
- Reasoning tracking (Codex)
- Tool call visualization
- Token usage analytics
- Session replay/debugging

**The JSONL approach is the clear path forward** - all three providers support it, the implementation is simpler, and the feature potential is significantly greater than TUI parsing can offer.

## Appendix: Sample JSONL Parsing Code

### Shared Base Parser

```typescript
/**
 * Base log parser with shared file watching and line reading
 */
export abstract class BaseLogParser {
  protected lastReadPosition = 0;

  /**
   * Read new lines from JSONL file since last read
   */
  async readNewLines(filePath: string): Promise<any[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    const newContent = content.substring(this.lastReadPosition);
    this.lastReadPosition = content.length;

    const lines = newContent.split('\n').filter(line => line.trim());
    return lines.map(line => JSON.parse(line));
  }

  /**
   * Watch JSONL file for changes
   */
  watchLogFile(filePath: string, callback: (entry: any) => void): fs.FSWatcher {
    return fs.watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        const newLines = await this.readNewLines(filePath);
        newLines.forEach(callback);
      }
    });
  }

  /**
   * Provider-specific response extraction (implemented by subclasses)
   */
  abstract extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
  };

  /**
   * Provider-specific completion detection
   */
  abstract isComplete(event: any): boolean;
}
```

### Claude Log Parser

```typescript
/**
 * Parse Claude CLI JSONL log files
 */
export class ClaudeLogParser extends BaseLogParser {
  /**
   * Extract assistant response from Claude log entry
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    thinkingBlocks: any[];
    metadata: any;
  } {
    // Claude uses single event per response
    const entry = events[0];

    if (entry.type !== 'assistant') {
      throw new Error('Not an assistant message');
    }

    const content = entry.message.content;

    // Extract text blocks
    const textBlocks = content.filter((c: any) => c.type === 'text');
    const text = textBlocks.map((b: any) => b.text).join('\n');

    // Extract tool calls
    const toolCalls = content.filter((c: any) => c.type === 'tool_use');

    // Extract thinking blocks
    const thinkingBlocks = content.filter((c: any) => c.type === 'thinking');

    // Extract metadata
    const metadata = {
      model: entry.message.model,
      messageId: entry.message.id,
      usage: entry.message.usage,
      stopReason: entry.message.stop_reason,
      timestamp: entry.timestamp,
      uuid: entry.uuid,
      sessionId: entry.sessionId
    };

    return { text, toolCalls, thinkingBlocks, metadata };
  }

  /**
   * Detect completion via stop_reason
   */
  isComplete(event: any): boolean {
    return (
      event.type === 'assistant' &&
      event.message?.stop_reason !== null &&
      event.message?.stop_reason !== undefined
    );
  }
}
```

### Copilot Log Parser

```typescript
/**
 * Parse Copilot CLI JSONL log files
 * Supports both old (flat file) and new (subdirectory) formats
 */
export class CopilotLogParser extends BaseLogParser {
  private eventBuffer: any[] = [];

  /**
   * Get log file path for a session
   * Checks for new format first (subdirectory), falls back to old format (flat file)
   */
  static async getLogPath(sessionId: string): Promise<string | null> {
    const baseDir = path.join(os.homedir(), '.copilot', 'session-state');

    // Try new format first (v0.0.384+): <session-id>/events.jsonl
    const newFormatPath = path.join(baseDir, sessionId, 'events.jsonl');
    if (await fs.pathExists(newFormatPath)) {
      return newFormatPath;
    }

    // Fall back to old format: <session-id>.jsonl
    const oldFormatPath = path.join(baseDir, `${sessionId}.jsonl`);
    if (await fs.pathExists(oldFormatPath)) {
      return oldFormatPath;
    }

    return null; // Session not found
  }

  /**
   * Extract assistant response from Copilot log entries
   * Copilot uses multi-event responses that must be aggregated
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
    sessionInfo?: any[];
  } {
    // Aggregate all assistant.message events
    const assistantEvents = events.filter(e => e.type === 'assistant.message');

    // Combine text content
    const text = assistantEvents
      .map(e => e.data.content)
      .filter(c => c)
      .join('\n');

    // Aggregate tool requests
    const toolCalls = assistantEvents
      .flatMap(e => e.data.toolRequests || []);

    // Extract session info (new format only)
    const sessionInfo = events
      .filter(e => e.type === 'session.info')
      .map(e => ({
        infoType: e.data.infoType,
        message: e.data.message,
        timestamp: e.timestamp
      }));

    // Extract metadata from first event
    const firstEvent = assistantEvents[0];
    const metadata = {
      messageId: firstEvent?.data?.messageId,
      timestamp: firstEvent?.timestamp,
      eventId: firstEvent?.id,
      parentId: firstEvent?.parentId
    };

    return { text, toolCalls, metadata, sessionInfo };
  }

  /**
   * Detect turn completion
   * New format (v0.0.384+): Uses explicit assistant.turn_end event
   * Old format: Heuristic based on event patterns
   */
  isComplete(event: any): boolean {
    // New format: explicit turn end event
    if (event.type === 'assistant.turn_end') {
      return true;
    }

    // Old format fallback: assistant.message with no pending tool requests
    // Note: This is a heuristic and may need tuning
    return event.type === 'assistant.message' &&
           !event.data.toolRequests?.length;
  }

  /**
   * Buffer events until turn completes
   */
  processEvent(event: any): any | null {
    this.eventBuffer.push(event);

    if (this.isComplete(event)) {
      const response = this.extractResponse(this.eventBuffer);
      this.eventBuffer = []; // Reset for next turn
      return response;
    }

    return null; // Turn not yet complete
  }
}
```

### Codex Log Parser

```typescript
/**
 * Parse Codex CLI JSONL log files
 */
export class CodexLogParser extends BaseLogParser {
  private eventBuffer: any[] = [];
  private sessionMeta: any = null;

  /**
   * Extract assistant response from Codex log entries
   * Codex uses nested payload structure with response_item events
   */
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    reasoning: any[];
    metadata: any;
  } {
    // Filter response_item events
    const responseItems = events.filter(e => e.type === 'response_item');

    // Extract text content (role: assistant, type: message)
    const textEvents = responseItems.filter(e =>
      e.payload?.type === 'message' &&
      e.payload?.role === 'assistant'
    );
    const text = textEvents
      .map(e => e.payload.content.find((c: any) => c.type === 'input_text')?.text)
      .filter(Boolean)
      .join('\n');

    // Extract tool calls (type: function_call)
    const toolCalls = responseItems
      .filter(e => e.payload?.type === 'function_call')
      .map(e => ({
        name: e.payload.name,
        arguments: JSON.parse(e.payload.arguments),
        callId: e.payload.call_id
      }));

    // Extract reasoning blocks (type: reasoning)
    const reasoning = responseItems
      .filter(e => e.payload?.type === 'reasoning')
      .map(e => ({
        summary: e.payload.summary,
        encrypted: e.payload.encrypted_content,
        timestamp: e.timestamp
      }));

    // Extract metadata from turn_context and session_meta
    const turnContext = events.find(e => e.type === 'turn_context')?.payload;
    const metadata = {
      sessionId: this.sessionMeta?.id,
      model: turnContext?.model,
      effort: turnContext?.effort,
      cwd: turnContext?.cwd,
      approvalPolicy: turnContext?.approval_policy,
      sandboxPolicy: turnContext?.sandbox_policy,
      git: this.sessionMeta?.git,
      cliVersion: this.sessionMeta?.cli_version
    };

    return { text, toolCalls, reasoning, metadata };
  }

  /**
   * Detect completion via event_msg with type: turn.completed
   */
  isComplete(event: any): boolean {
    return (
      event.type === 'event_msg' &&
      event.payload?.type === 'turn.completed'
    );
  }

  /**
   * Process events with buffering
   */
  processEvent(event: any): any | null {
    // Capture session metadata
    if (event.type === 'session_meta') {
      this.sessionMeta = event.payload;
    }

    this.eventBuffer.push(event);

    if (this.isComplete(event)) {
      const response = this.extractResponse(this.eventBuffer);
      this.eventBuffer = []; // Reset for next turn
      return response;
    }

    return null; // Turn not yet complete
  }
}
```

### Usage Example

```typescript
// Initialize parser based on provider
let parser: BaseLogParser;
let logPath: string | null;

switch (provider) {
  case 'claude':
    parser = new ClaudeLogParser();
    logPath = getClaudeLogPath(sessionId); // From sessions-index.json
    break;

  case 'copilot':
    parser = new CopilotLogParser();
    // IMPORTANT: Check for both old and new formats
    logPath = await CopilotLogParser.getLogPath(sessionId);
    if (!logPath) {
      throw new Error(`Copilot session ${sessionId} not found`);
    }
    break;

  case 'codex':
    parser = new CodexLogParser();
    logPath = getCodexLogPath(sessionId); // Search date hierarchy
    break;
}

// Watch log file
parser.watchLogFile(logPath, (event) => {
  // For Claude: process each event directly
  if (provider === 'claude' && parser.isComplete(event)) {
    const response = parser.extractResponse([event]);
    console.log('Response:', response.text);
    console.log('Tokens:', response.metadata.usage);
  }

  // For Copilot/Codex: buffer events
  if (provider !== 'claude') {
    const response = (parser as any).processEvent(event);
    if (response) {
      console.log('Response:', response.text);
      console.log('Tool calls:', response.toolCalls);

      // Copilot new format: show session info
      if (provider === 'copilot' && response.sessionInfo?.length) {
        console.log('Session info:', response.sessionInfo);
      }
    }
  }
});
```

**Helper: Copilot Log Discovery**

```typescript
/**
 * Find Copilot log file path
 * Supports both old (flat file) and new (subdirectory) formats
 */
async function findCopilotLogPath(sessionId: string): Promise<string | null> {
  return await CopilotLogParser.getLogPath(sessionId);
}

/**
 * Discover all Copilot sessions (both formats)
 */
async function discoverCopilotSessions(): Promise<Array<{sessionId: string, path: string, format: 'old' | 'new'}>> {
  const baseDir = path.join(os.homedir(), '.copilot', 'session-state');
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const sessions: Array<{sessionId: string, path: string, format: 'old' | 'new'}> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // New format: <session-id>/events.jsonl
      const eventsPath = path.join(baseDir, entry.name, 'events.jsonl');
      if (await fs.pathExists(eventsPath)) {
        sessions.push({
          sessionId: entry.name,
          path: eventsPath,
          format: 'new'
        });
      }
    } else if (entry.name.endsWith('.jsonl')) {
      // Old format: <session-id>.jsonl
      const sessionId = entry.name.replace('.jsonl', '');
      sessions.push({
        sessionId,
        path: path.join(baseDir, entry.name),
        format: 'old'
      });
    }
  }

  return sessions;
}
```

## References

**CLI Documentation:**
- Claude Code CLI: https://docs.anthropic.com/claude/docs/claude-code
- GitHub Copilot CLI: https://github.com/github/copilot-cli
- OpenAI Codex CLI: https://github.com/openai/codex-cli

**Technical Specifications:**
- JSONL Format: https://jsonlines.org/
- Node.js fs.watch API: https://nodejs.org/api/fs.html#fswatchfilename-options-listener
- VS Code File System API: https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher

**Related FlightPath Documentation:**
- Current TUI Implementation: `src/utils/TuiStreamProcessor.ts`
- CLI Provider Interfaces: `src/flightpath/cli/shared/interfaces/`
- Response Parsers: `src/flightpath/cli/*/ResponseParser.ts`
