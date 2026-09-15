# Copilot Chat Session File Format

**Reference documentation for Copilot Chat session JSON files**

VS Code stores Copilot Chat sessions in JSON files located at:

- **Windows**: `%APPDATA%\Code\User\workspaceStorage\{workspaceId}\chatSessions\`
- **macOS**: `~/Library/Application Support/Code/User/workspaceStorage/{workspaceId}/chatSessions/`
- **Linux**: `~/.config/Code/User/workspaceStorage/{workspaceId}/chatSessions/`

Each chat session creates a file named `{sessionId}.json` (e.g., `2722d7f2-ad41-4a8b-958c-7e43f95dc7ea.json`).

## Overview

Session files are the **single source of truth** for Chat responses in FlightPath. They provide:

- **100% reliability** (vs ~70% for clipboard-based approaches)
- **Structured data** (thinking blocks, tool calls, metadata)
- **Complete history** (all requests/responses in one file)
- **Real-time updates** (file is written incrementally as response streams)

## Top-Level Structure

```json
{
  "version": 3,
  "sessionId": "2722d7f2-ad41-4a8b-958c-7e43f95dc7ea",
  "responderUsername": "GitHub Copilot",
  "responderAvatarIconUri": { "id": "copilot" },
  "initialLocation": "panel",
  "requests": [/* array of request/response pairs */],
  "creationDate": 1769444619441,
  "lastMessageDate": 1769444653893,
  "customTitle": "Simple greeting request",
  "hasPendingEdits": false,
  "inputState": {/* current input state */}
}
```

### Fields

| Field               | Type    | Description                                     |
| ------------------- | ------- | ----------------------------------------------- |
| `version`           | number  | Session file format version (currently 3)       |
| `sessionId`         | string  | Unique UUID for this session                    |
| `responderUsername` | string  | Display name ("GitHub Copilot")                 |
| `initialLocation`   | string  | Where chat opened ("panel", "editor", "window") |
| `requests`          | array   | Request/response pairs (see below)              |
| `creationDate`      | number  | Unix timestamp (ms)                             |
| `lastMessageDate`   | number  | Unix timestamp (ms) of last message             |
| `customTitle`       | string  | Auto-generated or user-set title                |
| `hasPendingEdits`   | boolean | Whether agent has pending file edits            |
| `inputState`        | object  | Current chat input state                        |

## Request Structure

Each request in the `requests` array contains:

```json
{
  "requestId": "request_15b5009a-ff7e-4f2c-ac5d-ae2d5612f870",
  "message": {
    "parts": [/* message parts */],
    "text": "just say hi please"
  },
  "variableData": {
    "variables": [/* attached files, instruction files */]
  },
  "response": [/* array of response items */],
  "agent": {/* agent metadata */},
  "timestamp": 1769444653892,
  "modelId": "copilot/oswe-vscode-prime",
  "responseId": "response_61a5c3fb-f789-4896-b65f-1379de7413f8",
  "result": {
    "timings": {/* timing data */},
    "metadata": {/* tool calls, cache, session info */},
    "errorDetails": {/* if error occurred */}
  }
}
```

### Key Fields

| Field                 | Type   | Description                                    |
| --------------------- | ------ | ---------------------------------------------- |
| `requestId`           | string | Unique ID for this request                     |
| `message.text`        | string | User's prompt text                             |
| `response`            | array  | Response items (see Response Item Types)       |
| `modelId`             | string | Model used (e.g., "copilot/claude-sonnet-4.5") |
| `result.timings`      | object | Performance metrics                            |
| `result.metadata`     | object | Tool calls, cache, reasoning                   |
| `result.errorDetails` | object | Error info if request failed/cancelled         |

## Response Item Types

The `response` array contains items of 5 different types:

### 1. MCP Server Start

Indicates MCP servers are starting (informational only).

```json
{
  "kind": "mcpServersStarting",
  "didStartServerIds": []
}
```

### 2. Thinking Block

Copilot's internal reasoning (may be encrypted or plaintext).

**Plaintext thinking:**

```json
{
  "kind": "thinking",
  "value": "The user wants me to review changes by checking git status and git diff...",
  "id": "1768667557222",
  "generatedTitle": "Checked git status and reviewed diffs"
}
```

**Encrypted thinking (skipped by parser):**

```json
{
  "kind": "thinking",
  "value": "fApshhj0S4BvSMtflmU7qThS0cjdOA10...",
  "id": "fApshhj0S4BvSMtflmU7qThS0cjdOA10...",
  "metadata": {
    "vscodeReasoningDone": true,
    "stopReason": "text"
  }
}
```

**Note:** Encrypted thinking starts with base64-like strings (100+ chars). ChatSessionParser filters these out.

### 3. Tool Preparation

Indicates a tool is about to be invoked (informational only).

```json
{
  "kind": "prepareToolInvocation",
  "toolName": "copilot_getChangedFiles"
}
```

### 4. Tool Invocation

Actual tool call with metadata.

```json
{
  "kind": "toolInvocationSerialized",
  "invocationMessage": {
    "value": "Reading changed files in the active git repository",
    "supportThemeIcons": false,
    "supportHtml": false
  },
  "pastTenseMessage": {
    "value": "Read changed files in the active git repository"
  },
  "isConfirmed": { "type": 1 },
  "isComplete": true,
  "source": {
    "type": "internal",
    "label": "Built-In"
  },
  "toolCallId": "faae5650-f151-4caa-ab06-6543aa3aff74",
  "toolId": "copilot_getChangedFiles"
}
```

**Tool arguments** are stored in `result.metadata.toolCallRounds`:

```json
{
  "result": {
    "metadata": {
      "toolCallRounds": [
        {
          "response": "I'll review the git changes...",
          "toolCalls": [
            {
              "name": "get_changed_files",
              "arguments": "{\"sourceControlState\": [\"unstaged\",\"staged\"]}",
              "id": "toolu_vrtx_01FC3L8iiv2nQH5FR8A3M7Eg__vscode-1768667249201"
            }
          ],
          "toolInputRetry": 0,
          "id": "e83b6709-b272-406f-8a1c-74c97d6cc54e",
          "thinking": {
            "text": "Planning text or encrypted",
            "tokens": 320
          }
        }
      ]
    }
  }
}
```

### 5. Text Response

Regular text output (no `kind` field).

```json
{
  "value": "Hi Nathan.",
  "supportThemeIcons": false,
  "supportHtml": false,
  "baseUri": {
    "$mid": 1,
    "path": "/c:/dev/FlightPath/",
    "scheme": "file"
  }
}
```

## Result Structure

The `result` object contains completion status, timings, and metadata:

```json
{
  "result": {
    "timings": {
      "firstProgress": 6321,
      "totalElapsed": 6422
    },
    "metadata": {
      "codeBlocks": [],
      "toolCallRounds": [/* see Tool Invocation section */],
      "modelMessageId": "c9864232-ef26-495e-82ed-3130b6d0a639",
      "responseId": "0800af3b-ffc4-4802-968d-2b02d68b0755",
      "sessionId": "5a00eb97-798e-4888-88c9-6d1735d5bf8e",
      "agentId": "github.copilot.editsAgent"
    },
    "details": "Raptor mini (Preview) • 0x",
    "errorDetails": {
      "code": "canceled",
      "message": "Canceled",
      "responseIsIncomplete": true
    }
  }
}
```

### Completion Detection

**A request is considered complete when:**

```javascript
result.timings.totalElapsed > 0;
```

This is the **100% reliable** method used by ChatSessionMonitor.

**Request states:**

- `totalElapsed === 0` → In progress
- `totalElapsed > 0` → Complete (success or error)
- `errorDetails.code === "canceled"` → User cancelled
- `errorDetails.code` (other) → Error occurred

## Parsing Strategy

ChatSessionParser converts session files to `UniversalCliOutput` format:

```typescript
{
  events: CliEvent[];        // Array of text/thinking/tool_use events
  sessionId: string;         // From sessionId field or filename
  model: string;             // Normalized (remove "copilot/" prefix)
  stopReason: "stop" | "error" | "cancelled" | "timeout";
  timings?: {
    totalElapsed: number;
    firstProgress?: number;
  };
  error?: string;            // From errorDetails.message
}
```

### Event Extraction Order

1. **Thinking blocks** → `{ type: "thinking", content: "..." }`
   - Skip encrypted (base64-like strings)
   - Use plaintext `value` field

2. **Tool calls** → `{ type: "tool_use", content: "...", toolCall: {...} }`
   - Extract from `toolInvocationSerialized` items
   - Get arguments from `result.metadata.toolCallRounds`

3. **Text responses** → `{ type: "text", content: "..." }`
   - Items without `kind` field
   - Use `value` field

4. **Skip informational items**:
   - `mcpServersStarting`
   - `prepareToolInvocation`

## Example: Complete Session File

```json
{
  "version": 3,
  "sessionId": "2722d7f2-ad41-4a8b-958c-7e43f95dc7ea",
  "requests": [
    {
      "requestId": "request_15b5009a-ff7e-4f2c-ac5d-ae2d5612f870",
      "message": { "text": "just say hi please" },
      "response": [
        {
          "kind": "mcpServersStarting",
          "didStartServerIds": []
        },
        {
          "kind": "thinking",
          "value": [],
          "id": "fApshhj0S4BvSMtflmU7qThS0cjdOA10..."
        },
        {
          "kind": "thinking",
          "value": "",
          "id": "",
          "metadata": {
            "vscodeReasoningDone": true,
            "stopReason": "text"
          }
        },
        {
          "value": "Hi Nathan.",
          "supportThemeIcons": false,
          "supportHtml": false
        }
      ],
      "modelId": "copilot/oswe-vscode-prime",
      "result": {
        "timings": {
          "firstProgress": 6321,
          "totalElapsed": 6422
        },
        "metadata": {
          "toolCallRounds": [
            {
              "response": "Hi Nathan.",
              "toolCalls": [],
              "thinking": {
                "text": [],
                "tokens": 320
              }
            }
          ]
        }
      }
    }
  ],
  "creationDate": 1769444619441,
  "lastMessageDate": 1769444653893
}
```

**Parsed output:**

```typescript
{
  events: [
    { type: "text", content: "Hi Nathan." }
  ],
  sessionId: "2722d7f2-ad41-4a8b-958c-7e43f95dc7ea",
  model: "oswe-vscode-prime",
  stopReason: "stop",
  timings: {
    totalElapsed: 6422,
    firstProgress: 6321
  }
}
```

## Usage in FlightPath

### ChatSessionMonitor

- **Discovery**: Finds session files by scanning `workspaceStorage/{id}/chatSessions/`
- **Monitoring**: Polls session file for `totalElapsed > 0`
- **Caching**: Tracks completed requests to avoid re-parsing

### ChatSessionParser

- **Parsing**: Reads session JSON and extracts structured events
- **Filtering**: Skips encrypted thinking, informational items
- **Conversion**: Transforms to `UniversalCliOutput` format

### CopilotChatIntegration

- **Extraction**: Calls `ChatSessionParser.extractResponse(sessionFile)`
- **Formatting**: Uses `CliOutputFormatter.toPlainText(output)` for output window
- **Event firing**: Emits formatted text via `responseCompleteEmitter`

## Model IDs

Common model IDs found in session files:

| Model ID                    | Display Name          | Notes            |
| --------------------------- | --------------------- | ---------------- |
| `copilot/claude-sonnet-4.5` | Claude Sonnet 4.5     | Most capable     |
| `copilot/claude-sonnet-4`   | Claude Sonnet 4       | Previous version |
| `copilot/claude-haiku-4.5`  | Claude Haiku 4.5      | Fastest          |
| `copilot/gpt-5`             | GPT-5                 | OpenAI model     |
| `copilot/oswe-vscode-prime` | Raptor mini (Preview) | Experimental     |

**Note:** ChatSessionParser normalizes model IDs by removing the `copilot/` prefix.

## Troubleshooting

### Session file not found

- Check if workspaceStorage directory exists
- Verify workspace ID matches current workspace
- Ensure Copilot Chat has been used at least once

### Empty response events

- Request may still be in progress (`totalElapsed === 0`)
- Check `result.errorDetails` for cancellation/errors
- Verify session file is valid JSON

### Encrypted thinking blocks

- These are intentionally encrypted by VS Code
- ChatSessionParser filters them out (base64-like strings)
- Plaintext thinking is available in some responses

## References

- **Implementation**: `src/flightpath/chat/ChatSessionParser.ts`
- **Monitoring**: `src/flightpath/chat/ChatSessionMonitor.ts`
- **Integration**: `src/flightpath/chat/CopilotChatIntegration.ts`
- **Tests**: `src/test/chatSessionParser.test.ts`
- **Type Definitions**: See `ChatSessionFile`, `ChatRequest`, `ChatResponseItem` interfaces

## Version History

| Date       | Author            | Changes                                                   |
| ---------- | ----------------- | --------------------------------------------------------- |
| 2026-01-28 | Claude Sonnet 4.5 | Initial documentation based on real session file analysis |
