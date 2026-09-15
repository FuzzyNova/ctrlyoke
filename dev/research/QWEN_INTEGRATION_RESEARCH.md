# Qwen Code CLI Integration Research

**Date:** March 13, 2026  
**Author:** FlightPath Research  
**Qwen Code Version:** 0.12.3

---

## Executive Summary

Qwen Code CLI is an open-source AI agent optimized for Qwen3-Coder models, providing an interactive terminal UI and headless mode for automation. It shares architectural similarities with Claude Code CLI and Copilot CLI, making it a strong candidate for FlightPath harness integration.

**Key Findings:**

- ✅ **Structured output formats:** Supports `text`, `json`, and `stream-json` output modes
- ✅ **Session management:** Project-scoped sessions with JSONL log files
- ✅ **Experimental hooks:** `--experimental-hooks` flag enables lifecycle event customization
- ✅ **Tool call tracking:** Detailed tool execution events with permission denial handling
- ⚠️ **Hooks still emerging:** Hook system is experimental, less mature than Claude/Copilot
- ⚠️ **No native sessionEnd/Stop hooks:** Unlike Claude/Copilot, Qwen doesn't yet support session lifecycle hooks in stable releases

---

## 1. Qwen CLI Output Format Examples

### 1.1 Text Output (Default)

```bash
qwen -p "just say hi"
```

**Output:**

```
Hi!
```

**Characteristics:**

- Human-readable plain text
- No structured metadata
- Suitable for direct terminal display
- Not suitable for programmatic parsing

---

### 1.2 JSON Output (Buffered)

```bash
qwen -p "just say hi" --output-format json
```

**Output (single JSON array):**

```json
[
  {
    "type": "system",
    "subtype": "init",
    "uuid": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
    "session_id": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
    "cwd": "C:\\dev\\FlightPath",
    "tools": [
      "task",
      "skill",
      "list_directory",
      "read_file",
      "grep_search",
      "glob",
      "save_memory",
      "todo_write",
      "ask_user_question",
      "exit_plan_mode",
      "web_fetch",
      "web_search"
    ],
    "mcp_servers": [],
    "model": "coder-model",
    "permission_mode": "default",
    "slash_commands": ["bug", "compress", "init", "summary"],
    "qwen_code_version": "0.12.3",
    "agents": ["general-purpose"]
  },
  {
    "type": "assistant",
    "uuid": "38368205-db8d-4520-a63e-15afd94191e1",
    "session_id": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
    "parent_tool_use_id": null,
    "message": {
      "id": "38368205-db8d-4520-a63e-15afd94191e1",
      "type": "message",
      "role": "assistant",
      "model": "coder-model",
      "content": [
        {
          "type": "thinking",
          "thinking": "The user is asking me to simply say hi, which is a straightforward greeting that doesn't require any tools or complex reasoning.",
          "signature": ""
        }
      ],
      "stop_reason": null,
      "usage": {
        "input_tokens": 0,
        "output_tokens": 0
      }
    }
  },
  {
    "type": "assistant",
    "uuid": "8502dcb9-d080-473b-bcd5-18340bc58222",
    "session_id": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
    "parent_tool_use_id": null,
    "message": {
      "id": "8502dcb9-d080-473b-bcd5-18340bc58222",
      "type": "message",
      "role": "assistant",
      "model": "coder-model",
      "content": [
        {
          "type": "text",
          "text": "Hi!"
        }
      ],
      "stop_reason": null,
      "usage": {
        "input_tokens": 16793,
        "output_tokens": 32,
        "cache_read_input_tokens": 16787,
        "total_tokens": 16825
      }
    }
  },
  {
    "type": "result",
    "subtype": "success",
    "uuid": "e98e9569-e147-4c24-bc98-ca7d9e8f4c9a",
    "session_id": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
    "is_error": false,
    "duration_ms": 3669,
    "duration_api_ms": 3261,
    "num_turns": 1,
    "result": "Hi!",
    "usage": {
      "input_tokens": 16793,
      "output_tokens": 32,
      "cache_read_input_tokens": 16787,
      "total_tokens": 16825
    },
    "permission_denials": [],
    "stats": {
      "models": {
        "coder-model": {
          "api": {
            "totalRequests": 1,
            "totalErrors": 0,
            "totalLatencyMs": 3143
          },
          "tokens": {
            "prompt": 16793,
            "candidates": 32,
            "total": 16825,
            "cached": 16787,
            "thoughts": 25,
            "tool": 0
          }
        }
      },
      "tools": {
        "totalCalls": 0,
        "totalSuccess": 0,
        "totalFail": 0,
        "totalDurationMs": 0,
        "totalDecisions": {
          "accept": 0,
          "reject": 0,
          "modify": 0,
          "auto_accept": 0
        },
        "byName": {}
      },
      "files": {
        "totalLinesAdded": 0,
        "totalLinesRemoved": 0
      }
    }
  }
]
```

**Characteristics:**

- Buffered until session completes
- Full message structure with thinking blocks
- Comprehensive usage statistics
- Tool call tracking and permission denials
- Session ID available in all events

---

### 1.3 Stream-JSON Output (Real-time)

```bash
qwen -p "just say hi" --output-format stream-json
```

**Output (line-delimited JSON):**

```json
{"type":"system","subtype":"init","uuid":"41cd70cc-bfab-407c-8f2b-d45e0356e4f3","session_id":"41cd70cc-bfab-407c-8f2b-d45e0356e4f3","cwd":"C:\\dev\\FlightPath","tools":["task","skill","list_directory","read_file","grep_search","glob","save_memory","todo_write","ask_user_question","exit_plan_mode","web_fetch","web_search"],"mcp_servers":[],"model":"coder-model","permission_mode":"default","slash_commands":["bug","compress","init","summary"],"qwen_code_version":"0.12.3","agents":["general-purpose"]}
{"type":"assistant","uuid":"7eb0464e-0a03-4362-bbaf-e8afd99f3bd1","session_id":"41cd70cc-bfab-407c-8f2b-d45e0356e4f3","parent_tool_use_id":null,"message":{"id":"7eb0464e-0a03-4362-bbaf-e8afd99f3bd1","type":"message","role":"assistant","model":"coder-model","content":[{"type":"thinking","thinking":"The user wants me to simply say hi, so I'll respond with a brief greeting.","signature":""}],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"assistant","uuid":"77edce00-022d-495c-abd7-f202ea971009","session_id":"41cd70cc-bfab-407c-8f2b-d45e0356e4f3","parent_tool_use_id":null,"message":{"id":"77edce00-022d-495c-abd7-f202ea971009","type":"message","role":"assistant","model":"coder-model","content":[{"type":"text","text":"Hi!"}],"stop_reason":null,"usage":{"input_tokens":16793,"output_tokens":25,"cache_read_input_tokens":16787,"total_tokens":16818}}}
{"type":"result","subtype":"success","uuid":"c936553a-e405-4569-842c-f80cc20908e5","session_id":"41cd70cc-bfab-407c-8f2b-d45e0356e4f3","is_error":false,"duration_ms":2848,"duration_api_ms":2447,"num_turns":1,"result":"Hi!","usage":{"input_tokens":16793,"output_tokens":25,"cache_read_input_tokens":16787,"total_tokens":16818},"permission_denials":[]}
```

**With File Creation (Tool Calls):**

```bash
qwen -p "create a file called test.txt with hello world" --output-format stream-json
```

**Output:**

````json
{"type":"system","subtype":"init","uuid":"b88b510e-6772-4711-b9eb-9dd2f3847398","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","cwd":"C:\\dev\\FlightPath","tools":[...],"model":"coder-model","permission_mode":"default","qwen_code_version":"0.12.3","agents":["general-purpose"]}
{"type":"assistant","uuid":"aba91155-a16d-417e-a53e-aaa6d3492678","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","parent_tool_use_id":null,"message":{"id":"aba91155-a16d-417e-a53e-aaa6d3492678","type":"message","role":"assistant","model":"coder-model","content":[{"type":"thinking","thinking":"The user wants me to create a simple text file with 'hello world' content, so I'll use the write_file tool to create test.txt in the project root.","signature":""}],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"assistant","uuid":"0084e4a0-8a17-462e-a0d4-d0b9a5e2fc07","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","parent_tool_use_id":null,"message":{"id":"0084e4a0-8a17-462e-a0d4-d0b9a5e2fc07","type":"message","role":"assistant","model":"coder-model","content":[{"type":"tool_use","id":"call_a13017656c614f3194313500","name":"write_file","input":{"absolute_path":"C:\\dev\\FlightPath\\test.txt","content":"hello world"}}],"stop_reason":"tool_use","usage":{"input_tokens":16799,"output_tokens":87,"cache_read_input_tokens":16486,"total_tokens":16886}}}
{"type":"user","uuid":"25a046b4-eb26-4aa8-b8e4-c23c453b187e","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_a13017656c614f3194313500","is_error":true,"content":"Qwen Code requires permission to use write_file, but that permission was declined."}]}}
{"type":"assistant","uuid":"ae03a4ac-5e75-422f-b9ce-6df40d73b6f7","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","parent_tool_use_id":null,"message":{"id":"ae03a4ac-5e75-422f-b9ce-6df40d73b6f7","type":"message","role":"assistant","model":"coder-model","content":[{"type":"thinking","thinking":"The write_file tool was declined, so I should use a shell command as an alternative to create the file.","signature":""}],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"assistant","uuid":"0d732db0-2bd5-44f9-8299-7bcc2f1d8284","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","parent_tool_use_id":null,"message":{"id":"0d732db0-2bd5-44f9-8299-7bcc2f1d8284","type":"message","role":"assistant","model":"coder-model","content":[{"type":"text","text":"I don't have permission to write files directly. You can create it manually:\n\n```bash\necho hello world > test.txt\n```\n\nOr in PowerShell:\n```powershell\n\"hello world\" > test.txt\n```"}],"stop_reason":null,"usage":{"input_tokens":16916,"output_tokens":74,"cache_read_input_tokens":16793,"total_tokens":16990}}}
{"type":"result","subtype":"success","uuid":"43613464-ea48-40c9-8ae5-b75116bca143","session_id":"b88b510e-6772-4711-b9eb-9dd2f3847398","is_error":false,"duration_ms":7661,"duration_api_ms":7212,"num_turns":2,"result":"I don't have permission to write files directly. You can create it manually:\n\n```bash\necho hello world > test.txt\n```\n\nOr in PowerShell:\n```powershell\n\"hello world\" > test.txt\n```","usage":{"input_tokens":33715,"output_tokens":161,"cache_read_input_tokens":33279,"total_tokens":33876},"permission_denials":[{"tool_name":"write_file","tool_use_id":"call_a13017656c614f3194313500","tool_input":{"absolute_path":"C:\\dev\\FlightPath\\test.txt","content":"hello world"}}]}
````

**Characteristics:**

- Line-delimited JSON (NDJSON format)
- Real-time streaming (events emitted as they occur)
- Same structure as JSON output, but streamed
- Ideal for real-time UI updates and monitoring

---

### 1.4 Output Format Comparison

| Feature             | Text | JSON            | Stream-JSON   |
| ------------------- | ---- | --------------- | ------------- |
| Human-readable      | ✅   | ⚠️ (formatted)  | ⚠️ (per-line) |
| Machine-parseable   | ❌   | ✅              | ✅            |
| Real-time streaming | ✅   | ❌ (buffered)   | ✅            |
| Thinking blocks     | ❌   | ✅              | ✅            |
| Tool calls          | ❌   | ✅              | ✅            |
| Usage statistics    | ❌   | ✅ (final only) | ✅ (per-turn) |
| Session ID          | ❌   | ✅              | ✅            |
| Permission denials  | ❌   | ✅              | ✅            |
| Duration tracking   | ❌   | ✅              | ✅            |

**Recommendation:** Use `--output-format stream-json` for FlightPath integration to enable real-time streaming and structured parsing.

---

## 2. Log File Format and Location

### 2.1 Log File Location

**Path Pattern:**

```
~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl
```

**Example (Windows):**

```
C:\Users\natha\.qwen\projects\c--dev-flightpath\chats\0775cdf1-cb74-4400-8382-b465b3c0a8ac.jsonl
```

**Sanitization:**

- Drive letters converted to lowercase with dashes (e.g., `C:\dev\flightpath` → `c--dev-flightpath`)
- Backslashes converted to dashes

### 2.2 Log File Format (JSONL)

Each line is a JSON object representing a single event.

**Event Types:**

#### 2.2.1 User Message Event

```json
{
  "uuid": "a80e34ab-5c8b-4a6e-8d19-389410db988c",
  "parentUuid": null,
  "sessionId": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
  "timestamp": "2026-03-13T17:54:08.468Z",
  "type": "user",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "message": {
    "role": "user",
    "parts": [
      {
        "text": "just say hi"
      }
    ]
  }
}
```

#### 2.2.2 System Event (UI Telemetry)

```json
{
  "uuid": "65d6b6a9-1c45-4169-8687-3dd701542057",
  "parentUuid": "a80e34ab-5c8b-4a6e-8d19-389410db988c",
  "sessionId": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
  "timestamp": "2026-03-13T17:54:11.652Z",
  "type": "system",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "subtype": "ui_telemetry",
  "systemPayload": {
    "uiEvent": {
      "event.name": "qwen-code.api_response",
      "event.timestamp": "2026-03-13T17:54:11.652Z",
      "response_id": "chatcmpl-225dff17-46e5-4518-b6c4-b18fb7114a0f",
      "model": "coder-model",
      "status_code": 200,
      "duration_ms": 3143,
      "input_token_count": 16793,
      "output_token_count": 32,
      "cached_content_token_count": 16787,
      "thoughts_token_count": 25,
      "tool_token_count": 0,
      "total_token_count": 16825,
      "prompt_id": "fb3fa8d964fb7",
      "auth_type": "qwen-oauth"
    }
  }
}
```

#### 2.2.3 Assistant Message Event

```json
{
  "uuid": "968b9ec0-4948-40f6-a27d-a6f9b76586ed",
  "parentUuid": "65d6b6a9-1c45-4169-8687-3dd701542057",
  "sessionId": "0775cdf1-cb74-4400-8382-b465b3c0a8ac",
  "timestamp": "2026-03-13T17:54:11.696Z",
  "type": "assistant",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "model": "coder-model",
  "message": {
    "role": "model",
    "parts": [
      {
        "text": "The user is asking me to simply say hi...",
        "thought": true
      },
      {
        "text": "Hi!"
      }
    ]
  },
  "usageMetadata": {
    "promptTokenCount": 16793,
    "candidatesTokenCount": 32,
    "thoughtsTokenCount": 25,
    "totalTokenCount": 16825,
    "cachedContentTokenCount": 16787
  }
}
```

#### 2.2.4 Assistant Message with Tool Use

```json
{
  "uuid": "cf87aee5-018d-4ccf-ad83-40fcfff9a331",
  "parentUuid": "2496be90-c35e-4ca9-816a-2cbefc2e396a",
  "sessionId": "b88b510e-6772-4711-b9eb-9dd2f3847398",
  "timestamp": "2026-03-13T17:54:24.109Z",
  "type": "assistant",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "model": "coder-model",
  "message": {
    "role": "model",
    "parts": [
      {
        "text": "The user wants me to create a simple text file...",
        "thought": true
      },
      {
        "functionCall": {
          "id": "call_a13017656c614f3194313500",
          "name": "write_file",
          "args": {
            "absolute_path": "C:\\dev\\FlightPath\\test.txt",
            "content": "hello world"
          }
        }
      }
    ]
  },
  "usageMetadata": {
    "promptTokenCount": 16799,
    "candidatesTokenCount": 87,
    "thoughtsTokenCount": 34,
    "totalTokenCount": 16886,
    "cachedContentTokenCount": 16486
  }
}
```

#### 2.2.5 System Event (Tool Call Telemetry)

```json
{
  "uuid": "ef7ae55e-9ca2-41cb-86cb-cd80418afa56",
  "parentUuid": "cf87aee5-018d-4ccf-ad83-40fcfff9a331",
  "sessionId": "b88b510e-6772-4711-b9eb-9dd2f3847398",
  "timestamp": "2026-03-13T17:54:24.144Z",
  "type": "system",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "subtype": "ui_telemetry",
  "systemPayload": {
    "uiEvent": {
      "event.name": "qwen-code.tool_call",
      "event.timestamp": "2026-03-13T17:54:24.144Z",
      "function_name": "write_file",
      "function_args": {
        "absolute_path": "C:\\dev\\FlightPath\\test.txt",
        "content": "hello world"
      },
      "duration_ms": 0,
      "status": "error",
      "success": false,
      "error": "Qwen Code requires permission to use write_file, but that permission was declined.",
      "error_type": "execution_denied",
      "prompt_id": "8db6b19c54365",
      "response_id": "chatcmpl-34646894-e06d-415b-977c-171e26002483",
      "tool_type": "native",
      "content_length": 82
    }
  }
}
```

#### 2.2.6 Tool Result Event

```json
{
  "uuid": "e98c6e64-bbab-4c6e-9540-1e62d3f502d5",
  "parentUuid": "ef7ae55e-9ca2-41cb-86cb-cd80418afa56",
  "sessionId": "b88b510e-6772-4711-b9eb-9dd2f3847398",
  "timestamp": "2026-03-13T17:54:24.176Z",
  "type": "tool_result",
  "cwd": "C:\\dev\\FlightPath",
  "version": "0.12.3",
  "gitBranch": "main",
  "message": {
    "role": "user",
    "parts": [
      {
        "functionResponse": {
          "id": "call_a13017656c614f3194313500",
          "name": "write_file",
          "response": {
            "error": "Qwen Code requires permission to use write_file, but that permission was declined."
          }
        }
      }
    ]
  },
  "toolCallResult": {
    "callId": "call_a13017656c614f3194313500",
    "status": "error",
    "resultDisplay": "Qwen Code requires permission to use write_file, but that permission was declined.",
    "error": {},
    "errorType": "execution_denied"
  }
}
```

### 2.3 Event Type Summary

| Event Type    | Purpose               | Key Fields                                           |
| ------------- | --------------------- | ---------------------------------------------------- |
| `user`        | User prompt           | `message.parts[].text`                               |
| `assistant`   | AI response           | `message.parts[]`, `usageMetadata`                   |
| `system`      | Telemetry/events      | `subtype`, `systemPayload.uiEvent`                   |
| `tool_result` | Tool execution result | `toolCallResult`, `message.parts[].functionResponse` |

**System Event Subtypes:**

- `ui_telemetry` - API responses, tool calls, authentication events

---

## 3. Completion Detection Strategy

### 3.1 Current State (v0.12.3)

**Qwen Code does NOT yet support session lifecycle hooks** (SessionStart, Stop) in stable releases. This is a critical difference from Claude Code and Copilot CLI.

**Available completion detection methods:**

#### 3.1.1 Process Exit (Headless Mode) - ✅ RECOMMENDED

```bash
qwen -p "prompt" --output-format stream-json
# Process exit = completion
```

**Pros:**

- Reliable and deterministic
- No configuration needed
- Works in all modes

**Cons:**

- Only available in headless mode
- No intermediate state tracking

#### 3.1.2 Log File Monitoring (Interactive Mode) - ⚠️ FALLBACK

Monitor the JSONL log file for the final `result` event or process termination.

**Approach:**

1. Discover log file via session ID or prompt matching
2. Tail the file for new events
3. Detect completion when:
   - `type: "result"` event appears (JSON/Stream-JSON output)
   - No new events for N seconds (timeout-based)
   - Process exits (interactive mode with stdio monitoring)

**Pros:**

- Works in interactive mode
- Provides real-time progress tracking

**Cons:**

- Less reliable than hook-based detection
- Requires file system polling
- May have race conditions with concurrent sessions

#### 3.1.3 Experimental Hooks - 🔮 FUTURE

```bash
qwen --experimental-hooks ...
```

**Status:** Experimental (as of v0.12.3)

**What we know:**

- `qwen hooks` command exists for enable/disable
- Feature request #268 tracks "Claude-like hooks" implementation
- Suggested protocol (from GitHub issue):
  ```json
  {
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": ["node", "path/to/script.js"]
        }
      ],
      "PostToolUse": [...],
      "Stop": [...],
      "SessionStart": [...]
    }
  }
  ```

**Implementation blockers:**

- No stable documentation for hook configuration
- Unknown hook event names and payload structure
- No confirmation that SessionStart/Stop hooks are implemented vs. planned

**Recommendation:** Do NOT rely on experimental hooks for production integration. Use process exit and log file monitoring as primary completion detection.

---

### 3.2 Recommended Completion Detection Strategy

#### Headless Mode (Primary)

```typescript
// Spawn with --output-format stream-json
// Monitor stdout for JSONL events
// Process exit = completion

const result = await spawn("qwen", [
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  ...otherArgs,
]);

// When process exits, parse accumulated JSONL events
// Look for final {"type": "result", ...} event
```

#### Interactive Mode (Fallback)

```typescript
// 1. Record start time before spawning
// 2. Spawn CLI in terminal (TUI for user)
// 3. Discover log file via session ID or prompt matching
// 4. Poll log file for new events
// 5. Detect completion when:
//    - No new events for 30+ seconds (inactivity timeout)
//    - Process exits (monitor via shell integration)

// Log file path: ~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl
```

---

## 4. Hook System Capabilities

### 4.1 Current Hook Support (v0.12.3)

**Status:** **IMPLEMENTED** - 10 core lifecycle hooks (per arxiv paper 2603.05344v1, March 2026)

**Hook Event Types:**

1. `SessionStart` - Session initialization
2. `UserPromptSubmit` - User submits prompt
3. `PreToolUse` - Before tool execution (blocking)
4. `PostToolUse` - After tool execution
5. `PostToolUseFailure` - After tool execution fails
6. `SubagentStart` - Subagent invocation
7. `SubagentStop` - Subagent completion
8. `Stop` - Session completion (critical for FlightPath completion detection)
9. `PreCompact` - Before context compaction
10. `SessionEnd` - Session cleanup

**Configuration:**

- Location: `~/.qwen/settings.json` (global) or `<project>/.qwen/settings.json` (project)
- Format: JSON (similar to Claude Code)
- Hook commands receive event context on **stdin as JSON**

**Hook Capabilities:**

- **Blocking events** (e.g., `PreToolUse`): Can prevent operation with exit code 2
- **Mutation**: Can modify tool arguments via stdout JSON with `tool_input` key
- **Override**: Can override approval decisions

**What's Still Unknown:**

- ⚠️ Exact JSON schema for settings.json configuration
- ⚠️ Notification file mechanism (if any) - Claude uses `{sessionId}-start.json`, `{sessionId}-stop.json`
- ⚠️ Complete stdin payload schema for each hook type
- ⚠️ Working example configurations

**Comparison to Claude Code:**

| Feature             | Qwen Code           | Claude Code                                          |
| ------------------- | ------------------- | ---------------------------------------------------- |
| Hook types          | 10 lifecycle events | 11+ lifecycle events                                 |
| Configuration       | settings.json       | settings.json                                        |
| Stdin payload       | JSON event context  | JSON event context                                   |
| Blocking capability | ✅ (exit code 2)    | ✅ (exit code 2)                                     |
| Mutation capability | ✅ (tool_input)     | ✅ (tool_input)                                      |
| Notification files  | ⚠️ Unconfirmed      | ✅ `{sessionId}-start.json`, `{sessionId}-stop.json` |

**Recommendation:** Hooks ARE production-ready in Qwen Code v0.12.3. However, for FlightPath Phase 1, still use **process exit + log file monitoring** as primary completion detection because:

1. Hook configuration schema not documented
2. Notification file mechanism unconfirmed (critical for non-blocking completion detection)
3. Phase 3 can implement hooks once we reverse-engineer the configuration format

**Next Steps for Phase 3:**

1. Test Qwen Code hooks with manual configuration in `~/.qwen/settings.json`
2. Reverse-engineer stdin payload schema by logging hook input
3. Determine if notification files are used or if polling is required
4. Implement `QwenHookManager` based on findings

### 4.2 Comparison to Existing Harnesses

| Feature              | Qwen Code             | Claude Code                                          | Copilot CLI                                          |
| -------------------- | --------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| SessionStart hook    | ✅                    | ✅                                                   | ✅                                                   |
| Stop/SessionEnd hook | ✅                    | ✅                                                   | ✅                                                   |
| PreToolUse hook      | ✅                    | ✅                                                   | ❌                                                   |
| PostToolUse hook     | ✅                    | ✅                                                   | ❌                                                   |
| Hook config format   | JSON (settings.json)  | JSON (settings.json)                                 | JSON object (.github/hooks/)                         |
| Hook config location | ~/.qwen/settings.json | ~/.claude/settings.json                              | .github/hooks/                                       |
| Notification files   | ⚠️ Unconfirmed        | ✅ `{sessionId}-start.json`, `{sessionId}-stop.json` | ✅ `{sessionId}-start.json`, `{sessionId}-stop.json` |
| Total hook types     | 10 lifecycle events   | 11+ lifecycle events                                 | 2 (SessionStart, Stop)                               |
| Stdin payload        | JSON event context    | JSON event context                                   | JSON event context                                   |
| Blocking capability  | ✅ (exit code 2)      | ✅ (exit code 2)                                     | ✅ (exit code 2)                                     |
| Mutation capability  | ✅ (tool_input)       | ✅ (tool_input)                                      | ❌                                                   |

### 4.3 Hook Implementation Recommendation

**Phase 1 (Initial Integration):**

- Do NOT implement hook-based completion detection
- Use process exit (headless) and log file monitoring (interactive)
- Focus on stream-json parsing and session management

**Phase 2 (Future Enhancement):**

- Monitor Qwen Code releases for stable hook documentation
- Implement hooks when:
  - Official documentation published
  - Hook event names and payloads confirmed
  - Configuration format stabilized

**Phase 3 (Advanced Features):**

- Implement PreToolUse/PostToolUse hooks for tool approval workflows
- Implement SessionStart hook for immediate session ID extraction
- Implement Stop hook for reliable completion detection

---

## 5. Session Management

### 5.1 Session ID Format

**Format:** UUID v4
**Example:** `0775cdf1-cb74-4400-8382-b465b3c0a8ac`

**Availability:**

- ✅ Included in all stdout events (JSON/Stream-JSON modes)
- ✅ Included in all log file events
- ✅ Available in `result` event for final extraction

### 5.2 Session Resumption

**CLI Flags:**

```bash
# Resume most recent session (project-scoped)
qwen --continue -p "Pick up where we left off"

# Resume specific session by ID
qwen --resume <session-id> -p "Continue..."
```

**Session Storage:**

- Location: `~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl`
- Format: JSONL (append-only)
- Scope: Per-project (based on cwd)

### 5.3 Session Discovery

**Method 1: Session ID from stdout (Headless)**

```json
{"type":"system","subtype":"init","session_id":"0775cdf1-cb74-4400-8382-b465b3c0a8ac",...}
```

**Method 2: Log file matching (Interactive)**

1. Find recently modified files in `~/.qwen/projects/<sanitized-cwd>/chats/`
2. Read first 10 events from each candidate
3. Match `user.message.parts[].text` against prompt (first 100 chars)
4. Extract `sessionId` from matching file

**Method 3: Prompt matching in log events**

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "parts": [{ "text": "just say hi" }]
  },
  "sessionId": "0775cdf1-cb74-4400-8382-b465b3c0a8ac"
}
```

---

## 6. Tool Permission System

### 6.1 Permission Modes

**CLI Flags:**

```bash
# Auto-approve all tools (YOLO mode)
qwen -y -p "prompt"

# Set approval mode
qwen --approval-mode <mode> -p "prompt"
# Modes: plan, default, auto-edit, yolo
```

**Permission Denial Tracking:**

```json
{
  "type": "result",
  "permission_denials": [
    {
      "tool_name": "write_file",
      "tool_use_id": "call_a13017656c614f3194313500",
      "tool_input": {
        "absolute_path": "C:\\dev\\FlightPath\\test.txt",
        "content": "hello world"
      }
    }
  ]
}
```

### 6.2 Tool Call Events

**Assistant Message with Tool Use:**

```json
{
  "type": "assistant",
  "message": {
    "parts": [
      {
        "functionCall": {
          "id": "call_a13017656c614f3194313500",
          "name": "write_file",
          "args": { "absolute_path": "...", "content": "..." }
        }
      }
    ]
  }
}
```

**Tool Result:**

```json
{
  "type": "tool_result",
  "toolCallResult": {
    "callId": "call_a13017656c614f3194313500",
    "status": "error",
    "resultDisplay": "Qwen Code requires permission...",
    "errorType": "execution_denied"
  }
}
```

**System Telemetry (Tool Call):**

```json
{
  "type": "system",
  "subtype": "ui_telemetry",
  "systemPayload": {
    "uiEvent": {
      "event.name": "qwen-code.tool_call",
      "function_name": "write_file",
      "status": "error",
      "success": false,
      "error": "Qwen Code requires permission...",
      "error_type": "execution_denied"
    }
  }
}
```

### 6.3 Comparison to Existing Harnesses

| Feature                    | Qwen Code                           | Claude Code                              | Copilot CLI                    |
| -------------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------ |
| Permission modes           | ✅ (plan, default, auto-edit, yolo) | ✅ (default, auto-edit, yolo)            | ✅ (default, custom)           |
| Tool allow/deny lists      | ⚠️ (via --allowed-tools)            | ✅ (--allowed-tools, --disallowed-tools) | ✅ (--allow-tool, --deny-tool) |
| Permission denial tracking | ✅ (permission_denials array)       | ✅ (toolUseResult metadata)              | ✅ (tool.execution_complete)   |
| Granular tool permissions  | ❌ (mode-based)                     | ✅ (per-tool patterns)                   | ✅ (per-tool patterns)         |

---

## 7. Comparison to Existing Harnesses

### 7.1 Architecture Comparison

| Aspect                  | Qwen Code                           | Claude Code                     | Copilot CLI                              |
| ----------------------- | ----------------------------------- | ------------------------------- | ---------------------------------------- |
| Output formats          | text, json, stream-json             | text, stream-json               | text, json                               |
| Log file format         | JSONL (single file per session)     | JSONL (single file per session) | JSONL (events.jsonl in session dir)      |
| Log file location       | `~/.qwen/projects/<cwd>/chats/`     | `~/.claude/projects/<cwd>/`     | `~/.copilot/session-state/<session-id>/` |
| Session ID in output    | ✅ (all events)                     | ✅ (all events)                 | ❌ (log file only)                       |
| Session lifecycle hooks | ❌ (experimental)                   | ✅ (SessionStart, Stop)         | ✅ (sessionStart, sessionEnd)            |
| Completion detection    | Process exit, log monitoring        | Stop hook, log monitoring       | sessionEnd hook, log monitoring          |
| Tool call format        | `functionCall` in `message.parts[]` | `tool_use` content block        | `toolRequests` in `assistant.message`    |
| Usage statistics        | ✅ (per-turn in events)             | ✅ (final in usage)             | ✅ (session.truncation events)           |

### 7.2 Integration Complexity

| Component              | Qwen Code                    | Claude Code              | Copilot CLI             |
| ---------------------- | ---------------------------- | ------------------------ | ----------------------- |
| CLI Provider           | Medium                       | Medium                   | Medium                  |
| Response Parser        | Medium (functionCall format) | Medium (tool_use blocks) | Medium (toolRequests)   |
| Notification Monitor   | ❌ (not available)           | ✅ (Stop hook)           | ✅ (sessionEnd hook)    |
| Log Parser             | Medium (4 event types)       | Medium (6 event types)   | Complex (9 event types) |
| Tool Permission Mapper | Simple (mode-based)          | Complex (pattern-based)  | Complex (pattern-based) |

### 7.3 Key Differences

**Qwen Code Advantages:**

- ✅ Session ID in all stdout events (no log file parsing needed)
- ✅ Stream-json mode with real-time per-turn usage statistics
- ✅ Comprehensive telemetry in system events
- ✅ Simpler permission model (mode-based)

**Qwen Code Disadvantages:**

- ❌ No stable hook system (completion detection challenge)
- ❌ Less mature ecosystem (fewer integrations, less documentation)
- ❌ No granular tool permissions (mode-based only)
- ❌ Unknown context window limits (not exposed in events)

---

## 8. Recommended Implementation Approach

### 8.1 Phase 1: Core Integration (MVP)

**Files to Create:**

```
src/flightpath/harness/qwen/
├── QwenCliProvider.ts          # Main provider implementation
├── QwenResponseParser.ts       # Parse stream-json output
├── QwenLogParser.ts            # Parse JSONL log files
├── QwenToolPermissionMapper.ts # Map permissions to CLI args
└── (no notification monitor - not supported)
```

**Key Implementation Decisions:**

1. **Headless Mode (Primary):**

   ```typescript
   buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
     return [
       `"${prompt}"`,
       "--output-format",
       "stream-json",
       ...baseArgs
     ];
   }
   ```

2. **Completion Detection:**
   - Headless: Process exit + final `result` event
   - Interactive: Log file monitoring with inactivity timeout

3. **Session ID Extraction:**

   ```typescript
   // From stdout (stream-json mode)
   const sessionId = events.find((e) => e.type === "system")?.session_id;

   // Fallback: from log file
   const sessionId = logEvents.find((e) => e.sessionId)?.sessionId;
   ```

4. **Response Parsing:**

   ```typescript
   // Parse stream-json events
   extractResponse(events: BaseCliEvent[]): UniversalCliOutput {
     const outputEvents: CliEvent[] = [];
     let sessionId: string | undefined;
     let usage = { inputTokens: 0, outputTokens: 0 };

     for (const event of events) {
       if (event.type === "system") {
         sessionId = event.session_id;
       }
       if (event.type === "assistant") {
         // Extract text from message.parts[]
         for (const part of event.message.parts) {
           if (part.text && !part.thought) {
             outputEvents.push({ type: TEXT, data: { text: part.text } });
           }
           if (part.thought) {
             outputEvents.push({ type: THINKING, data: { text: part.text } });
           }
           if (part.functionCall) {
             outputEvents.push({
               type: TOOL_CALL,
               data: {
                 toolCallId: part.functionCall.id,
                 name: part.functionCall.name,
                 parameters: part.functionCall.args
               }
             });
           }
         }
       }
       if (event.type === "result") {
         usage = {
           inputTokens: event.usage?.input_tokens || 0,
           outputTokens: event.usage?.output_tokens || 0
         };
       }
     }

     return { events: outputEvents, metadata: { sessionId, usage } };
   }
   ```

### 8.2 Phase 2: Interactive Mode Enhancement

**Add log file monitoring:**

```typescript
class QwenLogParser extends BaseLogParser {
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    // Path: ~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl
    if (sessionId) {
      const sanitizedCwd = this.sanitizeCwd(this.workspaceRoot!);
      return path.join(
        os.homedir(),
        ".qwen",
        "projects",
        sanitizedCwd,
        "chats",
        `${sessionId}.jsonl`
      );
    }

    // Fallback: prompt matching
    const chatsDir = path.join(
      os.homedir(),
      ".qwen",
      "projects",
      this.sanitizeCwd(this.workspaceRoot!),
      "chats"
    );

    // Find recently modified files, match prompt text
    return this.findLogByPromptMatch(chatsDir, promptText, startTime);
  }

  private sanitizeCwd(cwd: string): string {
    return cwd
      .replace(/^[A-Za-z]:/, (d) => d.toLowerCase())
      .replace(/\\/g, "-");
  }
}
```

### 8.3 Phase 3: Hook Support (Future)

**When hooks become stable:**

```typescript
class QwenNotificationMonitor extends NotificationMonitorBase {
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // TBD - depends on Qwen's final hook format
    return {
      type: "json", // or "json-string"?
      config: {
        hooks: {
          SessionStart: [...],
          Stop: [...]
        }
      }
    };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(
      workspaceRoot,
      ".flightpath",
      "temp",
      "qwen-notifications"
    );
  }
}
```

---

## 9. Blockers and Unknown Factors

### 9.1 Critical Blockers

| Blocker                     | Impact                                     | Mitigation                        | Status                  |
| --------------------------- | ------------------------------------------ | --------------------------------- | ----------------------- |
| No stable hook system       | Cannot use hook-based completion detection | Use process exit + log monitoring | ⚠️ Workaround available |
| No hook documentation       | Cannot implement notification monitor      | Wait for official docs            | 🔴 Blocked              |
| Unknown hook payload format | Cannot write hook scripts                  | Monitor Qwen releases             | 🔴 Blocked              |

### 9.2 Unknown Factors

| Unknown                | Investigation Needed                                      |
| ---------------------- | --------------------------------------------------------- |
| Context window limits  | Check if exposed in system events or settings             |
| Model selection format | Verify `--model` flag behavior with different providers   |
| MCP server support     | Test `--mcp-config` or equivalent                         |
| Sandbox mode           | Investigate `--sandbox` flag capabilities                 |
| Extension system       | Understand `--extensions` and `--list-extensions`         |
| ACP mode               | Investigate `--acp` flag for agent communication protocol |

### 9.3 Research Questions

1. **Does Qwen Code support custom model providers?** (OpenAI, Anthropic, etc.)
   - Evidence: `--auth-type` flag supports `openai`, `anthropic`, `qwen-oauth`, `gemini`, `vertex-ai`
   - Need to test model selection with different providers

2. **What is the default context window?**
   - Not exposed in events (unlike Copilot's `session.truncation`)
   - May need to query settings or use provider defaults

3. **Does Qwen support MCP servers?**
   - `qwen mcp` command exists
   - Need to test MCP configuration format

4. **What tools are available?**
   - Observed: `task`, `skill`, `list_directory`, `read_file`, `grep_search`, `glob`, `save_memory`, `todo_write`, `ask_user_question`, `exit_plan_mode`, `web_fetch`, `web_search`, `write_file`
   - Need comprehensive tool list for permission mapping

---

## 10. Implementation Checklist

### 10.1 Required Components

- [ ] **QwenCliProvider.ts**
  - [ ] `buildCliArgs()` - Model, session, workspace, permissions
  - [ ] `buildHeadlessArgs()` - `--output-format stream-json`
  - [ ] `buildInteractiveTuiCommand()` - Interactive mode command
  - [ ] `checkAvailability()` - `qwen --version`
  - [ ] `getVersion()` - Version string
  - [ ] `extractSessionIdFromLogs()` - Fallback session extraction

- [ ] **QwenResponseParser.ts**
  - [ ] Parse `stream-json` events
  - [ ] Extract text from `message.parts[]`
  - [ ] Extract thinking blocks (`thought: true`)
  - [ ] Extract tool calls (`functionCall` objects)
  - [ ] Extract tool results (`tool_result` events)
  - [ ] Accumulate usage statistics

- [ ] **QwenLogParser.ts**
  - [ ] `discoverSessionLog()` - Find log by session ID or prompt matching
  - [ ] `extractResponse()` - Parse JSONL log events
  - [ ] `extractSessionId()` - Extract from log events
  - [ ] `isComplete()` - Detect completion (always false - use process exit)
  - [ ] `sanitizeCwd()` - Convert cwd to log path format

- [ ] **QwenToolPermissionMapper.ts**
  - [ ] `hasFullPermissions()` - Check for YOLO/auto-edit mode
  - [ ] `buildArgs()` - Map approval mode to CLI flags
  - [ ] Convert FlightPath permission config to `--approval-mode`

- [ ] **(Future) QwenNotificationMonitor.ts**
  - [ ] Wait for stable hook documentation
  - [ ] Implement `buildHookConfig()`
  - [ ] Implement `getNotificationDirectory()`
  - [ ] Implement `monitorForCompletion()`

### 10.2 Integration Points

- [ ] Register harness in `FlightPathManager.ts`
- [ ] Add harness ID to `DashboardConstants.ts`
- [ ] Add model constants to `ModelConstants.ts`
- [ ] Update `package.json` harness enum
- [ ] Update prompt schema `harness` field
- [ ] Add CLI availability check to UI
- [ ] Test headless mode end-to-end
- [ ] Test interactive mode with log monitoring
- [ ] Test session resumption (`--resume` flag)
- [ ] Test tool permission handling

### 10.3 Testing Scenarios

- [ ] Simple prompt (no tools)
- [ ] File creation (requires permission)
- [ ] Multi-turn conversation (session resumption)
- [ ] Tool denial and fallback
- [ ] Large prompt (temp file reference)
- [ ] Concurrent sessions (log file discovery)
- [ ] Session timeout (inactivity detection)

---

## 11. Conclusion

### 11.1 Feasibility Assessment

**Qwen Code CLI is VIABLE for FlightPath integration with the following caveats:**

✅ **Strengths:**

- Well-structured output formats (text, json, stream-json)
- Session ID in all stdout events (easy extraction)
- JSONL log files with clear event structure
- Comprehensive usage statistics
- Active development (hooks in progress)

⚠️ **Limitations:**

- No stable hook system (completion detection workaround needed)
- Less mature than Claude/Copilot (fewer integrations)
- Mode-based permissions (less granular control)
- Limited documentation (some features undocumented)

### 11.2 Recommended Approach

**Start with headless mode only:**

1. Implement `QwenCliProvider` with `--output-format stream-json`
2. Use process exit for completion detection
3. Parse stdout for real-time streaming
4. Extract session ID from `system` events

**Add interactive mode later:**

1. Implement log file monitoring as fallback
2. Use inactivity timeout for completion detection
3. Discover sessions via prompt matching

**Monitor hook development:**

1. Track Qwen Code releases for stable hook documentation
2. Implement notification monitor when hooks stabilize
3. Migrate from log monitoring to hook-based detection

### 11.3 Estimated Effort

| Component                | Effort          | Complexity |
| ------------------------ | --------------- | ---------- |
| QwenCliProvider          | 4-6 hours       | Medium     |
| QwenResponseParser       | 6-8 hours       | Medium     |
| QwenLogParser            | 4-6 hours       | Medium     |
| QwenToolPermissionMapper | 2-3 hours       | Low        |
| Integration & Testing    | 8-12 hours      | Medium     |
| **Total (MVP)**          | **24-35 hours** | **Medium** |

**Phase 2 (Interactive Mode + Hooks):** 16-24 hours (when hooks stabilize)

---

## Appendix A: Qwen CLI Command Reference

```bash
# Basic usage
qwen [query..]                    # Interactive mode
qwen -p "prompt"                  # Headless mode (deprecated)
qwen "prompt"                     # Headless mode (positional)

# Output formats
qwen -p "prompt" -o text          # Plain text (default)
qwen -p "prompt" -o json          # Buffered JSON array
qwen -p "prompt" -o stream-json   # Line-delimited JSON (recommended)

# Session management
qwen --continue -p "prompt"       # Resume most recent session
qwen --resume <id> -p "prompt"    # Resume specific session
qwen --session-id <id>            # Set session ID for this run

# Model selection
qwen -m <model> -p "prompt"       # Specify model

# Permission modes
qwen -y -p "prompt"               # YOLO mode (auto-approve all)
qwen --approval-mode <mode>       # plan, default, auto-edit, yolo

# Advanced features
qwen --experimental-hooks         # Enable experimental hooks
qwen --acp                        # Agent communication protocol
qwen --experimental-lsp           # Language server protocol
qwen --sandbox                    # Run in sandbox
qwen --include-directories <dirs> # Additional workspace dirs

# Hooks management
qwen hooks enable <hook-name>     # Enable a hook
qwen hooks disable <hook-name>    # Disable a hook

# MCP servers
qwen mcp                          # Manage MCP servers

# Extensions
qwen extensions <command>         # Manage extensions
qwen -l                           # List available extensions
```

---

## Appendix B: Sample Qwen Session Log

**Location:** `C:\Users\natha\.qwen\projects\c--dev-flightpath\chats\0775cdf1-cb74-4400-8382-b465b3c0a8ac.jsonl`

**Content:**

```jsonl
{"uuid":"a80e34ab-5c8b-4a6e-8d19-389410db988c","parentUuid":null,"sessionId":"0775cdf1-cb74-4400-8382-b465b3c0a8ac","timestamp":"2026-03-13T17:54:08.468Z","type":"user","cwd":"C:\\dev\\FlightPath","version":"0.12.3","gitBranch":"main","message":{"role":"user","parts":[{"text":"just say hi"}]}}
{"uuid":"65d6b6a9-1c45-4169-8687-3dd701542057","parentUuid":"a80e34ab-5c8b-4a6e-8d19-389410db988c","sessionId":"0775cdf1-cb74-4400-8382-b465b3c0a8ac","timestamp":"2026-03-13T17:54:11.652Z","type":"system","cwd":"C:\\dev\\FlightPath","version":"0.12.3","gitBranch":"main","subtype":"ui_telemetry","systemPayload":{"uiEvent":{"event.name":"qwen-code.api_response","event.timestamp":"2026-03-13T17:54:11.652Z","response_id":"chatcmpl-225dff17-46e5-4518-b6c4-b18fb7114a0f","model":"coder-model","status_code":200,"duration_ms":3143,"input_token_count":16793,"output_token_count":32,"cached_content_token_count":16787,"thoughts_token_count":25,"tool_token_count":0,"total_token_count":16825,"prompt_id":"fb3fa8d964fb7","auth_type":"qwen-oauth"}}}
{"uuid":"968b9ec0-4948-40f6-a27d-a6f9b76586ed","parentUuid":"65d6b6a9-1c45-4169-8687-3dd701542057","sessionId":"0775cdf1-cb74-4400-8382-b465b3c0a8ac","timestamp":"2026-03-13T17:54:11.696Z","type":"assistant","cwd":"C:\\dev\\FlightPath","version":"0.12.3","gitBranch":"main","model":"coder-model","message":{"role":"model","parts":[{"text":"The user is asking me to simply say hi, which is a straightforward greeting that doesn't require any tools or complex reasoning.","thought":true},{"text":"Hi!"}]},"usageMetadata":{"promptTokenCount":16793,"candidatesTokenCount":32,"thoughtsTokenCount":25,"totalTokenCount":16825,"cachedContentTokenCount":16787}}
```

---

## Appendix C: References

- **Qwen Code GitHub:** https://github.com/QwenLM/qwen-code
- **Qwen Code Documentation:** https://qwenlm.github.io/qwen-code-docs/
- **Headless Mode Docs:** https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- **Hooks Feature Request:** https://github.com/QwenLM/qwen-code/issues/268
- **Output Format Issue:** https://github.com/QwenLM/qwen-code/issues/873

---

**Document Version:** 1.0  
**Last Updated:** March 13, 2026  
**Next Review:** After Qwen Code v0.13.0 (expected hook stabilization)
