# Copilot CLI Log File Schema Reference

**Version**: CLI v0.0.384+
**Format**: JSONL (JSON Lines)
**Last Updated**: 2026-01-28

## Overview

This document provides a comprehensive schema reference for GitHub Copilot CLI log files based on real-world analysis of CLI version 0.0.384.

### File Location

**CLI v0.0.384+** (Directory-based Sessions):

```
~/.copilot/session-state/<session-id>/events.jsonl
```

Each session creates a dedicated directory containing:

- `events.jsonl` - All session events in JSONL format
- Other session-related files (if applicable)

**Example Path**:

```
C:\Users\<username>\.copilot\session-state\6e2ec013-11bd-4862-ab32-c5b4d5a71131\events.jsonl
```

### Format Structure

- **File Format**: JSONL (one JSON object per line)
- **Line Count**: Variable (227 lines in analyzed session)
- **Encoding**: UTF-8
- **Total Event Types**: 9 unique types

## Event Type Frequency (Sample Session)

Based on analysis of a real session with 227 events:

| Event Type                | Count | Description                                           |
| ------------------------- | ----- | ----------------------------------------------------- |
| `tool.execution_start`    | 46    | Tool call initiated                                   |
| `tool.execution_complete` | 46    | Tool call completed                                   |
| `assistant.message`       | 42    | Assistant response with content/tool requests         |
| `assistant.turn_start`    | 38    | Assistant turn begins                                 |
| `assistant.turn_end`      | 38    | Assistant turn completes                              |
| `assistant.reasoning`     | 10    | Extended reasoning (when model uses chain-of-thought) |
| `user.message`            | 3     | User input message                                    |
| `session.info`            | 2     | Session information (auth, MCP connections)           |
| `session.start`           | 1     | Session initialization                                |
| `session.error`           | 1     | Session-level error                                   |

## Common Event Structure

**All events share these required fields:**

```typescript
interface BaseEvent {
  type: string; // Event type identifier
  data: object; // Event-specific data payload
  id: string; // Unique UUID for this event
  timestamp: string; // ISO 8601 timestamp (e.g., "2026-01-19T01:36:05.198Z")
  parentId: string | null; // UUID of parent event (null for root events)
}
```

### Event Hierarchy (parentId Chain)

Events form a tree structure via `parentId` references:

```
session.start (parentId: null)
  └─ session.info (authentication)
      └─ session.info (mcp)
          └─ user.message
              └─ assistant.turn_start
                  └─ assistant.message
                      ├─ assistant.reasoning (optional)
                      └─ tool.execution_start
                          └─ tool.execution_complete
                              └─ assistant.turn_end
                                  └─ (next assistant.turn_start...)
```

**Key Relationships:**

- Root event (`session.start`) has `parentId: null`
- Each `assistant.turn_start` → `assistant.message` → `tool.execution_start` forms a chain
- `tool.execution_complete` always references its `tool.execution_start` as parent
- `assistant.turn_end` references the last event in the turn (usually last `tool.execution_complete`)

---

## Event Type Schemas

### 1. `session.start`

**Description**: First event in every session, emitted when CLI session initializes.

**Frequency**: 1 per session (always first event)

**Fields**:

```typescript
interface SessionStartEvent extends BaseEvent {
  type: "session.start";
  data: {
    sessionId: string; // UUID matching directory name
    version: number; // Log format version (1)
    producer: string; // "copilot-agent"
    copilotVersion: string; // CLI version (e.g., "0.0.384")
    startTime: string; // ISO 8601 timestamp
    selectedModel: string; // Model identifier (e.g., "gpt-5-mini")
  };
  parentId: null; // Always null (root event)
}
```

**Example**:

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

---

### 2. `session.info`

**Description**: Informational messages about session state (authentication, MCP connections, etc.)

**Frequency**: 1-10 per session (varies by configuration)

**Fields**:

```typescript
interface SessionInfoEvent extends BaseEvent {
  type: "session.info";
  data: {
    infoType: "authentication" | "mcp" | string; // Category of info
    message: string; // Human-readable message
  };
  parentId: string; // References previous session.info or session.start
}
```

**Known `infoType` Values**:

- `"authentication"` - User authentication status
- `"mcp"` - MCP (Model Context Protocol) server connections

**Examples**:

**Authentication Info**:

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

**MCP Connection Info**:

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

---

### 3. `user.message`

**Description**: User input to the assistant (prompt with optional file attachments)

**Frequency**: 1+ per session (varies by conversation length)

**Fields**:

```typescript
interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  data: {
    content: string; // Original user input
    transformedContent: string; // Content with <current_datetime> prepended
    attachments: Array<{
      // File attachments (from @file mentions)
      type: "file";
      path: string; // Absolute file path
      displayName: string; // Mention syntax (e.g., "@.flightpath\\temp\\file.md,")
      mentionIndex: number; // Character position in content
    }>;
  };
  parentId: string; // Usually references previous assistant.turn_end or session.info
}
```

**Examples**:

**With File Attachments**:

```json
{
  "type": "user.message",
  "data": {
    "content": "Follow instructions in @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md, @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.2.prompt.md, and @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.3.prompt.md",
    "transformedContent": "<current_datetime>2026-01-19T01:36:08.274Z</current_datetime>\n\nFollow instructions in @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md, @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.2.prompt.md, and @.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.3.prompt.md",
    "attachments": [
      {
        "type": "file",
        "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md",
        "displayName": "@.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md,",
        "mentionIndex": 23
      }
    ]
  },
  "id": "d919f62c-60dc-42ad-ad6e-d019b10e613b",
  "timestamp": "2026-01-19T01:36:08.274Z",
  "parentId": "64c42b68-66b7-4680-bc9c-4068786746dc"
}
```

**Without Attachments**:

```json
{
  "type": "user.message",
  "data": {
    "content": "what tools do you have, can you run subagents or search the web?",
    "transformedContent": "<current_datetime>2026-01-19T01:48:34.987Z</current_datetime>\n\nwhat tools do you have, can you run subagents or search the web?",
    "attachments": []
  },
  "id": "ffd8cc80-5002-47bb-84e8-d9232171880d",
  "timestamp": "2026-01-19T01:48:34.987Z",
  "parentId": "a4ca0546-85a3-48dd-bb29-456086c79275"
}
```

**Notes**:

- `transformedContent` always includes `<current_datetime>` tag at start
- Empty `attachments: []` when no files mentioned
- `displayName` includes trailing comma when multiple files mentioned

---

### 4. `assistant.turn_start`

**Description**: Marks the beginning of an assistant's response turn

**Frequency**: 1 per assistant response (pairs with `assistant.turn_end`)

**Fields**:

```typescript
interface AssistantTurnStartEvent extends BaseEvent {
  type: "assistant.turn_start";
  data: {
    turnId: string; // Sequential turn number ("0", "1", "2", ...)
  };
  parentId: string; // References user.message or previous assistant.turn_end
}
```

**Example**:

```json
{
  "type": "assistant.turn_start",
  "data": {
    "turnId": "0"
  },
  "id": "3b709d30-c39c-488b-b59b-175cd58448a5",
  "timestamp": "2026-01-19T01:36:08.377Z",
  "parentId": "d919f62c-60dc-42ad-ad6e-d019b10e613b"
}
```

**Notes**:

- `turnId` is string-formatted number starting at "0"
- Turn counter increments with each assistant response
- Always followed by `assistant.message` event

---

### 5. `assistant.message`

**Description**: Assistant's response content and/or tool call requests

**Frequency**: 1+ per turn (may be multiple if streaming)

**Fields**:

```typescript
interface AssistantMessageEvent extends BaseEvent {
  type: "assistant.message";
  data: {
    messageId: string; // Unique message UUID
    content: string; // Text response (empty if only tool calls)
    toolRequests?: Array<{
      // Tool calls requested (optional)
      toolCallId: string; // Unique call identifier
      name: string; // Tool name (e.g., "view", "grep", "report_intent")
      arguments: object; // Tool-specific arguments
    }>;
  };
  parentId: string; // References assistant.turn_start or assistant.reasoning
}
```

**Examples**:

**Tool Calls Only (Empty Content)**:

```json
{
  "type": "assistant.message",
  "data": {
    "messageId": "e43e0039-7b4c-4149-9bb8-b144553e62ba",
    "content": "",
    "toolRequests": [
      {
        "toolCallId": "call_Tbb8FH9Mgxp2oOlcUQwX5EZl",
        "name": "report_intent",
        "arguments": {
          "intent": "Following prompts"
        }
      }
    ]
  },
  "id": "43cea37f-d604-47cd-af4f-207741c2a72a",
  "timestamp": "2026-01-19T01:36:13.499Z",
  "parentId": "d7acf7ca-a450-433c-b33d-3940c04c347d"
}
```

**Multiple Tool Calls**:

```json
{
  "type": "assistant.message",
  "data": {
    "messageId": "a4684eb8-2be3-4ba2-9627-f005baccbd27",
    "content": "",
    "toolRequests": [
      {
        "toolCallId": "call_1aFePRimRHC5Ka2j5G2xsG5t",
        "name": "report_intent",
        "arguments": {
          "intent": "Following prompts"
        }
      },
      {
        "toolCallId": "call_QHzc9P78VBl2CuDfGdOZ2sgU",
        "name": "view",
        "arguments": {
          "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md"
        }
      }
    ]
  },
  "id": "608dfaf8-df71-4bcb-864c-2a2fc8824276",
  "timestamp": "2026-01-19T01:36:19.566Z",
  "parentId": "161e520b-3784-4b97-a87a-c988abedaf4a"
}
```

**With Content and Tool Calls**:

```json
{
  "type": "assistant.message",
  "data": {
    "messageId": "b1fd6941-b214-41aa-bd79-a572ce177bd9",
    "content": "Reading the starts of the three prompt files to find the actionable instructions.",
    "toolRequests": [
      {
        "toolCallId": "call_CJKUzdIXNFDDSTner6O7Lmm7",
        "name": "view",
        "arguments": {
          "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md",
          "view_range": [1, 200]
        }
      }
    ]
  },
  "id": "e358006f-7c51-4745-a189-e349ea616637",
  "timestamp": "2026-01-19T01:36:33.367Z",
  "parentId": "bb74f76d-b9fd-484c-8079-2a902f5827bb"
}
```

**Notes**:

- `content` may be empty string when only tool calls present
- `toolRequests` may be omitted if no tools called
- Each tool request spawns `tool.execution_start` → `tool.execution_complete` events

---

### 6. `assistant.reasoning`

**Description**: Extended chain-of-thought reasoning (when model uses reasoning mode)

**Frequency**: 0-10+ per session (only when model performs extended thinking)

**Fields**:

```typescript
interface AssistantReasoningEvent extends BaseEvent {
  type: "assistant.reasoning";
  data: {
    reasoningId: string; // Unique reasoning block UUID
    content: string; // Markdown-formatted reasoning text
  };
  parentId: string; // References assistant.message
}
```

**Example**:

```json
{
  "type": "assistant.reasoning",
  "data": {
    "reasoningId": "7542aadc-2f68-4cd1-bea3-d7d3c5f1e3cf",
    "content": "**Following instructions in files**\n\nI called report_intent as instructed, but I encountered a tool limitation saying the files are too large. I need to provide a brief explanation of the next steps and then call the view tool..."
  },
  "id": "e96933ee-8fa0-48b8-91fa-9fd97f7a2a0a",
  "timestamp": "2026-01-19T01:36:33.367Z",
  "parentId": "e358006f-7c51-4745-a189-e349ea616637"
}
```

**Notes**:

- Content is markdown-formatted with `**Headers**` and `\n\n` paragraph breaks
- Not present in all sessions (depends on model behavior)
- Typically appears before tool calls in complex reasoning scenarios

---

### 7. `tool.execution_start`

**Description**: Tool execution initiated

**Frequency**: 1 per tool call (pairs with `tool.execution_complete`)

**Fields**:

```typescript
interface ToolExecutionStartEvent extends BaseEvent {
  type: "tool.execution_start";
  data: {
    toolCallId: string; // Matches toolCallId from assistant.message
    toolName: string; // Tool identifier
    arguments: object; // Tool-specific arguments
  };
  parentId: string; // References assistant.message or previous tool.execution_start
}
```

**Examples**:

**Simple Tool (report_intent)**:

```json
{
  "type": "tool.execution_start",
  "data": {
    "toolCallId": "call_Tbb8FH9Mgxp2oOlcUQwX5EZl",
    "toolName": "report_intent",
    "arguments": {
      "intent": "Following prompts"
    }
  },
  "id": "6ad7ecdb-02e8-425f-9429-172809db7835",
  "timestamp": "2026-01-19T01:36:13.499Z",
  "parentId": "43cea37f-d604-47cd-af4f-207741c2a72a"
}
```

**File Tool (view)**:

```json
{
  "type": "tool.execution_start",
  "data": {
    "toolCallId": "call_QHzc9P78VBl2CuDfGdOZ2sgU",
    "toolName": "view",
    "arguments": {
      "path": "C:\\dev\\FlightPath\\.flightpath\\temp\\1768786559-spaces-in-workflow-name-1.1.prompt.md"
    }
  },
  "id": "76732874-acae-47af-9096-e040a3244c39",
  "timestamp": "2026-01-19T01:36:19.566Z",
  "parentId": "571590e7-d5d7-41e5-a81a-1a7fa4284961"
}
```

**Notes**:

- When multiple tools called, `parentId` forms a chain (tool1 → tool2 → tool3)
- `toolCallId` links back to `assistant.message.toolRequests[].toolCallId`

---

### 8. `tool.execution_complete`

**Description**: Tool execution finished (success or failure)

**Frequency**: 1 per tool call (pairs with `tool.execution_start`)

**Fields**:

```typescript
interface ToolExecutionCompleteEvent extends BaseEvent {
  type: "tool.execution_complete";
  data: {
    toolCallId: string; // Matches tool.execution_start.toolCallId
    success: boolean; // true if tool succeeded
    result: {
      content: string; // Tool output (text, JSON, or error message)
    };
    toolTelemetry: {
      // Telemetry metadata (may be empty object)
      properties?: {
        // Tool-specific metadata
        command?: string;
        options?: string;
        inputs?: string;
        fileExtension?: string;
        viewType?: string;
        largeOutputAvoided?: string;
        largeOutputOriginalSizeBytes?: string;
        // ... other tool-specific properties
      };
      metrics?: {
        // Performance metrics
        resultLength?: number;
        resultForLlmLength?: number;
        responseTokenLimit?: number;
      };
      restrictedProperties?: object; // Always empty object in examples
    };
  };
  parentId: string; // References corresponding tool.execution_start
}
```

**Examples**:

**Simple Success (Empty Telemetry)**:

```json
{
  "type": "tool.execution_complete",
  "data": {
    "toolCallId": "call_Tbb8FH9Mgxp2oOlcUQwX5EZl",
    "success": true,
    "result": {
      "content": "Intent logged"
    },
    "toolTelemetry": {}
  },
  "id": "616c716c-dd53-4cac-83ba-af19796f31ab",
  "timestamp": "2026-01-19T01:36:13.500Z",
  "parentId": "6ad7ecdb-02e8-425f-9429-172809db7835"
}
```

**With Rich Telemetry (view tool)**:

```json
{
  "type": "tool.execution_complete",
  "data": {
    "toolCallId": "call_QHzc9P78VBl2CuDfGdOZ2sgU",
    "success": true,
    "result": {
      "content": "File too large to read at once (57.9 KB). Consider using tools like grep..."
    },
    "toolTelemetry": {
      "properties": {
        "command": "view",
        "options": "{\"truncateBasedOn\":\"tokenCount\",\"truncateStyle\":\"middle\"}",
        "inputs": "[\"path\",\"command\"]",
        "resolvedPathAgainstCwd": "false",
        "fileExtension": ".md",
        "viewType": "file",
        "largeOutputAvoided": "true",
        "largeOutputOriginalSizeBytes": "59246"
      },
      "metrics": {
        "resultLength": 220,
        "resultForLlmLength": 220,
        "responseTokenLimit": 32000
      },
      "restrictedProperties": {}
    }
  },
  "id": "0c307cba-71ac-4b62-84df-ddd85ff64add",
  "timestamp": "2026-01-19T01:36:19.569Z",
  "parentId": "d9c93718-6515-41b3-b679-353be9f76e63"
}
```

**Notes**:

- `success: true` for successful execution, `success: false` for errors
- `toolTelemetry` structure varies by tool (may be empty object `{}`)
- `properties` keys are tool-specific (not standardized)
- `restrictedProperties` always `{}` in observed examples

---

### 9. `assistant.turn_end`

**Description**: Marks the end of an assistant's response turn

**Frequency**: 1 per assistant response (pairs with `assistant.turn_start`)

**Fields**:

```typescript
interface AssistantTurnEndEvent extends BaseEvent {
  type: "assistant.turn_end";
  data: {
    turnId: string; // Matches corresponding assistant.turn_start.turnId
  };
  parentId: string; // References last event in turn (usually tool.execution_complete)
}
```

**Example**:

```json
{
  "type": "assistant.turn_end",
  "data": {
    "turnId": "0"
  },
  "id": "8f5bcf99-9adb-4c11-9b92-c34c6182fa40",
  "timestamp": "2026-01-19T01:36:13.500Z",
  "parentId": "616c716c-dd53-4cac-83ba-af19796f31ab"
}
```

**Notes**:

- `turnId` matches the corresponding `assistant.turn_start` event
- `parentId` typically references the last `tool.execution_complete` in the turn
- Next event is usually `assistant.turn_start` (new turn) or `user.message`

---

### 10. `session.error`

**Description**: Session-level error (model call failures, API errors)

**Frequency**: 0-1+ per session (only when errors occur)

**Fields**:

```typescript
interface SessionErrorEvent extends BaseEvent {
  type: "session.error";
  data: {
    errorType: "model_call" | string; // Error category
    message: string; // Human-readable error message
    stack?: string; // Stack trace (optional)
  };
  parentId: string; // References event that triggered error
}
```

**Example**:

```json
{
  "type": "session.error",
  "data": {
    "errorType": "model_call",
    "message": "Model call failed:  (Request ID: 221D:1CB9DD:1F4D0C:298508:696D8CA1)",
    "stack": "Error: {\"message\":\"\",\"code\":\"invalid_request_body\"}\n    at t.runAgenticLoop (file:///C:/Users/natha/.copilot/pkg/universal/0.0.384/index.js:2386:22481)\n    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)"
  },
  "id": "ff5b0e6e-8e4a-48fc-a956-1f7ee8aaa083",
  "timestamp": "2026-01-19T01:45:07.550Z",
  "parentId": "2e089ed4-3974-47b3-9f10-b603e5b1b665"
}
```

**Known `errorType` Values**:

- `"model_call"` - Model API call failed

**Notes**:

- May include `stack` field with JavaScript stack trace
- `message` may include request ID for debugging
- Session continues after error (not fatal)

---

## TypeScript Interface Definitions

```typescript
/**
 * Base event structure - all events extend this
 */
interface BaseEvent {
  type: string;
  data: object;
  id: string; // UUID
  timestamp: string; // ISO 8601
  parentId: string | null;
}

/**
 * Session initialization event
 */
interface SessionStartEvent extends BaseEvent {
  type: "session.start";
  data: {
    sessionId: string;
    version: number;
    producer: string;
    copilotVersion: string;
    startTime: string;
    selectedModel: string;
  };
  parentId: null;
}

/**
 * Session information event
 */
interface SessionInfoEvent extends BaseEvent {
  type: "session.info";
  data: {
    infoType: "authentication" | "mcp" | string;
    message: string;
  };
  parentId: string;
}

/**
 * Session error event
 */
interface SessionErrorEvent extends BaseEvent {
  type: "session.error";
  data: {
    errorType: "model_call" | string;
    message: string;
    stack?: string;
  };
  parentId: string;
}

/**
 * User message event
 */
interface UserMessageEvent extends BaseEvent {
  type: "user.message";
  data: {
    content: string;
    transformedContent: string;
    attachments: Array<{
      type: "file";
      path: string;
      displayName: string;
      mentionIndex: number;
    }>;
  };
  parentId: string;
}

/**
 * Assistant turn start event
 */
interface AssistantTurnStartEvent extends BaseEvent {
  type: "assistant.turn_start";
  data: {
    turnId: string;
  };
  parentId: string;
}

/**
 * Assistant message event
 */
interface AssistantMessageEvent extends BaseEvent {
  type: "assistant.message";
  data: {
    messageId: string;
    content: string;
    toolRequests?: Array<{
      toolCallId: string;
      name: string;
      arguments: Record<string, any>;
    }>;
  };
  parentId: string;
}

/**
 * Assistant reasoning event
 */
interface AssistantReasoningEvent extends BaseEvent {
  type: "assistant.reasoning";
  data: {
    reasoningId: string;
    content: string;
  };
  parentId: string;
}

/**
 * Tool execution start event
 */
interface ToolExecutionStartEvent extends BaseEvent {
  type: "tool.execution_start";
  data: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, any>;
  };
  parentId: string;
}

/**
 * Tool execution complete event
 */
interface ToolExecutionCompleteEvent extends BaseEvent {
  type: "tool.execution_complete";
  data: {
    toolCallId: string;
    success: boolean;
    result: {
      content: string;
    };
    toolTelemetry: {
      properties?: Record<string, string>;
      metrics?: {
        resultLength?: number;
        resultForLlmLength?: number;
        responseTokenLimit?: number;
      };
      restrictedProperties?: object;
    };
  };
  parentId: string;
}

/**
 * Assistant turn end event
 */
interface AssistantTurnEndEvent extends BaseEvent {
  type: "assistant.turn_end";
  data: {
    turnId: string;
  };
  parentId: string;
}

/**
 * Union type of all event types
 */
type CopilotLogEvent =
  | SessionStartEvent
  | SessionInfoEvent
  | SessionErrorEvent
  | UserMessageEvent
  | AssistantTurnStartEvent
  | AssistantMessageEvent
  | AssistantReasoningEvent
  | ToolExecutionStartEvent
  | ToolExecutionCompleteEvent
  | AssistantTurnEndEvent;
```

---

## Version Differences

### CLI v0.0.384+ (Current)

**Directory-based sessions**:

- Each session in separate directory: `~/.copilot/session-state/<session-id>/`
- Log file: `events.jsonl`
- Format: JSONL (one event per line)

**Session ID Format**:

- UUID v4 format (e.g., `6e2ec013-11bd-4862-ab32-c5b4d5a71131`)
- Matches directory name
- Logged in `session.start.data.sessionId`

### CLI v0.0.377 and Earlier (Legacy)

**Flat file format**:

- Single log file for all sessions: `~/.copilot/logs/copilot.log`
- Mixed format (not pure JSONL)
- Session IDs only at DEBUG level
- Harder to parse and isolate sessions

**Migration Notes**:

- Session resumption requires directory-based format (v0.0.384+)
- Older sessions cannot be reliably resumed without session ID
- FlightPath requires CLI v0.0.384+ for session continuity

---

## Completion Detection Strategies

### 1. Turn-Based Detection

Wait for `assistant.turn_end` event with matching `turnId`:

```typescript
function isResponseComplete(
  turnId: string,
  events: CopilotLogEvent[]
): boolean {
  return events.some(
    (event) =>
      event.type === "assistant.turn_end" && event.data.turnId === turnId
  );
}
```

### 2. Tool Completion Detection

Check if all tool requests have completed:

```typescript
function areToolsComplete(
  toolRequests: Array<{ toolCallId: string }>,
  events: CopilotLogEvent[]
): boolean {
  const completedIds = events
    .filter((e) => e.type === "tool.execution_complete")
    .map((e) => (e as ToolExecutionCompleteEvent).data.toolCallId);

  return toolRequests.every((req) => completedIds.includes(req.toolCallId));
}
```

### 3. Session Error Detection

```typescript
function hasSessionError(events: CopilotLogEvent[]): boolean {
  return events.some((e) => e.type === "session.error");
}
```

---

## Common Patterns

### Pattern 1: Simple Tool Call Flow

```
assistant.turn_start (turnId: "0")
  └─ assistant.message (toolRequests: [call_ABC])
      └─ tool.execution_start (toolCallId: call_ABC)
          └─ tool.execution_complete (toolCallId: call_ABC, success: true)
              └─ assistant.turn_end (turnId: "0")
```

### Pattern 2: Multiple Parallel Tool Calls

```
assistant.turn_start (turnId: "1")
  └─ assistant.message (toolRequests: [call_1, call_2, call_3])
      └─ tool.execution_start (toolCallId: call_1)
          └─ tool.execution_start (toolCallId: call_2)
              └─ tool.execution_start (toolCallId: call_3)
                  └─ tool.execution_complete (call_1)
                      └─ tool.execution_complete (call_2)
                          └─ tool.execution_complete (call_3)
                              └─ assistant.turn_end (turnId: "1")
```

### Pattern 3: Reasoning + Tool Calls

```
assistant.turn_start (turnId: "2")
  └─ assistant.message (content: "Analyzing...", toolRequests: [call_X])
      └─ assistant.reasoning (content: "**Thinking**...")
          └─ tool.execution_start (toolCallId: call_X)
              └─ tool.execution_complete (call_X)
                  └─ assistant.turn_end (turnId: "2")
```

### Pattern 4: Session Initialization

```
session.start (sessionId: "xxx", parentId: null)
  └─ session.info (infoType: "authentication")
      └─ session.info (infoType: "mcp")
          └─ user.message (first prompt)
```

---

## Parsing Best Practices

### 1. Stream Processing

```typescript
import * as fs from "fs";
import * as readline from "readline";

async function parseLogStream(filePath: string): Promise<CopilotLogEvent[]> {
  const events: CopilotLogEvent[] = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        const event = JSON.parse(line) as CopilotLogEvent;
        events.push(event);
      } catch (err) {
        console.error("Failed to parse line:", line, err);
      }
    }
  }

  return events;
}
```

### 2. Event Tree Reconstruction

```typescript
interface EventNode {
  event: CopilotLogEvent;
  children: EventNode[];
}

function buildEventTree(events: CopilotLogEvent[]): EventNode {
  const eventMap = new Map<string, EventNode>();

  // Create nodes
  events.forEach((event) => {
    eventMap.set(event.id, { event, children: [] });
  });

  // Build tree
  let root: EventNode | undefined;
  events.forEach((event) => {
    const node = eventMap.get(event.id)!;
    if (event.parentId === null) {
      root = node;
    } else {
      const parent = eventMap.get(event.parentId);
      if (parent) {
        parent.children.push(node);
      }
    }
  });

  return root!;
}
```

### 3. Session ID Extraction

```typescript
function extractSessionId(events: CopilotLogEvent[]): string | null {
  const startEvent = events.find(
    (e) => e.type === "session.start"
  ) as SessionStartEvent;
  return startEvent?.data.sessionId ?? null;
}
```

### 4. Turn Isolation

```typescript
function extractTurn(
  turnId: string,
  events: CopilotLogEvent[]
): CopilotLogEvent[] {
  const startIdx = events.findIndex(
    (e) =>
      e.type === "assistant.turn_start" &&
      (e as AssistantTurnStartEvent).data.turnId === turnId
  );

  const endIdx = events.findIndex(
    (e) =>
      e.type === "assistant.turn_end" &&
      (e as AssistantTurnEndEvent).data.turnId === turnId
  );

  if (startIdx === -1 || endIdx === -1) {
    return [];
  }

  return events.slice(startIdx, endIdx + 1);
}
```

---

## Notes for FlightPath Integration

### Session Resumption

To resume a session in FlightPath:

1. Extract `sessionId` from `session.start` event
2. Pass to CLI with `--resume <sessionId>` flag
3. Monitor new events in same `events.jsonl` file
4. Watch for `assistant.turn_end` to detect completion

### Completion Detection

FlightPath should:

1. Track current `turnId` when sending prompt
2. Tail `events.jsonl` file for new events
3. Watch for `assistant.turn_end` with matching `turnId`
4. Extract tool outputs from `tool.execution_complete` events
5. Handle `session.error` events as failures

### Token Statistics

Tool telemetry may include token counts:

```typescript
interface ToolTelemetry {
  metrics?: {
    resultLength?: number; // Character count
    resultForLlmLength?: number; // Tokens sent to LLM
    responseTokenLimit?: number; // Max response tokens
  };
}
```

Use for tracking usage and optimizing prompts.

### Error Handling

Check for:

- `session.error` events → Abort workflow
- `tool.execution_complete` with `success: false` → Retry or skip
- Missing `assistant.turn_end` after timeout → Inactivity timeout

---

## Changelog

### 2026-01-28

- Initial schema documentation
- Based on CLI v0.0.384 analysis
- 9 event types documented
- 227 events analyzed from real session

---

## References

- **Source Session**: `6e2ec013-11bd-4862-ab32-c5b4d5a71131`
- **CLI Version**: v0.0.384
- **Analysis Date**: 2026-01-28
- **Event Count**: 227 events
- **Session Duration**: ~12 minutes (2026-01-19 01:36 - 01:48)

---

## Appendix: Event Type Enum

```typescript
enum CopilotEventType {
  SESSION_START = "session.start",
  SESSION_INFO = "session.info",
  SESSION_ERROR = "session.error",
  USER_MESSAGE = "user.message",
  ASSISTANT_TURN_START = "assistant.turn_start",
  ASSISTANT_MESSAGE = "assistant.message",
  ASSISTANT_REASONING = "assistant.reasoning",
  TOOL_EXECUTION_START = "tool.execution_start",
  TOOL_EXECUTION_COMPLETE = "tool.execution_complete",
  ASSISTANT_TURN_END = "assistant.turn_end",
}
```

---

**End of Schema Reference**
