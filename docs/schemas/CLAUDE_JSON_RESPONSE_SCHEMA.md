# Claude CLI Stream-JSON Output Schema Reference

## Overview

**Output Format**: NDJSON (Newline-Delimited JSON) - one JSON object per line

**Trigger Flags**: `--output-format stream-json --verbose`

**Purpose**: Real-time streaming responses with complete session metadata, token statistics, and tool execution tracking

**Primary Use Cases**:
- Headless automation and CI/CD pipelines
- Stream chaining (piping output between Claude instances)
- Real-time token-by-token response processing
- Token extraction and cost tracking
- Session management and resumption

**When This Format is Used**:
- Headless mode with `--output-format stream-json` flag
- Print mode (`-p` flag) required for streaming
- `--verbose` flag is REQUIRED
- `--include-partial-messages` for token-by-token streaming (optional)

---

## Message Type Summary

| Message Type | Frequency | Description | When Emitted |
|--------------|-----------|-------------|--------------|
| `system` | 1 (per session) | Session initialization with metadata | Session start |
| `stream_event` | Varies | Real-time streaming events (6 subtypes) | Only with `--include-partial-messages` |
| `assistant` | Per response | Complete assistant response with content blocks | After each assistant response |
| `user` | Per tool | User messages and tool results | After tool execution |
| `result` | 1 (per session) | Final statistics and completion status | Session end |
| `compact_boundary` | As needed | Conversation compaction marker | When conversation is compacted |

**Total Message Types**: 6

---

## Common Fields

All messages share some common top-level fields:

```typescript
interface BaseMessage {
  type: string;                      // Message type discriminator
  uuid: string;                      // Unique message identifier (UUID)
  session_id: string;                // Session UUID (present in most messages)
  parent_tool_use_id: string | null; // Parent tool use ID if nested
}
```

---

## Message Type Schemas

### 1. System Message (`type: "system"`)

**Emitted**: Once at session start
**Purpose**: Session initialization with complete metadata
**Frequency**: 1 per session

**Fields**:
```typescript
interface SystemMessage {
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  cwd: string;                       // Working directory path
  tools: string[];                   // Available built-in tools
  mcp_servers: MCPServer[];          // Connected MCP servers
  model: string;                     // Active Claude model
  permissionMode: PermissionMode;    // Current permission level
  slash_commands: string[];          // Available slash commands
  apiKeySource: string;              // API key source ("none" for default)
  claude_code_version: string;       // CLI version (e.g., "2.1.23")
  output_style: string;              // Output style setting
  agents: string[];                  // Available agents
  skills: string[];                  // Available skills
  plugins: string[];                 // Loaded plugins
}

interface MCPServer {
  name: string;
  status: string;                    // Connection status
}

type PermissionMode =
  | "acceptEdits"
  | "dangerouslySkipPermissions"
  | "allowAll"
  | "custom";
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `type` | string | Always `"system"` | Always | `"system"` |
| `subtype` | string | Always `"init"` | Always | `"init"` |
| `uuid` | string | Unique message ID | Always | `"08c9ca4c-741f-40d6-be6d-d1a81b225a5c"` |
| `session_id` | string | Session UUID for resumption | Always | `"1acb40d9-8de6-4248-ac7b-29a06b3a2da3"` |
| `cwd` | string | Current working directory | Always | `"C:\\dev\\FlightPath"` |
| `tools` | array | Available built-in tools | Always | `["Task", "Bash", "Read", "Write", ...]` |
| `mcp_servers` | array | Connected MCP servers | Always | `[]` or `[{name: "github", status: "connected"}]` |
| `model` | string | Active Claude model ID | Always | `"claude-sonnet-4-5-20250929"` |
| `permissionMode` | string | Permission level | Always | `"acceptEdits"` |
| `slash_commands` | array | Available slash commands | Always | `["compact", "context", "cost", ...]` |
| `apiKeySource` | string | API key source | Always | `"none"` |
| `claude_code_version` | string | CLI version | Always | `"2.1.23"` |
| `output_style` | string | Output style setting | Always | `"default"` |
| `agents` | array | Available agents | Always | `["Bash", "general-purpose", ...]` |
| `skills` | array | Available skills | Always | `["keybindings-help"]` |
| `plugins` | array | Loaded plugins | Always | `[]` |

**Example**:
```json
{
  "type": "system",
  "subtype": "init",
  "uuid": "08c9ca4c-741f-40d6-be6d-d1a81b225a5c",
  "session_id": "1acb40d9-8de6-4248-ac7b-29a06b3a2da3",
  "cwd": "C:\\dev\\FlightPath",
  "tools": ["Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  "mcp_servers": [],
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "acceptEdits",
  "slash_commands": ["compact", "context", "cost"],
  "apiKeySource": "none",
  "claude_code_version": "2.1.23",
  "output_style": "default",
  "agents": ["Bash", "general-purpose"],
  "skills": ["keybindings-help"],
  "plugins": []
}
```

---

### 2. Stream Event Messages (`type: "stream_event"`)

**Emitted**: Only when `--include-partial-messages` flag is used
**Purpose**: Real-time token streaming and incremental updates
**Frequency**: Varies (hundreds per response with partial messages)

**Base Structure**:
```typescript
interface StreamEventMessage {
  type: "stream_event";
  event: RawMessageStreamEvent;      // Event payload (6 subtypes)
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
}

type RawMessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;
```

#### 2a. Message Start Event (`event.type: "message_start"`)

**Purpose**: Beginning of new assistant response
**Contains**: Initial message metadata and usage statistics

```typescript
interface MessageStartEvent {
  type: "message_start";
  message: {
    model: string;                   // Model ID
    id: string;                      // Message ID
    type: "message";
    role: "assistant";
    content: [];                     // Empty at start
    stop_reason: null;
    stop_sequence: null;
    usage: UsageStats;               // Initial token usage
  };
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `message.model` | string | Model identifier | Always | `"claude-sonnet-4-5-20250929"` |
| `message.id` | string | Message ID | Always | `"msg_01AYLcuEpUYgkjEUAymydKur"` |
| `message.role` | string | Always `"assistant"` | Always | `"assistant"` |
| `message.content` | array | Empty array at start | Always | `[]` |
| `message.stop_reason` | null | Always null at start | Always | `null` |
| `message.usage` | object | Initial token statistics | Always | (see UsageStats) |

**Example**:
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

#### 2b. Content Block Start Event (`event.type: "content_block_start"`)

**Purpose**: Start of new content block (text or tool use)
**Contains**: Content block metadata and empty initial state

```typescript
interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;                     // Content block index
  content_block: TextBlock | ToolUseBlock;
}

interface TextBlock {
  type: "text";
  text: string;                      // Empty string at start
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;                        // Tool use ID
  name: string;                      // Tool name
  input: object;                     // Empty object at start
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `index` | number | Content block index (0-based) | Always | `0` |
| `content_block.type` | string | `"text"` or `"tool_use"` | Always | `"text"` |
| `content_block.text` | string | Empty at start (text blocks) | If text | `""` |
| `content_block.id` | string | Tool use ID (tool blocks) | If tool_use | `"toolu_011pN8ReJMeSkzpBvYzod1gT"` |
| `content_block.name` | string | Tool name (tool blocks) | If tool_use | `"Write"` |
| `content_block.input` | object | Empty at start (tool blocks) | If tool_use | `{}` |

**Example (Text Block)**:
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

**Example (Tool Use Block)**:
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
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "13f5e8c9-7a2b-4e5d-9c1f-8b3a7d6e9f2a"
}
```

#### 2c. Content Block Delta Event (`event.type: "content_block_delta"`)

**Purpose**: Incremental token/JSON updates (real-time streaming)
**Contains**: Text chunks or partial JSON for tool inputs

```typescript
interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;                     // Content block index
  delta: TextDelta | InputJsonDelta;
}

interface TextDelta {
  type: "text_delta";
  text: string;                      // Text chunk (can be single token)
}

interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;              // Partial JSON string
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `index` | number | Content block index | Always | `0` |
| `delta.type` | string | `"text_delta"` or `"input_json_delta"` | Always | `"text_delta"` |
| `delta.text` | string | Text chunk (text deltas) | If text_delta | `"Fingers"` |
| `delta.partial_json` | string | Partial JSON (tool deltas) | If input_json_delta | `"{\"file_path\": \""` |

**Example (Text Delta)**:
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

**Example (Tool Input JSON Delta)**:
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
  },
  "session_id": "5685b872-7a4a-4f90-b4f1-109813606c39",
  "parent_tool_use_id": null,
  "uuid": "3a7b8c9d-1e2f-4a5b-9c8d-7e6f5a4b3c2d"
}
```

#### 2d. Content Block Stop Event (`event.type: "content_block_stop"`)

**Purpose**: End of content block
**Contains**: Content block index only

```typescript
interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;                     // Content block index
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `index` | number | Content block index | Always | `0` |

**Example**:
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

#### 2e. Message Delta Event (`event.type: "message_delta"`)

**Purpose**: Message metadata updates (stop reason, final usage)
**Contains**: Stop reason and updated token statistics

```typescript
interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: string;             // Reason for stopping
    stop_sequence: string | null;    // Stop sequence if applicable
  };
  usage: UsageStats;                 // Updated token usage
  context_management?: {
    applied_edits: any[];
  };
}

type StopReason =
  | "end_turn"                       // Natural completion
  | "tool_use"                       // Stopped to invoke tool
  | "max_tokens"                     // Token limit reached
  | "stop_sequence";                 // Stop sequence matched
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `delta.stop_reason` | string | Reason for stopping | Always | `"end_turn"` |
| `delta.stop_sequence` | string \| null | Stop sequence matched | Always | `null` |
| `usage` | object | Updated token statistics | Always | (see UsageStats) |
| `context_management` | object | Context edits applied | Optional | `{applied_edits: []}` |

**Example**:
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

#### 2f. Message Stop Event (`event.type: "message_stop"`)

**Purpose**: End of message streaming
**Contains**: No additional data

```typescript
interface MessageStopEvent {
  type: "message_stop";
}
```

**Example**:
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

**Emitted**: After each assistant response completes
**Purpose**: Complete assistant response with all content blocks
**Frequency**: 1 per assistant response

**Fields**:
```typescript
interface AssistantMessage {
  type: "assistant";
  message: {
    model: string;                   // Model ID
    id: string;                      // Message ID
    type: "message";
    role: "assistant";
    content: AssistantContentBlock[]; // Array of content blocks
    stop_reason: string | null;      // Stop reason
    stop_sequence: string | null;    // Stop sequence if applicable
    usage: UsageStats;               // Token usage statistics
    context_management: any | null;  // Context management info
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

type AssistantContentBlock = TextBlock | ToolUseBlock;
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `message.model` | string | Model identifier | Always | `"claude-sonnet-4-5-20250929"` |
| `message.id` | string | Message ID | Always | `"msg_01QrpTGEANwo88xeQCu58G95"` |
| `message.role` | string | Always `"assistant"` | Always | `"assistant"` |
| `message.content` | array | Content blocks | Always | (see content blocks) |
| `message.stop_reason` | string \| null | Stop reason | Always | `"end_turn"` or `null` |
| `message.stop_sequence` | string \| null | Stop sequence matched | Always | `null` |
| `message.usage` | object | Token statistics | Always | (see UsageStats) |
| `message.context_management` | any \| null | Context management | Always | `null` |
| `parent_tool_use_id` | string \| null | Parent tool use ID | Always | `null` |
| `session_id` | string | Session UUID | Always | `"1acb40d9-..."` |
| `uuid` | string | Message UUID | Always | `"34de804b-..."` |

**Content Block Types**:

**Text Block**:
```typescript
interface TextBlock {
  type: "text";
  text: string;                      // Response text
}
```

**Tool Use Block**:
```typescript
interface ToolUseBlock {
  type: "tool_use";
  id: string;                        // Tool use ID
  name: string;                      // Tool name
  input: Record<string, any>;        // Tool-specific parameters
}
```

**Example (Text Response)**:
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
    "stop_reason": "end_turn",
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

**Example (Tool Use Response - Write)**:
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_01Abc123XYZ456",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "I'll create that file for you."
      },
      {
        "type": "tool_use",
        "id": "toolu_011pN8ReJMeSkzpBvYzod1gT",
        "name": "Write",
        "input": {
          "file_path": "C:\\dev\\FlightPath\\test.txt",
          "content": "hello world"
        }
      }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "usage": {
      "input_tokens": 10,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 5000,
      "output_tokens": 15,
      "service_tier": "standard"
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "9b8c43dd-142e-4f9e-8d4e-ee61a0c56a0f",
  "uuid": "7a3b5c8d-2e4f-9a1b-6c7d-3e8f4a5b2c1d"
}
```

**Example (Tool Use Response - Edit)**:
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "id": "msg_012VpPPeZ84kQ49GZ38ocULa",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Now I'll make the second edit:"
      },
      {
        "type": "tool_use",
        "id": "toolu_015FpibSjAnvkjEJv6GCSfc2",
        "name": "Edit",
        "input": {
          "replace_all": false,
          "file_path": "C:\\dev\\FlightPath\\temp_file.md",
          "old_string": "## Section 2\nMore text here.",
          "new_string": "## Section 2\nMore text here. (Second edit applied)"
        }
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 5,
      "cache_creation_input_tokens": 184,
      "cache_read_input_tokens": 31074,
      "output_tokens": 8,
      "service_tier": "standard"
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "9d19593c-7d8f-49a5-8634-f5ac12dbf538",
  "uuid": "83491aaa-3a51-45b8-8c28-a2dc1d1e560b"
}
```

**Note**: Edit tool input parameters (in assistant messages) use `old_string` and `new_string` (snake_case). However, tool results (in user messages) may use either `oldString`/`newString` (headless) or `old_string`/`new_string` (terminal).

---

### 4. User Message (`type: "user"`)

**Emitted**: After tool execution completes
**Purpose**: Tool results returned to Claude
**Frequency**: 1 per tool execution

**Fields**:
```typescript
interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultBlock[];      // Array of tool results
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
  tool_use_result?: ToolUseResult;   // Structured metadata
}

interface ToolResultBlock {
  tool_use_id: string;               // Matches assistant's tool_use ID
  type: "tool_result";
  content: string;                   // Tool execution result
}

interface ToolUseResult {
  type?: string;                     // Result type (e.g., "create", or omitted for edits)
  filePath?: string;                 // File path affected by operation
  content?: string;                  // File content (for Write operations)

  // Edit operation fields (dual format - both can appear)
  oldString?: string;                // Original text (Edit only) - headless mode
  newString?: string;                // Replacement text (Edit only) - headless mode
  old_string?: string;               // Original text (Edit only) - interactive terminal
  new_string?: string;               // Replacement text (Edit only) - interactive terminal

  originalFile?: string;             // Full file content before edit (Edit only)
  structuredPatch?: UnifiedDiffHunk[]; // Unified diff format (Edit only)
  userModified?: boolean;            // Whether user modified the edit
  replaceAll?: boolean;              // Whether replace_all was used
}

interface UnifiedDiffHunk {
  oldStart: number;                  // Starting line number in old file
  oldLines: number;                  // Number of lines in old file
  newStart: number;                  // Starting line number in new file
  newLines: number;                  // Number of lines in new file
  lines: string[];                   // Diff lines (prefixed with " ", "-", "+")
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `message.role` | string | Always `"user"` | Always | `"user"` |
| `message.content` | array | Tool result blocks | Always | (see ToolResultBlock) |
| `message.content[].tool_use_id` | string | Matches tool_use ID | Always | `"toolu_011pN..."` |
| `message.content[].type` | string | Always `"tool_result"` | Always | `"tool_result"` |
| `message.content[].content` | string | Tool output | Always | `"File created..."` |
| `tool_use_result` | object | Structured metadata with rich diff data | Optional | (see ToolUseResult) |
| `tool_use_result.filePath` | string | File path affected | If file op | `"C:\\dev\\..."` |
| `tool_use_result.oldString` | string | Text before edit (headless) | If Edit | `"old text"` |
| `tool_use_result.newString` | string | Text after edit (headless) | If Edit | `"new text"` |
| `tool_use_result.old_string` | string | Text before edit (terminal) | If Edit | `"old text"` |
| `tool_use_result.new_string` | string | Text after edit (terminal) | If Edit | `"new text"` |
| `tool_use_result.originalFile` | string | Full file before edit | If Edit | `"# File\n..."` |
| `tool_use_result.structuredPatch` | array | Unified diff hunks | If Edit | (see example) |
| `parent_tool_use_id` | string \| null | Parent tool use ID | Always | `null` |
| `session_id` | string | Session UUID | Always | `"9b8c43dd-..."` |
| `uuid` | string | Message UUID | Always | `"7b1257af-..."` |

**Note on Edit Field Format**: Claude CLI outputs Edit tool results with different field naming depending on execution mode:
- **Headless mode** (background process): Uses camelCase (`oldString`, `newString`)
- **Interactive terminal**: Uses snake_case (`old_string`, `new_string`)

Parsers should check **both formats** to ensure compatibility across all execution modes.

**Example (Write Result)**:
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

**Example (Edit Result with Diff Data)**:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_015FpibSjAnvkjEJv6GCSfc2",
        "type": "tool_result",
        "content": "The file C:\\dev\\FlightPath\\temp_file.md has been updated successfully."
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "9d19593c-7d8f-49a5-8634-f5ac12dbf538",
  "uuid": "0b0e74e7-c8e7-407c-bdce-a4b1f819f83d",
  "tool_use_result": {
    "filePath": "C:\\dev\\FlightPath\\temp_file.md",
    "oldString": "## Section 2\nMore text here.",
    "newString": "## Section 2\nMore text here. (Second edit applied)",
    "originalFile": "# Test File\n\nThis is the initial content of the test file. (First edit applied)\n\n## Section 1\nSome text here.\n\n## Section 2\nMore text here.\n",
    "structuredPatch": [
      {
        "oldStart": 6,
        "oldLines": 4,
        "newStart": 6,
        "newLines": 4,
        "lines": [
          " Some text here.",
          " ",
          " ## Section 2",
          "-More text here.",
          "+More text here. (Second edit applied)"
        ]
      }
    ],
    "userModified": false,
    "replaceAll": false
  }
}
```

**Note**: Edit operations provide rich diff data in `tool_use_result`:
- `oldString`/`newString`: The exact strings that were searched/replaced
- `originalFile`: Complete file content before the edit (useful for rendering full context)
- `structuredPatch`: Unified diff format showing changes with line numbers
  - Lines prefixed with " " are context (unchanged)
  - Lines prefixed with "-" were removed
  - Lines prefixed with "+" were added

---

### 5. Result Message (`type: "result"`)

**Emitted**: Once at end of conversation
**Purpose**: Final statistics and completion status
**Frequency**: 1 per session

**Fields**:
```typescript
interface ResultMessage {
  type: "result";
  subtype: ResultSubtype;
  is_error: boolean;
  duration_ms?: number;              // Total duration
  duration_api_ms?: number;          // API call duration
  num_turns?: number;                // Number of turns
  result?: string;                   // Final result text
  session_id: string;
  total_cost_usd?: number;           // Total cost in USD
  usage?: UsageStats;                // Aggregate usage
  modelUsage?: Record<string, ModelUsage>; // Per-model breakdown
  permission_denials?: PermissionDenial[];
  errors?: string[];                 // Error messages (if is_error)
  uuid: string;
}

type ResultSubtype =
  | "success"                        // Successful completion
  | "error_max_turns"                // Max turns exceeded
  | "error_during_execution"         // Execution error
  | "error_max_budget_usd";          // Budget exceeded

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface PermissionDenial {
  tool: string;
  reason: string;
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `subtype` | string | Result type | Always | `"success"` |
| `is_error` | boolean | Whether result is error | Always | `false` |
| `duration_ms` | number | Total duration (ms) | If success | `3082` |
| `duration_api_ms` | number | API duration (ms) | If success | `2977` |
| `num_turns` | number | Number of turns | If success | `1` |
| `result` | string | Final result text | If success | `"2 + 2 = 4"` |
| `session_id` | string | Session UUID | Always | `"1acb40d9-..."` |
| `total_cost_usd` | number | Total cost in USD | If success | `0.116956` |
| `usage` | object | Aggregate usage | If success | (see UsageStats) |
| `modelUsage` | object | Per-model breakdown | If success | (see ModelUsage) |
| `permission_denials` | array | Denied permissions | If success | `[]` |
| `errors` | array | Error messages | If error | `["Maximum turns exceeded"]` |
| `uuid` | string | Message UUID | Always | `"d335aa6d-..."` |

**Example (Success)**:
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

**Example (Error - Max Turns)**:
```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "is_error": true,
  "errors": ["Maximum turns exceeded"],
  "session_id": "abc123-def456-...",
  "uuid": "xyz789-uvw012-..."
}
```

**Example (Error - During Execution)**:
```json
{
  "type": "result",
  "subtype": "error_during_execution",
  "is_error": true,
  "errors": ["Tool execution failed: Permission denied"],
  "session_id": "abc123-def456-...",
  "uuid": "xyz789-uvw012-..."
}
```

---

### 6. Compact Boundary Message (`type: "system"`, `subtype: "compact_boundary"`)

**Emitted**: When conversation is compacted (manual or auto)
**Purpose**: Marks where conversation history was summarized
**Frequency**: As needed

**Fields**:
```typescript
interface CompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: "auto" | "manual";      // Compaction trigger
    pre_tokens: number;              // Tokens before compaction
  };
}
```

**Field Details**:

| Field | Type | Description | When Present | Example |
|-------|------|-------------|--------------|---------|
| `type` | string | Always `"system"` | Always | `"system"` |
| `subtype` | string | Always `"compact_boundary"` | Always | `"compact_boundary"` |
| `compact_metadata.trigger` | string | Trigger type | Always | `"auto"` |
| `compact_metadata.pre_tokens` | number | Tokens before compact | Always | `50000` |
| `session_id` | string | Session UUID | Always | `"1acb40d9-..."` |
| `uuid` | string | Message UUID | Always | `"550e8400-..."` |

**Example**:
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

## Shared Type Definitions

### Usage Statistics

```typescript
interface UsageStats {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier: string;              // "standard"
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
}
```

**Field Details**:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `input_tokens` | number | Input tokens consumed | `3` |
| `cache_creation_input_tokens` | number | Tokens used for cache creation | `31134` |
| `cache_read_input_tokens` | number | Tokens read from cache | `0` |
| `output_tokens` | number | Output tokens generated | `13` |
| `server_tool_use.web_search_requests` | number | Web search requests | `0` |
| `server_tool_use.web_fetch_requests` | number | Web fetch requests | `0` |
| `service_tier` | string | Service tier | `"standard"` |
| `cache_creation.ephemeral_1h_input_tokens` | number | 1-hour cache tokens | `31134` |
| `cache_creation.ephemeral_5m_input_tokens` | number | 5-minute cache tokens | `0` |

---

## Stream Event Sequence Examples

### Simple Text Response (with `--include-partial-messages`)

```
1. system (init) - Session initialization
2. stream_event (message_start) - Begin response
3. stream_event (content_block_start, index=0, type=text) - Start text block
4. stream_event (content_block_delta, text_delta="Hello") - Token 1
5. stream_event (content_block_delta, text_delta=" world") - Token 2
6. stream_event (content_block_delta, text_delta="!") - Token 3
7. stream_event (content_block_stop, index=0) - End text block
8. stream_event (message_delta, stop_reason=end_turn) - Metadata update
9. stream_event (message_stop) - End streaming
10. assistant (complete message with "Hello world!") - Full response
11. result (success) - Final statistics
```

### Tool Use Response (with `--include-partial-messages`)

```
1. system (init) - Session initialization
2. stream_event (message_start) - Begin response
3. stream_event (content_block_start, index=0, type=text) - Start thinking text
4. stream_event (content_block_delta, text_delta="I'll create that file") - Text tokens
5. stream_event (content_block_stop, index=0) - End text block
6. stream_event (content_block_start, index=1, type=tool_use) - Start tool block
7. stream_event (content_block_delta, input_json_delta="{\"file_path\"") - JSON chunk 1
8. stream_event (content_block_delta, input_json_delta=": \"test.txt\"") - JSON chunk 2
9. stream_event (content_block_stop, index=1) - End tool block
10. stream_event (message_delta, stop_reason=tool_use) - Stopped for tool
11. stream_event (message_stop) - End streaming
12. assistant (complete message with text + tool_use) - Full response
13. user (tool_result) - Tool execution result
14. stream_event (message_start) - Next turn begins
15. ... (assistant processes result)
16. result (success) - Final statistics
```

### Simple Response (without `--include-partial-messages`)

```
1. system (init) - Session initialization
2. assistant (complete message) - Full response
3. result (success) - Final statistics
```

---

## Usage Patterns

### Parsing NDJSON Stream

```typescript
import { createInterface } from 'readline';
import { createReadStream } from 'fs';

type SDKMessage =
  | SystemMessage
  | StreamEventMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | CompactBoundaryMessage;

async function parseStreamJson(filePath: string): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (line.trim()) {
      messages.push(JSON.parse(line) as SDKMessage);
    }
  }

  return messages;
}
```

### Extracting Session ID

```typescript
function extractSessionId(messages: SDKMessage[]): string | null {
  // Session ID is in system message
  const systemMsg = messages.find(m => m.type === 'system') as SystemMessage;
  return systemMsg?.session_id || null;
}

// Alternative: Extract from result message
function extractSessionIdFromResult(messages: SDKMessage[]): string | null {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;
  return resultMsg?.session_id || null;
}
```

### Real-Time Token Streaming

```typescript
import { spawn } from 'child_process';
import { createInterface } from 'readline';

async function streamTokens(prompt: string): Promise<void> {
  const claude = spawn('claude', [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose'
  ]);

  const rl = createInterface({
    input: claude.stdout,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const message = JSON.parse(line) as SDKMessage;

    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        // Real-time token output
        process.stdout.write(event.delta.text);
      }
    }
  }
}
```

### Detecting Completion

```typescript
function isSessionComplete(messages: SDKMessage[]): boolean {
  // Session is complete when result message is present
  return messages.some(m => m.type === 'result');
}

function getCompletionStatus(messages: SDKMessage[]): {
  complete: boolean;
  success: boolean;
  errors?: string[];
} {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;

  if (!resultMsg) {
    return { complete: false, success: false };
  }

  return {
    complete: true,
    success: !resultMsg.is_error,
    errors: resultMsg.errors
  };
}
```

### Extracting Final Result

```typescript
function extractFinalResult(messages: SDKMessage[]): string | null {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;
  return resultMsg?.result || null;
}

// Alternative: Concatenate all text from assistant messages
function extractAllAssistantText(messages: SDKMessage[]): string {
  const assistantMessages = messages.filter(m => m.type === 'assistant') as AssistantMessage[];

  return assistantMessages
    .flatMap(msg => msg.message.content)
    .filter(block => block.type === 'text')
    .map(block => (block as TextBlock).text)
    .join('\n');
}
```

### Token Usage Tracking

```typescript
function calculateTotalUsage(messages: SDKMessage[]): UsageStats | null {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;
  return resultMsg?.usage || null;
}

function calculateCostUSD(messages: SDKMessage[]): number {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;
  return resultMsg?.total_cost_usd || 0;
}

function getPerModelUsage(messages: SDKMessage[]): Record<string, ModelUsage> {
  const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;
  return resultMsg?.modelUsage || {};
}
```

---

## Integration with FlightPath

### ClaudeResponseParser Implementation

```typescript
import { IResponseParser, ParsedResponse, StreamChunk } from '../shared/interfaces/IResponseParser';

export class ClaudeResponseParser implements IResponseParser {
  parseResponse(output: string): ParsedResponse {
    const messages = this.parseNDJSON(output);

    const systemMsg = messages.find(m => m.type === 'system') as SystemMessage;
    const resultMsg = messages.find(m => m.type === 'result') as ResultMessage;

    return {
      content: resultMsg?.result || this.extractAssistantText(messages),
      sessionId: systemMsg?.session_id || resultMsg?.session_id || null,
      usage: resultMsg?.usage,
      cost: resultMsg?.total_cost_usd,
      isError: resultMsg?.is_error || false,
      errors: resultMsg?.errors
    };
  }

  parseStreamingChunk(chunk: string): StreamChunk {
    try {
      const message = JSON.parse(chunk) as SDKMessage;

      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          return { text: event.delta.text };
        }
      }

      return { text: '' };
    } catch {
      return { text: '' };
    }
  }

  private parseNDJSON(output: string): SDKMessage[] {
    return output
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as SDKMessage);
  }

  private extractAssistantText(messages: SDKMessage[]): string {
    const assistantMessages = messages.filter(m => m.type === 'assistant') as AssistantMessage[];

    return assistantMessages
      .flatMap(msg => msg.message.content)
      .filter(block => block.type === 'text')
      .map(block => (block as TextBlock).text)
      .join('\n');
  }
}
```

### Session ID Extraction

```typescript
// From system message (recommended - available immediately)
function extractSessionIdFromSystem(output: string): string | null {
  const lines = output.split('\n');
  const systemLine = lines.find(line => {
    try {
      const msg = JSON.parse(line);
      return msg.type === 'system' && msg.subtype === 'init';
    } catch {
      return false;
    }
  });

  if (systemLine) {
    const systemMsg = JSON.parse(systemLine) as SystemMessage;
    return systemMsg.session_id;
  }

  return null;
}

// From result message (fallback - only at end)
function extractSessionIdFromResult(output: string): string | null {
  const lines = output.split('\n');
  const resultLine = lines.find(line => {
    try {
      const msg = JSON.parse(line);
      return msg.type === 'result';
    } catch {
      return false;
    }
  });

  if (resultLine) {
    const resultMsg = JSON.parse(resultLine) as ResultMessage;
    return resultMsg.session_id;
  }

  return null;
}
```

### Completion Detection

```typescript
function detectCompletion(output: string): boolean {
  // Check for result message (final line indicator)
  const lines = output.split('\n').filter(line => line.trim());
  const lastLine = lines[lines.length - 1];

  try {
    const message = JSON.parse(lastLine) as SDKMessage;
    return message.type === 'result';
  } catch {
    return false;
  }
}

function waitForCompletion(
  onLine: (line: string) => void,
  onComplete: (success: boolean) => void
): void {
  let buffer = '';

  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      onLine(line);

      try {
        const message = JSON.parse(line) as SDKMessage;
        if (message.type === 'result') {
          onComplete(!message.is_error);
        }
      } catch {
        // Ignore parse errors
      }
    }
  };
}
```

---

## Differences from Other Formats

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

**Example**:
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
- **Used by FlightPath in headless mode**

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

### 3. Windows Path Escaping

Tool use JSON includes escaped Windows paths:

```json
{
  "file_path": "C:\\\\dev\\\\FlightPath\\\\test.txt"
}
```

### 4. Large Output Buffering

NDJSON output can be buffered by the OS. For truly real-time streaming, use `stdbuf`:

```bash
stdbuf -oL claude -p "test" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

### 5. No Interactive Session Persistence

Sessions created with `-p` are saved by default, but can be disabled with `--no-session-persistence`.

---

## Command Line Reference

### Basic Stream-JSON Output

```bash
claude -p "Your prompt" --output-format stream-json --verbose
```

### Include Partial Messages (Token Streaming)

```bash
claude -p "Your prompt" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

### Common Flags

| Flag | Description |
|------|-------------|
| `-p`, `--print` | Non-interactive mode (required for stream-json) |
| `--output-format stream-json` | Enable NDJSON streaming output |
| `--include-partial-messages` | Include token-by-token streaming events |
| `--verbose` | Required for stream-json output |
| `--allowedTools` | Auto-approve specific tools (e.g., `"Read,Write,Bash"`) |
| `--resume <session-id>` | Resume previous session |

---

## TypeScript Type Definitions (Complete)

```typescript
// Top-level discriminated union
type SDKMessage =
  | SystemMessage
  | StreamEventMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage
  | CompactBoundaryMessage;

// System message (session init)
interface SystemMessage {
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  cwd: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  model: string;
  permissionMode: "acceptEdits" | "dangerouslySkipPermissions" | "allowAll" | "custom";
  slash_commands: string[];
  apiKeySource: string;
  claude_code_version: string;
  output_style: string;
  agents: string[];
  skills: string[];
  plugins: string[];
}

// Stream event wrapper
interface StreamEventMessage {
  type: "stream_event";
  event: RawMessageStreamEvent;
  session_id: string;
  parent_tool_use_id: string | null;
  uuid: string;
}

// Stream event types
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
    usage: UsageStats;
  };
}

interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: "text"; text: "" } | { type: "tool_use"; id: string; name: string; input: {} };
}

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
}

interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    stop_sequence: string | null;
  };
  usage: UsageStats;
  context_management?: {
    applied_edits: any[];
  };
}

interface MessageStopEvent {
  type: "message_stop";
}

// Assistant message (complete response)
interface AssistantMessage {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: any }>;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: UsageStats;
    context_management: any | null;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// User message (tool results)
interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<{ tool_use_id: string; type: "tool_result"; content: string }>;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
  tool_use_result?: {
    type?: string;
    filePath?: string;
    content?: string;
    oldString?: string;           // Edit: original text (headless mode)
    newString?: string;           // Edit: replacement text (headless mode)
    old_string?: string;          // Edit: original text (interactive terminal)
    new_string?: string;          // Edit: replacement text (interactive terminal)
    structuredPatch?: any[];
    originalFile?: any;
  };
}

// Result message (final statistics)
interface ResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  is_error: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: UsageStats;
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  permission_denials?: Array<{ tool: string; reason: string }>;
  errors?: string[];
  uuid: string;
}

// Compact boundary message
interface CompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: "auto" | "manual";
    pre_tokens: number;
  };
}

// Usage statistics
interface UsageStats {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier: string;
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
}
```

---

## Related Documentation

- **Session Resumption**: Extract `session_id` from system message for `--resume <session-id>` flag
- **Token Statistics**: Extract from `usage` field in result message for cost tracking
- **Real-Time Streaming**: Use `--include-partial-messages` for token-by-token streaming
- **FlightPath Integration**: See `ClaudeResponseParser` in `src/flightpath/cli/claude/`

---

**Document Version**: 1.0
**Based on**: Claude Code v2.1.23+, Research from `CLAUDE_CLI_STREAM_JSON_FORMAT.md`
**Analysis Date**: 2026-01-28
**Tested With**: claude-sonnet-4-5-20250929
