# Claude CLI Stream-JSON Output Format

**Research Date:** January 28, 2026
**Claude Code Version:** 2.1.23+
**Author:** Research conducted for FlightPath integration

## Executive Summary

Claude CLI's `--output-format stream-json` flag outputs newline-delimited JSON (NDJSON) with real-time streaming events. Each line is a complete JSON object representing different phases of the conversation: system initialization, streaming tokens, assistant messages, user tool results, and final completion statistics.

**Key Features:**

- NDJSON format (one JSON object per line)
- Real-time token-by-token streaming with `--include-partial-messages`
- Complete session metadata and token usage tracking
- Tool use and tool result events
- Session continuity via session_id

**Primary Use Cases:**

- Headless automation and CI/CD pipelines
- Stream chaining (piping output between Claude instances)
- Real-time response processing
- Token extraction and cost tracking
- Session management and resumption

---

## Command Line Usage

### Basic Stream-JSON Output

```bash
claude -p "Your prompt" --output-format stream-json --verbose
```

**Note:** `--verbose` flag is REQUIRED when using `--output-format=stream-json` in print mode.

### Include Partial Messages (Token Streaming)

```bash
claude -p "Your prompt" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

### Common Flags

| Flag                          | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `-p`, `--print`               | Non-interactive mode (required for stream-json)         |
| `--output-format stream-json` | Enable NDJSON streaming output                          |
| `--include-partial-messages`  | Include token-by-token streaming events                 |
| `--verbose`                   | Required for stream-json output                         |
| `--allowedTools`              | Auto-approve specific tools (e.g., `"Read,Write,Bash"`) |
| `--input-format stream-json`  | Accept NDJSON input for stream chaining                 |

---

## Message Types

The stream outputs 6 primary message types, each with `type` field:

### 1. System Message (`type: "system"`)

**Emitted:** Once at session start
**Purpose:** Session initialization with metadata

```json
{
  "type": "system",
  "subtype": "init",
  "uuid": "08c9ca4c-741f-40d6-be6d-d1a81b225a5c",
  "session_id": "1acb40d9-8de6-4248-ac7b-29a06b3a2da3",
  "cwd": "C:\\dev\\FlightPath",
  "tools": ["Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", ...],
  "mcp_servers": [],
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "acceptEdits",
  "slash_commands": ["compact", "context", "cost", ...],
  "apiKeySource": "none",
  "claude_code_version": "2.1.23",
  "output_style": "default",
  "agents": ["Bash", "general-purpose", ...],
  "skills": ["keybindings-help"],
  "plugins": []
}
```

**Key Fields:**

- `session_id` - UUID for session continuity (use with `--resume`)
- `tools` - Available built-in tools for this session
- `model` - Active Claude model
- `permissionMode` - Current permission level
- `mcp_servers` - Connected MCP server statuses

---

### 2. Stream Event Messages (`type: "stream_event"`)

**Emitted:** Only when `--include-partial-messages` is enabled
**Purpose:** Real-time token streaming and incremental updates

#### Event Types

##### a. `message_start`

**Purpose:** Beginning of new assistant response

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "model": "claude-sonnet-4-5-20250929",
      "id": "msg_01AYLcuEpUYgkjEUAymydKur",
      "type": "message",
      "role": "assistant",
      "content": [],
      "stop_reason": null,
      "stop_sequence": null,
      "usage": {
        "input_tokens": 3,
        "cache_creation_input_tokens": 12069,
        "cache_read_input_tokens": 19064,
        "output_tokens": 2
      }
    }
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "0b314d2e-de3a-498b-94b5-8097dfa46c42"
}
```

##### b. `content_block_start`

**Purpose:** Start of new content block (text or tool use)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": {
      "type": "text",
      "text": ""
    }
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "022c33fd-9a9a-4b65-b25e-300320e6f30a"
}
```

**For Tool Use:**

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "toolu_011pN8ReJMeSkzpBvYzod1gT",
      "name": "Write",
      "input": {}
    }
  }
}
```

##### c. `content_block_delta`

**Purpose:** Incremental token/JSON updates

**Text Delta:**

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "text_delta",
      "text": "Fingers"
    }
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "2807484c-6fc0-4314-87a3-ac813070d9bb"
}
```

**Tool Input JSON Delta:**

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 1,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\"file_path\": \"C:\\\\dev\\\\FlightPath\\\\test.txt\""
    }
  }
}
```

##### d. `content_block_stop`

**Purpose:** End of content block

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_stop",
    "index": 0
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "e306390a-2891-40b4-a6b0-d317c55622c1"
}
```

##### e. `message_delta`

**Purpose:** Message metadata updates (stop reason, final usage)

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": {
      "stop_reason": "end_turn",
      "stop_sequence": null
    },
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 12069,
      "cache_read_input_tokens": 19064,
      "output_tokens": 21
    },
    "context_management": {
      "applied_edits": []
    }
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "5c83bb28-c696-48e1-97c7-9b995437e7a3"
}
```

**Stop Reasons:**

- `"end_turn"` - Natural completion
- `"tool_use"` - Stopped to invoke tool
- `"max_tokens"` - Token limit reached
- `"stop_sequence"` - Stop sequence matched

##### f. `message_stop`

**Purpose:** End of message streaming

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_stop"
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "89d0ebd6-f362-49f9-b6c3-0c55666893c1"
}
```

---

### 3. Assistant Message (`type: "assistant"`)

**Emitted:** After each assistant response completes
**Purpose:** Complete assistant response with all content blocks

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_01QrpTGEANwo88xeQCu58G95",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "2 + 2 = 4"
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 31134,
      "cache_read_input_tokens": 0,
      "output_tokens": 1,
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 31134
      }
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "1acb40d9-8de6-4248-ac7b-29a06b3a2da3",
  "uuid": "34de804b-4be8-4456-b841-754354df734f"
}
```

**Content Block Types:**

**Text Block:**

```json
{
  "type": "text",
  "text": "Response text here"
}
```

**Tool Use Block:**

```json
{
  "type": "tool_use",
  "id": "toolu_011pN8ReJMeSkzpBvYzod1gT",
  "name": "Write",
  "input": {
    "file_path": "C:\\dev\\FlightPath\\test.txt",
    "content": "hello world"
  }
}
```

---

### 4. User Message (`type: "user"`)

**Emitted:** After tool execution completes
**Purpose:** Tool results returned to Claude

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_011pN8ReJMeSkzpBvYzod1gT",
        "type": "tool_result",
        "content": "File created successfully at: C:\\dev\\FlightPath\\test.txt"
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "9b8c43dd-142e-4f9e-8d4e-ee61a0c56a0f",
  "uuid": "7b1257af-b10b-4da0-b64d-cdc2576e7916",
  "tool_use_result": {
    "type": "create",
    "filePath": "C:\\dev\\FlightPath\\test.txt",
    "content": "hello world",
    "structuredPatch": [],
    "originalFile": null
  }
}
```

**Key Fields:**

- `tool_use_id` - Matches the assistant's tool_use block
- `content` - Tool execution result (string)
- `tool_use_result` - Structured metadata about the tool execution

---

### 5. Result Message (`type: "result"`)

**Emitted:** Once at end of conversation
**Purpose:** Final statistics and completion status

#### Success Result

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3082,
  "duration_api_ms": 2977,
  "num_turns": 1,
  "result": "2 + 2 = 4",
  "session_id": "1acb40d9-8de6-4248-ac7b-29a06b3a2da3",
  "total_cost_usd": 0.11695649999999999,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 31134,
    "cache_read_input_tokens": 0,
    "output_tokens": 13,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 31134,
      "ephemeral_5m_input_tokens": 0
    }
  },
  "modelUsage": {
    "claude-sonnet-4-5-20250929": {
      "inputTokens": 3,
      "outputTokens": 13,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 31134,
      "webSearchRequests": 0,
      "costUSD": 0.11695649999999999,
      "contextWindow": 200000,
      "maxOutputTokens": 64000
    }
  },
  "permission_denials": [],
  "uuid": "d335aa6d-efd1-4b44-8172-77b8cbd21df5"
}
```

#### Error Result Subtypes

**Error Max Turns:**

```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "is_error": true,
  "errors": ["Maximum turns exceeded"]
}
```

**Error During Execution:**

```json
{
  "type": "result",
  "subtype": "error_during_execution",
  "is_error": true,
  "errors": ["Error message here"]
}
```

**Error Max Budget:**

```json
{
  "type": "result",
  "subtype": "error_max_budget_usd",
  "is_error": true,
  "errors": ["Budget exceeded"]
}
```

---

### 6. Compact Boundary Message (`type: "system"`, `subtype: "compact_boundary"`)

**Emitted:** When conversation is compacted (manual or auto)
**Purpose:** Marks where conversation history was summarized

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": "1acb40d9-8de6-4248-ac7b-29a06b3a2da3",
  "compact_metadata": {
    "trigger": "auto",
    "pre_tokens": 50000
  }
}
```

---

## Streaming Event Sequence

### Simple Text Response

```
1. system (init)
2. stream_event (message_start)
3. stream_event (content_block_start, index=0, type=text)
4. stream_event (content_block_delta, text_delta) [repeated for each token]
5. assistant (complete message)
6. stream_event (content_block_stop, index=0)
7. stream_event (message_delta, stop_reason=end_turn)
8. stream_event (message_stop)
9. result (success)
```

### Tool Use Response

```
1. system (init)
2. stream_event (message_start)
3. stream_event (content_block_start, index=0, type=text)
4. stream_event (content_block_delta, text_delta) [thinking text]
5. assistant (complete message with text)
6. stream_event (content_block_stop, index=0)
7. stream_event (content_block_start, index=1, type=tool_use)
8. stream_event (content_block_delta, input_json_delta) [repeated for JSON]
9. assistant (complete message with tool_use)
10. stream_event (content_block_stop, index=1)
11. stream_event (message_delta, stop_reason=tool_use)
12. stream_event (message_stop)
13. user (tool_result)
14. stream_event (message_start) [next turn]
15. ... [assistant processes result]
16. result (success)
```

---

## Token Usage and Cost Tracking

### Usage Object Structure

```typescript
{
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier: "standard";
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
}
```

### Per-Model Usage

The `result` message includes `modelUsage` with per-model breakdown:

```typescript
modelUsage: {
  "claude-sonnet-4-5-20250929": {
    inputTokens: 3,
    outputTokens: 13,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 31134,
    webSearchRequests: 0,
    costUSD: 0.11695649999999999,
    contextWindow: 200000,
    maxOutputTokens: 64000
  }
}
```

---

## Session Management

### Session ID Lifecycle

1. **New Session**: System message includes new `session_id` (UUID)
2. **Capture Session**: Extract from system or result message
3. **Resume Session**: Use `--resume <session_id>` flag

### Resuming Sessions

```bash
# Capture session ID
session_id=$(claude -p "Start task" --output-format json | jq -r '.session_id')

# Resume later
claude -p "Continue task" --resume "$session_id" --output-format stream-json --verbose
```

### Session Continuity

- `session_id` persists across all messages in a conversation
- Same session ID appears in system, assistant, user, stream_event, and result messages
- Sessions survive process restarts (stored in `~/.claude/sessions/`)

---

## Practical Usage Examples

### Extract Text Content Only

```bash
claude -p "Write a haiku" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  | jq -j '.event.delta.text? // empty'
```

**Output:**

```
Fingers dance on keys,
Logic flows through silent lines—
Bug becomes feature.
```

### Extract Final Result

```bash
claude -p "Calculate 123 * 456" \
  --output-format json \
  | jq -r '.result'
```

**Output:**

```
56088
```

### Get Session Statistics

```bash
claude -p "Analyze code" \
  --output-format json \
  | jq '{
      session_id,
      duration_ms,
      num_turns,
      total_cost_usd,
      usage
    }'
```

### Stream Chaining

```bash
claude -p "Analyze codebase" \
  --output-format stream-json \
  | claude -p "Summarize the analysis" \
      --input-format stream-json \
      --output-format stream-json
```

### Monitor Token Streaming

```bash
claude -p "Explain quantum computing" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  | jq -c 'select(.type == "stream_event" and .event.type == "content_block_delta")'
```

---

## TypeScript Type Definitions

### Official SDK Types

The official `@anthropic-ai/claude-agent-sdk` package provides complete TypeScript types:

```typescript
import { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage;

interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  cwd: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  apiKeySource: string;
  claude_code_version: string;
  agents: string[];
  skills: string[];
  plugins: string[];
}

interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: RawMessageStreamEvent; // From Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

interface SDKAssistantMessage {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: {
    model: string;
    id: string;
    role: "assistant";
    content: Array<TextBlock | ToolUseBlock>;
    stop_reason: string | null;
    usage: Usage;
  };
  parent_tool_use_id: string | null;
}

interface SDKResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_max_turns"
    | "error_during_execution"
    | "error_max_budget_usd";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result?: string;
  session_id: string;
  total_cost_usd: number;
  usage: Usage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: Array<PermissionDenial>;
  errors?: string[];
  uuid: string;
}
```

### Stream Event Types

```typescript
type RawMessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: [];
    stop_reason: null;
    usage: Usage;
  };
}

interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: TextBlock | ToolUseBlock;
}

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: TextDelta | InputJsonDelta;
}

interface TextDelta {
  type: "text_delta";
  text: string;
}

interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: string;
    stop_sequence: string | null;
  };
  usage: Usage;
  context_management?: {
    applied_edits: Array<any>;
  };
}

interface MessageStopEvent {
  type: "message_stop";
}
```

---

## Parsing Best Practices

### NDJSON Parsing

Each line is a complete, independent JSON object:

```typescript
import { createInterface } from "readline";
import { createReadStream } from "fs";

const rl = createInterface({
  input: createReadStream("output.ndjson"),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const message: SDKMessage = JSON.parse(line);

  switch (message.type) {
    case "system":
      console.log("Session:", message.session_id);
      break;
    case "stream_event":
      if (message.event.type === "content_block_delta") {
        process.stdout.write(message.event.delta.text || "");
      }
      break;
    case "result":
      console.log("\nCost:", message.total_cost_usd);
      break;
  }
}
```

### Real-Time Stream Processing

```typescript
import { spawn } from "child_process";
import { createInterface } from "readline";

const claude = spawn("claude", [
  "-p",
  "Your prompt",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
]);

const rl = createInterface({
  input: claude.stdout,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  const message = JSON.parse(line);

  if (
    message.type === "stream_event" &&
    message.event.type === "content_block_delta" &&
    message.event.delta.type === "text_delta"
  ) {
    // Real-time token streaming
    process.stdout.write(message.event.delta.text);
  }
}
```

### Error Handling

```typescript
for await (const line of rl) {
  try {
    const message: SDKMessage = JSON.parse(line);

    if (message.type === "result" && message.is_error) {
      console.error("Errors:", message.errors);
      process.exit(1);
    }
  } catch (err) {
    console.error("Failed to parse JSON:", line);
  }
}
```

---

## Differences Between Output Formats

### `--output-format text` (Default)

- Plain text output only
- Human-readable format
- No metadata or statistics
- Not machine-parseable

### `--output-format json`

- Single JSON object after completion
- Includes complete result and metadata
- No streaming events
- Best for simple automation

**Example:**

```json
{
  "type": "result",
  "result": "2 + 2 = 4",
  "session_id": "...",
  "total_cost_usd": 0.116,
  "usage": { ... }
}
```

### `--output-format stream-json`

- NDJSON format (one object per line)
- Real-time streaming with `--include-partial-messages`
- Complete conversation history
- Best for advanced automation and monitoring

---

## Known Limitations and Gotchas

### 1. Verbose Flag Required

```bash
# ERROR: Missing verbose flag
claude -p "test" --output-format stream-json

# CORRECT
claude -p "test" --output-format stream-json --verbose
```

### 2. Partial Messages Only in Print Mode

`--include-partial-messages` only works with `-p` (print mode):

```bash
# Won't get partial messages
claude --output-format stream-json --include-partial-messages

# CORRECT
claude -p "test" --output-format stream-json --include-partial-messages --verbose
```

### 3. No Interactive Session Persistence

Sessions created with `-p` are not saved unless explicitly configured:

```bash
# Session NOT saved
claude -p "test" --output-format stream-json --verbose

# Session IS saved
claude -p "test" --output-format stream-json --verbose
# (sessions are saved by default, but --no-session-persistence disables)
```

### 4. Large Output Buffering

NDJSON output can be buffered by the OS. For truly real-time streaming, use `stdbuf`:

```bash
stdbuf -oL claude -p "test" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

### 5. Windows Path Escaping

Tool use JSON includes escaped Windows paths:

```json
{
  "file_path": "C:\\\\dev\\\\FlightPath\\\\test.txt"
}
```

---

## Integration with FlightPath

### Current Implementation (Codex CLI)

FlightPath's `CodexCliProvider` uses JSONL events with notify hook:

```typescript
// FlightPath currently uses this for Codex CLI
const events = output
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
```

### Proposed Claude CLI Integration

Similar architecture with stream-json:

```typescript
interface ClaudeStreamParser {
  parseStream(output: string): SDKMessage[];
  extractTokens(messages: SDKMessage[]): string;
  getSessionId(messages: SDKMessage[]): string;
  getFinalResult(messages: SDKMessage[]): SDKResultMessage;
}

class ClaudeResponseParser implements IResponseParser {
  parseResponse(output: string): ParsedResponse {
    const messages = output
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SDKMessage);

    const systemMsg = messages.find((m) => m.type === "system");
    const resultMsg = messages.find(
      (m) => m.type === "result"
    ) as SDKResultMessage;

    return {
      content: resultMsg?.result || "",
      sessionId: systemMsg?.session_id || null,
      usage: resultMsg?.usage,
      cost: resultMsg?.total_cost_usd,
    };
  }

  parseStreamingChunk(chunk: string): StreamChunk {
    const message = JSON.parse(chunk) as SDKMessage;

    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
    ) {
      return { text: message.event.delta.text };
    }

    return { text: "" };
  }
}
```

---

## References and Sources

### Official Documentation

- [Claude Code - Run Programmatically](https://code.claude.com/docs/en/headless)
- [Claude Code - CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Agent SDK - TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude API - Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

### Community Resources

- [Stream-JSON Chaining - ruvnet/claude-flow Wiki](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [How to Extract Text from Claude Code JSON Stream](https://www.ytyng.com/en/blog/claude-stream-json-jq/)
- [Claude Code CLI Cheatsheet - Shipyard](https://shipyard.build/blog/claude-code-cheat-sheet/)
- [CLAUDE_AGENT_SDK_SPEC.md - GitHub Gist](https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417)

### TypeScript SDKs

- [Official: @anthropic-ai/claude-agent-sdk](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Community: instantlyeasy/claude-code-sdk-ts](https://github.com/instantlyeasy/claude-code-sdk-ts)
- [Community: constellos/claude-code-plugins](https://github.com/constellos/claude-code-plugins)

### Related Topics

- [Claude Code - GitHub Actions](https://code.claude.com/docs/en/github-actions)
- [Claude Code - Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude Code - Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

---

## Appendix: Complete Example Output

### Simple Text Response (with partial messages)

```jsonl
{"type":"system","subtype":"init","cwd":"C:\\dev","session_id":"abc123","tools":["Bash","Read","Write"],"model":"claude-sonnet-4-5-20250929","permissionMode":"acceptEdits","uuid":"uuid1"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":1}}},"session_id":"abc123","uuid":"uuid2"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"abc123","uuid":"uuid3"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}},"session_id":"abc123","uuid":"uuid4"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}},"session_id":"abc123","uuid":"uuid5"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}},"session_id":"abc123","uuid":"uuid6"}
{"type":"assistant","message":{"id":"msg_01","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[{"type":"text","text":"Hello world!"}],"usage":{"input_tokens":5,"output_tokens":3}},"session_id":"abc123","uuid":"uuid7"}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"abc123","uuid":"uuid8"}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}},"session_id":"abc123","uuid":"uuid9"}
{"type":"stream_event","event":{"type":"message_stop"},"session_id":"abc123","uuid":"uuid10"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":1,"result":"Hello world!","session_id":"abc123","total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":3},"uuid":"uuid11"}
```

---

**Document Version:** 1.0
**Last Updated:** January 28, 2026
**Tested With:** Claude Code v2.1.23, claude-sonnet-4-5-20250929
