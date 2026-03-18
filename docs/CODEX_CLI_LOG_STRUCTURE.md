# Codex CLI Log File Structure

**Location:** `C:\Users\<username>\.codex\sessions\YYYY\MM\DD\`

**Format:** JSONL (JSON Lines) - One JSON object per line

**File Naming:** `rollout-<timestamp>-<session-id>.jsonl`

**Codex CLI Version:** 0.87.0+

This document describes the structure of all event types found in Codex CLI log files, based on real production logs and FlightPath's `CodexLogParser` implementation.

---

## Table of Contents

1. [Overview](#overview)
2. [Directory Structure](#directory-structure)
3. [Common Event Structure](#common-event-structure)
4. [Session Metadata](#session-metadata)
5. [User Messages](#user-messages)
6. [Turn Context](#turn-context)
7. [Assistant Messages](#assistant-messages)
8. [Reasoning Blocks](#reasoning-blocks)
9. [Tool Calls - Two Formats](#tool-calls---two-formats)
10. [Tool Call Results](#tool-call-results)
11. [Event Messages](#event-messages)
12. [Token Usage](#token-usage)
13. [Completion Detection](#completion-detection)
14. [FlightPath Integration](#flightpath-integration)
15. [Comparison with Claude & Copilot](#comparison-with-claude--copilot)
16. [Notes and Observations](#notes-and-observations)

---

## Overview

Codex CLI uses a **nested payload structure** where most meaningful data lives inside a `payload` object. This differs from Copilot (flat `data` objects) and resembles Claude (also uses payloads, but different types).

**Key Characteristics:**

- **Date-based directories**: Logs organized by year/month/day (YYYY/MM/DD)
- **No index file**: Unlike Copilot, Codex doesn't maintain a session index
- **Nested payloads**: Most events have `{type, payload, timestamp}` structure
- **Two tool call formats**: `tool_use` (with `input` object) and `function_call` (with `arguments` JSON string)
- **Session ID format**: `thread_<alphanumeric>` or UUID (e.g., `019be234-a937-7a83-957a-5e6ca36cfa13`)
- **Completion signal**: `{"type": "event_msg", "payload": {"type": "turn.completed"}}`

---

## Directory Structure

### Log File Path Pattern

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
```

**Example:**

```
C:\Users\natha\.codex\sessions\2026\01\21\rollout-2026-01-21T14-17-40-019be234-a937-7a83-957a-5e6ca36cfa13.jsonl
```

### Path Components

| Component | Description                              | Example                                                                  |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| Base      | User's home directory                    | `C:\Users\natha`                                                         |
| Root      | Codex sessions directory                 | `.codex\sessions\`                                                       |
| Year      | 4-digit year                             | `2026`                                                                   |
| Month     | 2-digit month (zero-padded)              | `01`                                                                     |
| Day       | 2-digit day (zero-padded)                | `21`                                                                     |
| Filename  | `rollout-<timestamp>-<session-id>.jsonl` | `rollout-2026-01-21T14-17-40-019be234-a937-7a83-957a-5e6ca36cfa13.jsonl` |

### Discovery Implications

**No Index File:**

- Codex does NOT maintain a central index file (unlike Copilot's `~/.copilot/session-state/index.json`)
- Session discovery requires:
  1. Calculate date directory from execution start time
  2. List all `.jsonl` files in that directory
  3. Filter by modification time (after start time)
  4. Read first N events to find matching prompt text

**Session ID Matching:**

- If session ID is known, use fast path: search for file ending with `-<session-id>.jsonl`
- If resuming, same log file is updated (check `mtime >= startTime`)

---

## Common Event Structure

All Codex events follow this base structure:

```json
{
  "type": "event_type_name",
  "payload": {
    /* event-specific data */
  },
  "timestamp": "ISO-8601-timestamp"
}
```

### Base Fields

| Field       | Type   | Description                                             |
| ----------- | ------ | ------------------------------------------------------- |
| `type`      | string | Event type identifier                                   |
| `payload`   | object | Event-specific nested data (structure varies by type)   |
| `timestamp` | string | ISO 8601 timestamp (e.g., `"2026-01-21T20:17:40.727Z"`) |

**Note:** Unlike Copilot (which uses `id` and `parentId` for event graphs), Codex events are flat with just timestamp ordering.

---

## Session Metadata

### Event Type: `session_meta`

**Description:** Contains session initialization data including session ID, model, CLI version, and git context.

**Occurrence:** Once per session (typically the first event in the log file)

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:40.727Z",
  "type": "session_meta",
  "payload": {
    "id": "019be234-a937-7a83-957a-5e6ca36cfa13",
    "timestamp": "2026-01-21T20:17:40.664Z",
    "cwd": "C:\\dev\\FlightPath",
    "originator": "codex_cli_rs",
    "cli_version": "0.87.0",
    "instructions": "Always read the main project instructions:\r\n\r\n@.github/copilot-instructions.md\r\n...",
    "source": "cli",
    "model_provider": "openai",
    "git": {
      "commit_hash": "93aff1a666a3c41138461fac99d702d85497145d",
      "branch": "main",
      "repository_url": "https://github.com/nhickster/flightpath.git"
    }
  }
}
```

### Payload Fields

| Field                | Type   | Description                                    |
| -------------------- | ------ | ---------------------------------------------- |
| `id`                 | string | Session ID (UUID or `thread_xxx` format)       |
| `timestamp`          | string | Session start timestamp                        |
| `cwd`                | string | Current working directory                      |
| `originator`         | string | Always `"codex_cli_rs"` (Codex CLI executable) |
| `cli_version`        | string | Codex CLI version (e.g., `"0.87.0"`)           |
| `instructions`       | string | System instructions / agent context            |
| `source`             | string | Always `"cli"` (vs web interface)              |
| `model_provider`     | string | AI provider (e.g., `"openai"`)                 |
| `git`                | object | Git repository metadata (optional)             |
| `git.commit_hash`    | string | Current commit SHA                             |
| `git.branch`         | string | Current branch name                            |
| `git.repository_url` | string | Remote repository URL                          |

### Parsing Example

```typescript
// CodexLogParser.extractResponse()
if (event.type === "session_meta" && event.payload) {
  sessionId = event.payload.id;
  model = event.payload.model;
  cliVersion = event.payload.cli_version;
}
```

### Session ID Formats

**Two formats observed:**

1. **UUID format**: `019be234-a937-7a83-957a-5e6ca36cfa13`
2. **Thread format**: `thread_abc123xyz789`

**FlightPath Handling:**

```typescript
// CodexLogParser.extractSessionId()
extractSessionId(events: any[]): string | null {
  for (const event of events) {
    if (event.type === "session_meta" && event.payload?.id) {
      return event.payload.id;
    }
  }
  return null;
}
```

---

## User Messages

### Event Type: `response_item` (role: user)

**Description:** User messages are echoed back as `response_item` events with `role: "user"`.

**Note:** This differs from Claude (uses `type: "user"` at top level) and Copilot (uses `user.message` event type).

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:40.738Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [
      {
        "type": "input_text",
        "text": "this is a test, just say hi"
      }
    ]
  }
}
```

### Payload Fields

| Field            | Type   | Description                                            |
| ---------------- | ------ | ------------------------------------------------------ |
| `type`           | string | Always `"message"` for user messages                   |
| `role`           | string | Always `"user"`                                        |
| `content`        | array  | Array of content blocks (always `input_text` for user) |
| `content[].type` | string | Content type (`"input_text"`)                          |
| `content[].text` | string | User's message text                                    |

### Developer Instructions

**Event Type: `response_item` (role: developer)**

Codex also sends system-level instructions as `role: "developer"` messages:

```json
{
  "timestamp": "2026-01-21T20:17:40.727Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "developer",
    "content": [
      {
        "type": "input_text",
        "text": "<permissions instructions>Filesystem sandboxing defines..."
      }
    ]
  }
}
```

**Use Case:** Sandbox permissions, approval policies, filesystem restrictions.

---

## Turn Context

### Event Type: `turn_context`

**Description:** Contains execution context for the current turn (model, sandbox settings, approval policy, etc.).

**Occurrence:** Once per user turn (after user message)

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:40.738Z",
  "type": "turn_context",
  "payload": {
    "cwd": "C:\\dev\\FlightPath",
    "approval_policy": "on-request",
    "sandbox_policy": {
      "type": "workspace-write",
      "writable_roots": ["c:\\dev\\FlightPath"],
      "network_access": false,
      "exclude_tmpdir_env_var": false,
      "exclude_slash_tmp": false
    },
    "model": "gpt-5.1-codex-mini",
    "effort": "medium",
    "summary": "auto",
    "user_instructions": "Always read the main project instructions...",
    "truncation_policy": {
      "mode": "tokens",
      "limit": 10000
    }
  }
}
```

### Payload Fields

| Field                           | Type    | Description                                                      |
| ------------------------------- | ------- | ---------------------------------------------------------------- |
| `cwd`                           | string  | Current working directory                                        |
| `approval_policy`               | string  | Approval mode (`"on-request"`, `"full-auto"`, etc.)              |
| `sandbox_policy`                | object  | Sandbox configuration                                            |
| `sandbox_policy.type`           | string  | Sandbox mode (`"workspace-write"`, `"workspace-read"`, `"none"`) |
| `sandbox_policy.writable_roots` | array   | Directories allowed for writes                                   |
| `sandbox_policy.network_access` | boolean | Whether network access is permitted                              |
| `model`                         | string  | Model name (e.g., `"gpt-5.1-codex-mini"`)                        |
| `effort`                        | string  | Effort level (`"low"`, `"medium"`, `"high"`)                     |
| `summary`                       | string  | Summary mode (`"auto"`, `"manual"`, `"none"`)                    |
| `user_instructions`             | string  | Custom instructions for this session                             |
| `truncation_policy`             | object  | Context window truncation settings                               |

### Usage in FlightPath

FlightPath uses `turn_context` to discover user messages during session log matching:

```typescript
// CodexLogParser.discoverSessionLog()
if (event.type === "turn_context" && event.payload?.messages) {
  const userMsg = event.payload.messages.find((m) => m.role === "user");
  if (userMsg?.content) {
    userMessage = Array.isArray(userMsg.content)
      ? userMsg.content.map((c) => c.text).join("")
      : userMsg.content;
  }
}
```

---

## Assistant Messages

### Event Type: `response_item` (role: assistant)

**Description:** AI responses are sent as `response_item` events with `role: "assistant"` and a `content` array containing text, tool calls, and reasoning blocks.

**Streaming:** Multiple `response_item` events accumulate during a single response.

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:42.030Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "hi"
      }
    ]
  }
}
```

### Content Block Types

| Type          | Description              | Fields                |
| ------------- | ------------------------ | --------------------- |
| `input_text`  | Text content (legacy)    | `text`                |
| `output_text` | Text content (preferred) | `text`                |
| `tool_use`    | Tool call (Format A)     | `name`, `input`, `id` |
| `thinking`    | Reasoning/thinking block | `text`                |

**Note:** Both `input_text` and `output_text` appear in assistant messages. FlightPath treats them identically.

### Multi-Part Responses

Codex streams responses across multiple `response_item` events:

```json
{"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "output_text", "text": "Let me "}]}}
{"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "output_text", "text": "help you "}]}}
{"type": "response_item", "payload": {"role": "assistant", "content": [{"type": "output_text", "text": "with that."}]}}
```

**Parsing Logic:**

```typescript
// CodexLogParser.extractResponse()
const textParts: string[] = [];

for (const event of events) {
  if (event.type === "response_item" && event.payload?.role === "assistant") {
    const content = event.payload.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if ((item.type === "input_text" || item.type === "output_text") && item.text) {
          textParts.push(item.text);
        }
      }
    }
  }
}

return { text: textParts.join(""), ... };
```

---

## Reasoning Blocks

### Event Type: `response_item` (type: reasoning)

**Description:** Codex sends reasoning/thinking blocks in two formats:

1. **Inline thinking** - Within assistant message content array
2. **Encrypted reasoning** - Separate `type: "reasoning"` event with encrypted content

### Format 1: Inline Thinking (Content Array)

```json
{
  "timestamp": "2026-01-21T20:20:04.534Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "text": "Let me think about this approach..."
      },
      {
        "type": "output_text",
        "text": "Based on my analysis, I recommend..."
      }
    ]
  }
}
```

**Parsing:**

```typescript
// CodexLogParser.extractResponse()
if (item.type === "thinking" && item.text) {
  reasoningBlocks.push(item.text);
}
```

### Format 2: Encrypted Reasoning Event

```json
{
  "timestamp": "2026-01-21T20:17:41.943Z",
  "type": "response_item",
  "payload": {
    "type": "reasoning",
    "summary": [],
    "content": null,
    "encrypted_content": "gAAAAABpcTRnLqH1lnKlQ2EFeFuaR-aPI2B6JkY3y-5KMZ165IQxFw60sHHQGSTeM..."
  }
}
```

**Fields:**

| Field               | Type        | Description                              |
| ------------------- | ----------- | ---------------------------------------- |
| `type`              | string      | Always `"reasoning"`                     |
| `summary`           | array       | Summary points (usually empty)           |
| `content`           | string/null | Plaintext reasoning (null if encrypted)  |
| `encrypted_content` | string      | Base64-encoded encrypted reasoning block |

**Note:** FlightPath does NOT decrypt encrypted reasoning blocks. These are for debugging/logging only.

---

## Tool Calls - Two Formats

**CRITICAL:** Codex uses **TWO different formats** for tool calls:

1. **Format A: `tool_use` (Content Block)** - Tool call embedded in assistant message content array (similar to Claude)
2. **Format B: `function_call` (Dedicated Event)** - Tool call as separate `response_item` event (similar to OpenAI function calling)

### Format A: `tool_use` (Content Block)

**Description:** Tool call appears as an item in the `content` array of an assistant message.

**Structure:**

```json
{
  "timestamp": "2026-01-21T21:46:05.123Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "Let me create that file for you."
      },
      {
        "type": "tool_use",
        "name": "write_file",
        "input": {
          "path": "src/example.ts",
          "content": "export const hello = 'world';"
        },
        "id": "tool-codex-1"
      }
    ]
  }
}
```

**Tool Use Fields:**

| Field   | Type       | Description                                         |
| ------- | ---------- | --------------------------------------------------- |
| `type`  | string     | Always `"tool_use"`                                 |
| `name`  | string     | Tool name (e.g., `"write_file"`, `"shell_command"`) |
| `input` | **object** | Tool parameters as **object** (already parsed!)     |
| `id`    | string     | Unique tool call identifier                         |

**Parsing:**

```typescript
// CodexLogParser.extractResponse()
if (item.type === "tool_use") {
  toolCalls.push({
    name: item.name,
    input: item.input, // Already an object!
    id: item.id,
  });
}
```

### Format B: `function_call` (Dedicated Event)

**Description:** Tool call appears as a separate `response_item` event with `type: "function_call"` in the payload.

**CRITICAL DIFFERENCE:** The `arguments` field is a **JSON string**, not an object!

**Structure:**

```json
{
  "timestamp": "2026-01-21T21:46:11.680Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "shell_command",
    "arguments": "{\"command\":\"Get-Content -Path .flightpath\\\\temp\\\\1769031963-codex-test-two-2.prompt.md\",\"workdir\":\"C:\\\\dev\\\\FlightPath\"}",
    "call_id": "call_Db3S4LkHCAWW0u5KALERaHOe"
  }
}
```

**Function Call Fields:**

| Field       | Type       | Description                                              |
| ----------- | ---------- | -------------------------------------------------------- |
| `type`      | string     | Always `"function_call"`                                 |
| `name`      | string     | Function name (e.g., `"shell_command"`)                  |
| `arguments` | **string** | Function parameters as **JSON string** (must be parsed!) |
| `call_id`   | string     | Unique call identifier                                   |

**CRITICAL: `arguments` is a JSON string!**

**Parsing:**

```typescript
// CodexLogParser.extractResponse()
if (event.type === "response_item" && event.payload?.type === "function_call") {
  toolCalls.push({
    name: event.payload.name,
    input: event.payload.arguments, // Store as-is (string)
    id: event.payload.call_id ?? event.payload.id,
  });
}
```

**Usage Warning:**

If you try to use `arguments` directly as an object, it will fail:

```typescript
// ❌ WRONG - will fail!
const command = toolCall.input.command;

// ✅ CORRECT - parse first!
const params = JSON.parse(toolCall.input);
const command = params.command;
```

### Tool Call Comparison Table

| Aspect           | Format A (`tool_use`)  | Format B (`function_call`) |
| ---------------- | ---------------------- | -------------------------- |
| Location         | Inside `content` array | Separate event             |
| Payload type     | `"message"`            | `"function_call"`          |
| Parameters field | `input` (object)       | `arguments` (string!)      |
| ID field         | `id`                   | `call_id`                  |
| Parsing required | ❌ No (already object) | ✅ **YES (JSON.parse)**    |
| Similar to       | Claude `tool_use`      | OpenAI function calling    |

### Which Format Does Codex Use?

**Both!** The format appears to depend on:

- Model version
- Tool type
- Execution context (interactive vs headless)

**FlightPath Strategy:** Support both formats in `CodexLogParser.extractResponse()`:

```typescript
// Format A: tool_use in content array
if (item.type === "tool_use") {
  toolCalls.push({ name: item.name, input: item.input, id: item.id });
}

// Format B: function_call as separate event
if (event.type === "response_item" && event.payload?.type === "function_call") {
  toolCalls.push({
    name: event.payload.name,
    input: event.payload.arguments, // String! Consumer must parse
    id: event.payload.call_id ?? event.payload.id,
  });
}
```

---

## Tool Call Results

### Event Type: `response_item` (type: function_call_output)

**Description:** Results from tool execution are logged as `function_call_output` events.

**Structure:**

````json
{
  "timestamp": "2026-01-21T21:46:12.815Z",
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_Db3S4LkHCAWW0u5KALERaHOe",
    "output": "Exit code: 0\nWall time: 0.4 seconds\nOutput:\n<attachment id=\"symbol:src/flightpath/cli/codex/CodexCliProvider.ts:52-402\">\r\nSymbol: CodexCliProvider in src/flightpath/cli/codex/CodexCliProvider.ts, lines 52 to 402:\r\n```typescript\r\nexport class CodexCliProvider implements ICliProvider {\r\n  readonly config: ProviderConfig = {\r\n..."
  }
}
````

**Payload Fields:**

| Field     | Type   | Description                                        |
| --------- | ------ | -------------------------------------------------- |
| `type`    | string | Always `"function_call_output"`                    |
| `call_id` | string | Matches `call_id` from `function_call` event       |
| `output`  | string | Tool execution result (stdout, file content, etc.) |

**Note:** FlightPath does NOT currently parse tool results. These are logged but not used in response extraction.

---

## Event Messages

### Event Type: `event_msg`

**Description:** Control events for user messages, agent messages, token counts, and turn completion.

**Four subtypes:**

1. `user_message` - User prompt echo
2. `agent_message` - Agent text output (duplicate of response_item)
3. `token_count` - Token usage statistics
4. `turn.completed` - **Completion signal**

### Subtype: `user_message`

```json
{
  "timestamp": "2026-01-21T20:17:40.738Z",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "message": "this is a test, just say hi",
    "images": [],
    "local_images": [],
    "text_elements": []
  }
}
```

**Fields:**

| Field           | Type   | Description             |
| --------------- | ------ | ----------------------- |
| `type`          | string | Always `"user_message"` |
| `message`       | string | User's prompt text      |
| `images`        | array  | Attached images (URLs)  |
| `local_images`  | array  | Local image paths       |
| `text_elements` | array  | Text attachments        |

### Subtype: `agent_message`

```json
{
  "timestamp": "2026-01-21T20:17:42.030Z",
  "type": "event_msg",
  "payload": {
    "type": "agent_message",
    "message": "hi"
  }
}
```

**Note:** This is a duplicate of the assistant `response_item` content. FlightPath uses `response_item` events, not `agent_message`.

**Parsing:**

```typescript
// CodexLogParser.extractContentFromEvent()
if (
  event.type === "event_msg" &&
  event.payload?.type === "agent_message" &&
  event.payload.message
) {
  return event.payload.message;
}
```

### Subtype: `token_count`

See [Token Usage](#token-usage) section below.

### Subtype: `turn.completed`

See [Completion Detection](#completion-detection) section below.

---

## Token Usage

### Event Type: `event_msg` (type: token_count)

**Description:** Token usage statistics emitted during and after response generation.

**Occurrence:** Multiple times per turn (initial, intermediate, final)

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:42.031Z",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 3655,
        "cached_input_tokens": 0,
        "output_tokens": 7,
        "reasoning_output_tokens": 0,
        "total_tokens": 3662
      },
      "last_token_usage": {
        "input_tokens": 3655,
        "cached_input_tokens": 0,
        "output_tokens": 7,
        "reasoning_output_tokens": 0,
        "total_tokens": 3662
      },
      "model_context_window": 258400
    },
    "rate_limits": {
      "primary": null,
      "secondary": null,
      "credits": null,
      "plan_type": null
    }
  }
}
```

### Token Usage Fields

| Field                     | Type   | Description                           |
| ------------------------- | ------ | ------------------------------------- |
| `info.total_token_usage`  | object | Cumulative tokens for entire session  |
| `info.last_token_usage`   | object | Tokens for last turn only             |
| `input_tokens`            | number | Prompt tokens sent to model           |
| `cached_input_tokens`     | number | Cached tokens (not charged)           |
| `output_tokens`           | number | Response tokens generated             |
| `reasoning_output_tokens` | number | Tokens used for reasoning/thinking    |
| `total_tokens`            | number | Sum of input + output tokens          |
| `model_context_window`    | number | Maximum context window size           |
| `rate_limits`             | object | Rate limit information (usually null) |

### Usage in FlightPath

Token statistics are extracted and formatted for display:

```typescript
// CodexLogParser.formatStatistics()
formatStatistics(metadata: any): string {
  const parts: string[] = [];

  if (metadata.sessionId) {
    const displayId = metadata.sessionId.replace(/^thread_/, "thread_");
    parts.push(`Session: ${displayId.substring(0, 12)}`);
  }

  if (metadata.model) {
    parts.push(`Model: ${metadata.model}`);
  }

  if (metadata.usage) {
    const usage = metadata.usage;
    if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
      parts.push(`Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`);
    }
  }

  return parts.join(" | ");
}
```

**Example Output:**

```
Session: thread_abc | Model: gpt-5.1-codex | Tokens: 3655 in / 7 out
```

---

## Completion Detection

### Event Type: `event_msg` (type: turn.completed)

**Description:** Signals that the AI has finished responding and the turn is complete.

**Occurrence:** Once per turn (final event after all response_item events)

### Structure

```json
{
  "timestamp": "2026-01-21T20:17:42.031Z",
  "type": "event_msg",
  "payload": {
    "type": "turn.completed"
  }
}
```

**CRITICAL:** This is the **only reliable way** to detect completion in Codex logs.

### Detection Logic

```typescript
// CodexLogParser.isComplete()
isComplete(event: any): boolean {
  return (
    event.type === "event_msg" &&
    event.payload?.type === "turn.completed"
  );
}
```

### Completion Detection Strategy

**FlightPath uses two approaches:**

1. **Log File Polling** (Headless Mode)
   - Read new lines from log file incrementally
   - Check each event with `isComplete()`
   - When `turn.completed` found, extract final response

2. **Notify Hook** (Interactive Mode)
   - Codex CLI writes notification file when complete
   - Hook script receives session ID via stdin
   - FlightPath polls for notification file
   - See `CodexNotificationMonitor` implementation

**Notify Hook Configuration:**

```typescript
// CodexNotificationMonitor.buildHookConfig()
const tomlConfig = `notify=['node','${scriptPath}']`;
// Pass to Codex CLI via: codex --config "notify=['node','/path/to/hook.js']"
```

**Notify Hook Output:**

```json
{
  "sessionId": "019be234-a937-7a83-957a-5e6ca36cfa13",
  "timestamp": 1737489462031,
  "event": "notify"
}
```

---

## FlightPath Integration

### CodexLogParser Implementation

FlightPath's `CodexLogParser` class handles all Codex-specific log parsing:

**Key Methods:**

```typescript
export class CodexLogParser extends BaseLogParser {
  // Extract complete response from log events
  extractResponse(events: any[]): {
    text: string;
    toolCalls: any[];
    metadata: any;
  };

  // Check if event signals completion
  isComplete(event: any): boolean;

  // Discover session log file by prompt text or session ID
  discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null>;

  // Extract session ID from events
  extractSessionId(events: any[]): string | null;

  // Extract text content from single event (for streaming)
  extractContentFromEvent(event: any): string | undefined;

  // Format metadata into statistics string
  formatStatistics(metadata: any): string;

  // Process event for buffering (internal state management)
  processEvent(event: any): any | null;
}
```

### Integration Flow

**1. Session Discovery**

```typescript
const parser = new CodexLogParser();
const logPath = await parser.discoverSessionLog(
  "Implement feature X",
  new Date(),
  sessionId // Optional: fast path if resuming
);
```

**2. Incremental Reading**

```typescript
const events = await parser.readNewLines(logPath);
for (const event of events) {
  // Stream text content
  const text = parser.extractContentFromEvent(event);
  if (text) {
    outputChannel.append(text);
  }

  // Check for completion
  if (parser.isComplete(event)) {
    break;
  }
}
```

**3. Final Response Extraction**

```typescript
const allEvents = await parser.readNewLines(logPath);
const response = parser.extractResponse(allEvents);

console.log("Response:", response.text);
console.log("Tool Calls:", response.toolCalls);
console.log("Session ID:", response.metadata.sessionId);
console.log("Model:", response.metadata.model);
```

### Handling Two Tool Call Formats

**FlightPath's approach:**

```typescript
// Store both formats in toolCalls array
// Consumer is responsible for checking if input is string or object

const toolCall = response.toolCalls[0];

// Check if arguments is a string (function_call format)
if (typeof toolCall.input === "string") {
  const params = JSON.parse(toolCall.input);
  console.log("Command:", params.command);
} else {
  // Already an object (tool_use format)
  console.log("Command:", toolCall.input.command);
}
```

**Alternative: Normalize at parse time**

```typescript
// CodexLogParser could normalize to object format
if (event.payload?.type === "function_call") {
  toolCalls.push({
    name: event.payload.name,
    input: JSON.parse(event.payload.arguments), // Parse immediately
    id: event.payload.call_id,
  });
}
```

**Current Implementation:** FlightPath stores `arguments` as-is (string) to avoid parse errors. Consumers must handle both formats.

---

## Comparison with Claude & Copilot

### Structure Comparison

| Aspect                | Codex CLI                             | Claude CLI                                  | Copilot CLI                                |
| --------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| **File Format**       | JSONL                                 | JSONL                                       | JSONL                                      |
| **Directory**         | `~/.codex/sessions/YYYY/MM/DD/`       | `~/.claude/projects/<path>/<session>.jsonl` | `~/.copilot/session-state/<session>.jsonl` |
| **File Naming**       | `rollout-<timestamp>-<session>.jsonl` | `<session-id>.jsonl`                        | `<session-id>.jsonl`                       |
| **Index File**        | ❌ None                               | ❌ None                                     | ✅ `index.json`                            |
| **Event Structure**   | `{type, payload, timestamp}`          | `{type, message/content, timestamp}`        | `{type, data, id, parentId}`               |
| **Nested Payloads**   | ✅ Yes                                | ✅ Yes                                      | ❌ No (flat `data`)                        |
| **Session ID**        | `thread_xxx` or UUID                  | UUID                                        | UUID                                       |
| **Completion Signal** | `event_msg.turn.completed`            | `message_stop`                              | `turn.completed`                           |

### Tool Call Comparison

| Provider    | Format                  | Parameters Field | Type        |
| ----------- | ----------------------- | ---------------- | ----------- |
| **Codex A** | `content[].tool_use`    | `input`          | Object      |
| **Codex B** | `payload.function_call` | `arguments`      | **String!** |
| **Claude**  | `content[].tool_use`    | `input`          | Object      |
| **Copilot** | `data.tools[]`          | `parameters`     | Object      |

**Key Takeaway:** Only Codex's `function_call` format uses a JSON string for parameters. All others use objects.

### Reasoning Comparison

| Provider    | Format                                    | Visibility           |
| ----------- | ----------------------------------------- | -------------------- |
| **Codex**   | Inline `thinking` + encrypted `reasoning` | Encrypted by default |
| **Claude**  | Inline `thinking` content block           | Always visible       |
| **Copilot** | N/A (no reasoning blocks)                 | N/A                  |

### Discovery Comparison

| Provider    | Method                           | Complexity                      |
| ----------- | -------------------------------- | ------------------------------- |
| **Codex**   | Date directory + prompt matching | High (no index)                 |
| **Claude**  | Direct path (project-based)      | Low (session ID in filename)    |
| **Copilot** | Index file + session ID lookup   | Medium (requires index parsing) |

---

## Notes and Observations

### Date-Based Directory Structure

**Pros:**

- Natural log organization by date
- Easy manual browsing
- Automatic log rotation by day

**Cons:**

- Session discovery requires date calculation
- Cross-day sessions may be split (unclear)
- No central index for fast lookup

**FlightPath Strategy:**

- Fast path: If session ID known, search for matching filename
- Fallback: Calculate date directory, filter by mtime, match prompt text

### Session ID Formats

**Two formats observed:**

1. **UUID**: `019be234-a937-7a83-957a-5e6ca36cfa13`
2. **Thread**: `thread_abc123xyz789`

**Hypothesis:**

- UUID: New session format (recent Codex versions)
- Thread: Legacy format or specific to certain models

**FlightPath Handling:** Both formats treated identically. No special logic required.

### Encrypted Reasoning

**Purpose:** Privacy-preserving reasoning blocks.

**Decryption:** Not documented in Codex CLI. Likely requires OpenAI API keys or CLI credentials.

**FlightPath Approach:** Ignore encrypted reasoning. Focus on visible `thinking` blocks only.

### Tool Call Format Inconsistency

**Why two formats?**

Possible reasons:

1. **Model differences**: Different models use different formats
2. **Tool types**: Shell commands use `function_call`, file ops use `tool_use`
3. **Execution mode**: Interactive vs headless may affect format
4. **Migration**: Codex transitioning from old to new format

**FlightPath Strategy:** Support both formats unconditionally. Test with multiple models and scenarios.

### Token Caching

**Field:** `cached_input_tokens`

**Purpose:** Tokens reused from previous turns (not charged).

**Observation:** Usually 0 in logs, but can be significant in multi-turn sessions.

**FlightPath:** Display cached tokens separately in statistics output.

### Agent Message Duplication

**Observation:** `agent_message` events duplicate content from `response_item` events.

**Theory:** `agent_message` is a simplified view for UI rendering, while `response_item` contains full structured content.

**FlightPath:** Ignore `agent_message`. Use `response_item` for all text extraction.

### Turn Completion Reliability

**Critical:** `turn.completed` is the ONLY reliable completion signal.

**Alternatives that DON'T work:**

- ❌ Last `response_item` (may not be final)
- ❌ Token count event (can appear mid-turn)
- ❌ File modification time (unreliable timing)

**FlightPath:** Always wait for `turn.completed` before extracting final response.

---

## Parsing Best Practices

### 1. Handle Missing Fields Gracefully

```typescript
// ❌ BAD - will crash if payload is missing
const sessionId = event.payload.id;

// ✅ GOOD - safe navigation
const sessionId = event.payload?.id;
```

### 2. Accumulate Multi-Event Responses

```typescript
const textParts: string[] = [];

for (const event of events) {
  if (event.type === "response_item" && event.payload?.role === "assistant") {
    const content = event.payload.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "output_text" && item.text) {
          textParts.push(item.text);
        }
      }
    }
  }
}

const fullResponse = textParts.join("");
```

### 3. Support Both Tool Call Formats

```typescript
// Format A: tool_use
if (item.type === "tool_use") {
  toolCalls.push({
    name: item.name,
    input: item.input, // Object
    id: item.id,
  });
}

// Format B: function_call
if (event.payload?.type === "function_call") {
  toolCalls.push({
    name: event.payload.name,
    input: event.payload.arguments, // String - parse later
    id: event.payload.call_id,
  });
}
```

### 4. Cache Session Metadata

```typescript
private sessionMeta: any = null;

extractResponse(events: any[]) {
  for (const event of events) {
    if (event.type === "session_meta") {
      this.sessionMeta = event.payload; // Cache for later
    }
  }

  // Fallback to cached value if not in current events
  const sessionId = /* extract from events */ || this.sessionMeta?.id;
}
```

### 5. Use Retry with Backoff for Discovery

```typescript
// Codex writes log file asynchronously
const logPath = await retryWithBackoff(
  async () => {
    const files = fs.readdirSync(datePath);
    const match = files.find((f) => f.endsWith(`-${sessionId}.jsonl`));

    if (match) {
      const stats = fs.statSync(path.join(datePath, match));
      if (stats.mtime >= startTime) {
        return path.join(datePath, match); // Success
      }
    }

    return null; // Retry
  },
  { maxAttempts: 14, totalTimeMs: 10000 }
);
```

---

## Test Coverage

FlightPath includes comprehensive tests for `CodexLogParser`:

**Test File:** `src/test/suite/cli/LogParsers.test.ts`

**Test Suites:**

1. **extractResponse**
   - Session metadata extraction
   - Nested payload parsing
   - Tool calls (both formats)
   - Reasoning blocks
   - Thread session IDs
   - Missing fields handling
   - Multi-event aggregation
   - Metadata caching

2. **isComplete**
   - `turn.completed` detection
   - False positives rejection
   - Missing field handling

3. **extractSessionId**
   - Thread ID format
   - Multiple session_meta events
   - Null cases
   - Missing fields

4. **readNewLines**
   - Incremental reading
   - Empty file handling
   - Append detection

5. **Date-based directories**
   - YYYY/MM/DD format validation
   - Filename parsing

**Run Tests:**

```bash
npm test -- --grep "CodexLogParser"
```

---

## Additional Resources

### Related Documentation

- **Codex CLI Provider**: `src/flightpath/harness/codex/CodexCliProvider.ts`
- **Response Parser**: `src/flightpath/harness/codex/CodexResponseParser.ts`
- **Notification Monitor**: `src/flightpath/harness/codex/CodexNotificationMonitor.ts`
- **Tool Permission Mapper**: `src/flightpath/harness/codex/CodexToolPermissionMapper.ts`
- **Adding New Providers**: `docs/ADDING_NEW_CLI_PROVIDER.md`

### FlightPath Architecture

- **CLI Integration Guide**: `docs/COPILOT_CLI_DESIGN.md`
- **Session Management**: `docs/SESSION_MANAGEMENT.md`
- **Workflow Properties**: `docs/WORKFLOW_PROPERTIES.md`

### Related Log Structures

- **Claude CLI Logs**: `docs/CLAUDE_CLI_LOG_STRUCTURE.md`
- **Copilot CLI Logs**: `docs/COPILOT_CLI_EVENT_STRUCTURE.md`

---

## Revision History

| Date       | Version | Changes                                                                 |
| ---------- | ------- | ----------------------------------------------------------------------- |
| 2026-01-21 | 1.0.0   | Initial documentation based on Codex CLI 0.87.0 and FlightPath codebase |

---

**End of Document**
