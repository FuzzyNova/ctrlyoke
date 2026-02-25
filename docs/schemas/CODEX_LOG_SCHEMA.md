# Codex CLI Log File Schema Reference

**Version:** 1.0
**CLI Version:** 0.87.0
**Format:** JSONL (JSON Lines)
**Analyzed Log:** `rollout-2026-01-17T10-36-57-019bccd1-249e-77b3-bac1-89238b4647c7.jsonl`
**Total Events:** 629

## Overview

### File Location and Naming

**Path Pattern:**

```
~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<session-id>.jsonl
```

**Example:**

```
C:\Users\<username>\.codex\sessions\2026\01\17\rollout-2026-01-17T10-36-57-019bccd1-249e-77b3-bac1-89238b4647c7.jsonl
```

**Characteristics:**

- JSONL format: One JSON object per line
- Chronological event stream
- Date-based directory hierarchy (YYYY/MM/DD)
- Filename includes timestamp and session UUID
- UTF-8 encoding

---

## Two-Level Type System

Codex logs use a **two-level type hierarchy**:

1. **Event Type** (`event.type`): Top-level event category
2. **Payload Type** (`event.payload.type`): Nested event subtype (when applicable)

**Structure:**

```json
{
  "timestamp": "2026-01-17T16:36:57.184Z",
  "type": "event_type", // Level 1: Event category
  "payload": {
    "type": "payload_type" // Level 2: Event subtype
    // ... additional fields
  }
}
```

**Event Type Distribution:**
| Event Type | Count | Description |
|------------|-------|-------------|
| `response_item` | 287 | AI response components (messages, tool calls, reasoning) |
| `event_msg` | 221 | User/agent messages and token statistics |
| `turn_context` | 120 | Context for each conversational turn |
| `session_meta` | 1 | Session initialization metadata |

---

## Common Event Structure

All events share this base structure:

```typescript
interface CodexLogEvent {
  timestamp: string; // ISO 8601 format: "2026-01-17T16:36:57.184Z"
  type: string; // Event type (see Event Types section)
  payload: object; // Type-specific payload (see Payload Types section)
}
```

---

## Event Types

### 1. `session_meta` - Session Initialization

**Frequency:** 1 (first event in log)
**Payload Type:** None (no `payload.type` field)

**Purpose:** Captures session initialization metadata including CLI version, working directory, Git context, and user instructions.

**Fields:**

```typescript
interface SessionMetaPayload {
  id: string; // Session UUID
  timestamp: string; // Session start time (ISO 8601)
  cwd: string; // Working directory
  originator: string; // Always "codex_cli_rs"
  cli_version: string; // CLI version (e.g., "0.87.0")
  instructions: string; // User instructions/context
  source: string; // Always "cli"
  model_provider: string; // Model provider (e.g., "openai")
  git: {
    commit_hash: string;
    branch: string;
    repository_url: string;
  };
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:36:57.184Z",
  "type": "session_meta",
  "payload": {
    "id": "019bccd1-249e-77b3-bac1-89238b4647c7",
    "timestamp": "2026-01-17T16:36:57.118Z",
    "cwd": "C:\\dev\\FlightPath",
    "originator": "codex_cli_rs",
    "cli_version": "0.87.0",
    "instructions": "Always read the main project instructions...",
    "source": "cli",
    "model_provider": "openai",
    "git": {
      "commit_hash": "820355d65d50250877b79535b88c7e9339abf690",
      "branch": "main",
      "repository_url": "https://github.com/nhickster/flightpath.git"
    }
  }
}
```

---

### 2. `turn_context` - Conversation Turn Context

**Frequency:** 120 events
**Payload Type:** None (no `payload.type` field)

**Purpose:** Captures context for each conversational turn, including sandbox settings, model configuration, and truncation policies.

**Fields:**

```typescript
interface TurnContextPayload {
  cwd: string; // Working directory
  approval_policy: string; // "on-request"
  sandbox_policy: {
    type: string; // "workspace-write"
    writable_roots: string[]; // Allowed write paths
    network_access: boolean; // Network permission
    exclude_tmpdir_env_var: boolean;
    exclude_slash_tmp: boolean;
  };
  model: string; // Model name (e.g., "gpt-5.2-codex")
  effort: string; // "medium"
  summary: string; // "auto"
  user_instructions: string; // User instructions for this turn
  truncation_policy: {
    mode: string; // "tokens"
    limit: number; // Token limit (e.g., 10000)
  };
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:36:58.893Z",
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
    "model": "gpt-5.2-codex",
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

---

### 3. `event_msg` - Messages and Statistics

**Frequency:** 221 events
**Payload Types:** `user_message`, `agent_message`, `token_count`

**Purpose:** Captures user messages, agent responses, and token usage statistics.

---

#### 3.1 `event_msg:user_message` - User Input

**Frequency:** 2 events

**Fields:**

```typescript
interface UserMessagePayload {
  type: "user_message";
  message: string; // User's message text
  images: any[]; // Image attachments (if any)
  local_images: any[]; // Local image attachments (if any)
  text_elements: any[]; // Additional text elements (if any)
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:36:58.892Z",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "message": "Follow instructions in .flightpath\\temp\\1768667812-just-say-hi-20260114-231244-1.prompt.md",
    "images": [],
    "local_images": [],
    "text_elements": []
  }
}
```

---

#### 3.2 `event_msg:agent_message` - Agent Response

**Frequency:** 2 events

**Fields:**

```typescript
interface AgentMessagePayload {
  type: "agent_message";
  message: string; // Agent's complete response text
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:44:56.109Z",
  "type": "event_msg",
  "payload": {
    "type": "agent_message",
    "message": "**Findings**\n- High: Retry prompts ignore prompt-level model/agent..."
  }
}
```

---

#### 3.3 `event_msg:token_count` - Token Usage Statistics

**Frequency:** 217 events

**Fields:**

```typescript
interface TokenCountPayload {
  type: "token_count";
  info: {
    total_token_usage: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
    };
    last_token_usage: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
    };
    model_context_window: number;
  } | null; // null when no statistics available
  rate_limits: {
    primary: any | null;
    secondary: any | null;
    credits: any | null;
    plan_type: any | null;
  };
}
```

**Example (with statistics):**

```json
{
  "timestamp": "2026-01-17T16:36:59.590Z",
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 3786,
        "cached_input_tokens": 0,
        "output_tokens": 50,
        "reasoning_output_tokens": 0,
        "total_tokens": 3836
      },
      "last_token_usage": {
        "input_tokens": 3786,
        "cached_input_tokens": 0,
        "output_tokens": 50,
        "reasoning_output_tokens": 0,
        "total_tokens": 3836
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

**Example (no statistics):**

```json
{
  "timestamp": "2026-01-17T16:36:59.590Z",
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

---

### 4. `response_item` - AI Response Components

**Frequency:** 287 events
**Payload Types:** `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`

**Purpose:** Captures individual components of AI responses including messages, reasoning, and tool interactions.

---

#### 4.1 `response_item:message` - System/Agent Messages

**Frequency:** 7 events

**Fields:**

```typescript
interface MessagePayload {
  type: "message";
  role: string; // "developer" or "assistant"
  content: Array<{
    type: string; // "input_text"
    text: string; // Message content
  }>;
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:36:57.184Z",
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

---

#### 4.2 `response_item:reasoning` - AI Reasoning Process

**Frequency:** 90 events

**Fields:**

```typescript
interface ReasoningPayload {
  type: "reasoning";
  summary: any[]; // Summary of reasoning (typically empty array)
  content: null; // Plaintext reasoning (always null in this log)
  encrypted_content: string; // Encrypted reasoning content
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:37:00.941Z",
  "type": "response_item",
  "payload": {
    "type": "reasoning",
    "summary": [],
    "content": null,
    "encrypted_content": "gAAAAABpa7qtOIguTm-znZcenC95_2DHrymsiNBez9aMGHUIMjhoKpseMVrS..."
  }
}
```

---

#### 4.3 `response_item:function_call` - Function Call Request

**Frequency:** 77 events

**Fields:**

```typescript
interface FunctionCallPayload {
  type: "function_call";
  name: string; // Function name (e.g., "shell_command")
  arguments: string; // JSON-encoded arguments
  call_id: string; // Unique call identifier
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:37:01.407Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "shell_command",
    "arguments": "{\"command\":\"Get-Content -Path .flightpath\\\\temp\\\\1768667812-just-say-hi-20260114-231244-1.prompt.md\"}",
    "call_id": "call_8VNMTi3jMhdjRN1ZPTQZwGdA"
  }
}
```

**Observed Function Names:**

- `shell_command` - Execute shell commands

---

#### 4.4 `response_item:function_call_output` - Function Call Result

**Frequency:** 77 events

**Fields:**

```typescript
interface FunctionCallOutputPayload {
  type: "function_call_output";
  call_id: string; // Matches function_call.call_id
  output: string; // Function output (may include exit code, timing, stdout/stderr)
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:37:02.503Z",
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_8VNMTi3jMhdjRN1ZPTQZwGdA",
    "output": "Exit code: 0\nWall time: 0.4 seconds\nTotal output lines: 1275\nOutput:\n<attachment id=\"file:docs/research/WORKFLOW_LEVEL_PROPERTIES.md\">..."
  }
}
```

---

#### 4.5 `response_item:custom_tool_call` - Custom Tool Call Request

**Frequency:** 18 events

**Fields:**

```typescript
interface CustomToolCallPayload {
  type: "custom_tool_call";
  status: string; // "completed" (other statuses may exist)
  call_id: string; // Unique call identifier
  name: string; // Tool name (e.g., "apply_patch")
  input: string; // Tool input data
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:59:57.413Z",
  "type": "response_item",
  "payload": {
    "type": "custom_tool_call",
    "status": "completed",
    "call_id": "call_t1DfnpHYEe3BHp3PaozHcNrM",
    "name": "apply_patch",
    "input": "*** Begin Patch\n*** Update File: src/utils/PropertyResolver.ts..."
  }
}
```

**Observed Tool Names:**

- `apply_patch` - Apply code patches

**Observed Status Values:**

- `completed` - Tool execution completed successfully

---

#### 4.6 `response_item:custom_tool_call_output` - Custom Tool Call Result

**Frequency:** 18 events

**Fields:**

```typescript
interface CustomToolCallOutputPayload {
  type: "custom_tool_call_output";
  call_id: string; // Matches custom_tool_call.call_id
  output: string; // JSON-encoded tool output
}
```

**Example:**

```json
{
  "timestamp": "2026-01-17T16:59:57.516Z",
  "type": "response_item",
  "payload": {
    "type": "custom_tool_call_output",
    "call_id": "call_t1DfnpHYEe3BHp3PaozHcNrM",
    "output": "{\"output\":\"Success. Updated the following files:\\nM src/utils/PropertyResolver.ts\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.0}}"
  }
}
```

---

## TypeScript Interface Definitions

### Complete Type Definitions

```typescript
// ============================================================================
// Base Event Structure
// ============================================================================

/**
 * Base structure for all Codex log events
 */
interface CodexLogEvent {
  timestamp: string; // ISO 8601 timestamp
  type: EventType;
  payload: EventPayload;
}

type EventType =
  | "session_meta"
  | "turn_context"
  | "event_msg"
  | "response_item";

type EventPayload =
  | SessionMetaPayload
  | TurnContextPayload
  | EventMsgPayload
  | ResponseItemPayload;

// ============================================================================
// Session Meta
// ============================================================================

interface SessionMetaPayload {
  id: string;
  timestamp: string;
  cwd: string;
  originator: "codex_cli_rs";
  cli_version: string;
  instructions: string;
  source: "cli";
  model_provider: string;
  git: GitInfo;
}

interface GitInfo {
  commit_hash: string;
  branch: string;
  repository_url: string;
}

// ============================================================================
// Turn Context
// ============================================================================

interface TurnContextPayload {
  cwd: string;
  approval_policy: string;
  sandbox_policy: SandboxPolicy;
  model: string;
  effort: string;
  summary: string;
  user_instructions: string;
  truncation_policy: TruncationPolicy;
}

interface SandboxPolicy {
  type: "workspace-write";
  writable_roots: string[];
  network_access: boolean;
  exclude_tmpdir_env_var: boolean;
  exclude_slash_tmp: boolean;
}

interface TruncationPolicy {
  mode: "tokens";
  limit: number;
}

// ============================================================================
// Event Messages (with payload type discrimination)
// ============================================================================

type EventMsgPayload =
  | UserMessagePayload
  | AgentMessagePayload
  | TokenCountPayload;

interface UserMessagePayload {
  type: "user_message";
  message: string;
  images: any[];
  local_images: any[];
  text_elements: any[];
}

interface AgentMessagePayload {
  type: "agent_message";
  message: string;
}

interface TokenCountPayload {
  type: "token_count";
  info: TokenUsageInfo | null;
  rate_limits: RateLimits;
}

interface TokenUsageInfo {
  total_token_usage: TokenUsage;
  last_token_usage: TokenUsage;
  model_context_window: number;
}

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface RateLimits {
  primary: any | null;
  secondary: any | null;
  credits: any | null;
  plan_type: any | null;
}

// ============================================================================
// Response Items (with payload type discrimination)
// ============================================================================

type ResponseItemPayload =
  | MessagePayload
  | ReasoningPayload
  | FunctionCallPayload
  | FunctionCallOutputPayload
  | CustomToolCallPayload
  | CustomToolCallOutputPayload;

interface MessagePayload {
  type: "message";
  role: "developer" | "assistant";
  content: MessageContent[];
}

interface MessageContent {
  type: "input_text";
  text: string;
}

interface ReasoningPayload {
  type: "reasoning";
  summary: any[];
  content: null;
  encrypted_content: string;
}

interface FunctionCallPayload {
  type: "function_call";
  name: string;
  arguments: string; // JSON-encoded
  call_id: string;
}

interface FunctionCallOutputPayload {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface CustomToolCallPayload {
  type: "custom_tool_call";
  status: string; // "completed", possibly others
  call_id: string;
  name: string;
  input: string;
}

interface CustomToolCallOutputPayload {
  type: "custom_tool_call_output";
  call_id: string;
  output: string; // JSON-encoded
}
```

---

## Event Frequency Distribution

Based on analysis of 629 events:

| Event Type      | Payload Type              | Count | Percentage |
| --------------- | ------------------------- | ----- | ---------- |
| `response_item` | `reasoning`               | 90    | 14.3%      |
| `response_item` | `function_call`           | 77    | 12.2%      |
| `response_item` | `function_call_output`    | 77    | 12.2%      |
| `response_item` | `custom_tool_call`        | 18    | 2.9%       |
| `response_item` | `custom_tool_call_output` | 18    | 2.9%       |
| `response_item` | `message`                 | 7     | 1.1%       |
| `event_msg`     | `token_count`             | 217   | 34.5%      |
| `event_msg`     | `user_message`            | 2     | 0.3%       |
| `event_msg`     | `agent_message`           | 2     | 0.3%       |
| `turn_context`  | (no type)                 | 120   | 19.1%      |
| `session_meta`  | (no type)                 | 1     | 0.2%       |

---

## Usage Notes

### Parsing Strategy

1. **Sequential Processing**: Read JSONL line by line
2. **Type Discrimination**: Check `event.type` first, then `event.payload.type`
3. **Tool Call Matching**: Match `function_call` with `function_call_output` using `call_id`
4. **Token Tracking**: Aggregate `token_count` events for usage statistics

### Session Identification

**Session ID Location:** `session_meta.payload.id` (first event)

**Example:**

```typescript
function extractSessionId(logPath: string): string | null {
  const firstLine = readFirstLine(logPath);
  const event = JSON.parse(firstLine);

  if (event.type === "session_meta") {
    return event.payload.id;
  }

  return null;
}
```

### Token Statistics Extraction

**Token counts appear in `event_msg:token_count` events:**

```typescript
function extractTokenStats(events: CodexLogEvent[]): TokenUsageInfo | null {
  const tokenEvents = events.filter(
    (e) =>
      e.type === "event_msg" &&
      e.payload.type === "token_count" &&
      e.payload.info !== null
  );

  if (tokenEvents.length === 0) return null;

  // Get the last token count event (final statistics)
  const lastEvent = tokenEvents[tokenEvents.length - 1];
  return lastEvent.payload.info;
}
```

### Tool Call Tracking

**Match calls with outputs using `call_id`:**

```typescript
interface ToolCallPair {
  call: FunctionCallPayload | CustomToolCallPayload;
  output: FunctionCallOutputPayload | CustomToolCallOutputPayload;
  duration?: number; // Time between call and output
}

function matchToolCalls(events: CodexLogEvent[]): ToolCallPair[] {
  const calls = new Map<string, { event: CodexLogEvent; timestamp: string }>();
  const pairs: ToolCallPair[] = [];

  for (const event of events) {
    if (event.type !== "response_item") continue;

    const payload = event.payload;

    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call"
    ) {
      calls.set(payload.call_id, { event, timestamp: event.timestamp });
    }

    if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output"
    ) {
      const callData = calls.get(payload.call_id);
      if (callData) {
        const duration =
          new Date(event.timestamp).getTime() -
          new Date(callData.timestamp).getTime();

        pairs.push({
          call: callData.event.payload,
          output: payload,
          duration,
        });
      }
    }
  }

  return pairs;
}
```

---

## Completion Detection

### Strategy 1: Turn Completion Event

**Not observed in this log.** Future Codex versions may emit explicit turn completion events.

### Strategy 2: Inactivity Detection

**Monitor timestamp gaps:**

```typescript
function detectCompletion(
  events: CodexLogEvent[],
  inactivityThresholdMs: number = 5000
): boolean {
  if (events.length < 2) return false;

  const lastEvent = events[events.length - 1];
  const now = Date.now();
  const lastTimestamp = new Date(lastEvent.timestamp).getTime();

  return now - lastTimestamp > inactivityThresholdMs;
}
```

### Strategy 3: Agent Message Detection

**Look for `event_msg:agent_message` as final response:**

```typescript
function hasAgentResponse(events: CodexLogEvent[]): boolean {
  return events.some(
    (e) => e.type === "event_msg" && e.payload.type === "agent_message"
  );
}
```

---

## Key Differences from Copilot CLI Logs

| Feature                  | Codex CLI                                  | Copilot CLI                         |
| ------------------------ | ------------------------------------------ | ----------------------------------- |
| **Format**               | JSONL events                               | Plain text with sections            |
| **Session ID**           | In `session_meta` event                    | In log filename or embedded in text |
| **Token Stats**          | Structured in `token_count` events         | Embedded in chat output             |
| **Completion Detection** | Inactivity or agent message                | "Chat completed" message            |
| **Tool Calls**           | Separate `function_call` + `output` events | Inline in chat text                 |
| **Reasoning**            | Encrypted in `reasoning` events            | Not logged                          |
| **Real-time Parsing**    | Event-by-event streaming                   | Line-by-line text parsing           |

---

## Related Documentation

- **Codex CLI Provider Implementation:** `src/flightpath/cli/codex/CodexCliProvider.ts`
- **Codex Response Parser:** `src/flightpath/cli/codex/CodexResponseParser.ts`
- **Codex Log Parser:** `src/flightpath/cli/codex/CodexLogParser.ts`
- **Adding New CLI Providers:** `docs/ADDING_NEW_CLI_PROVIDER.md`

---

## Version History

| Version | Date       | Changes                                           |
| ------- | ---------- | ------------------------------------------------- |
| 1.0     | 2026-01-28 | Initial schema documentation based on CLI v0.87.0 |

---

**End of Schema Reference**
