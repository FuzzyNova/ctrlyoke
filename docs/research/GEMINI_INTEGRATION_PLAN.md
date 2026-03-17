# Gemini CLI Integration Plan

**Date:** March 17, 2026  
**Status:** Ready for Implementation  
**Gemini CLI Version:** 1.0.0 (based on research)
**Target FlightPath Version:** 1.2.0  

---

## Executive Summary

This plan outlines the implementation of **Gemini CLI** as a first-class harness in FlightPath. Gemini CLI is an autonomous software engineering assistant that provides structured output formats (`text`, `json`, `stream-json`) and session management via JSON log files. It is architecturally similar to Qwen Code and Claude Code, supporting real-time streaming and tool execution.

**Key Architectural Decisions:**

1. **Completion Detection:** Process exit (headless) + log file monitoring (interactive)
2. **Output Format:** `--output-format stream-json` for real-time streaming
3. **Session Management:** UUID extraction from `init` events, log file fallback
4. **Permission Model:** Mode-based (`plan`, `default`, `auto_edit`, `yolo`) — mapped from FlightPath's settings
5. **Log Format:** Single JSON object per session containing a `messages` array (different from Qwen/Claude NDJSON logs)

**Estimated Effort:** 20-30 hours (Phase 1 MVP)  
**Risk Level:** Low (well-structured output and logs)

---

## Table of Contents

1. [Implementation Phases](#1-implementation-phases)
2. [Phase 1: Core Harness Implementation](#phase-1-core-harness-implementation)
3. [Phase 2: Interactive Mode Support](#phase-2-interactive-mode-support)
4. [Phase 3: Advanced Features](#phase-3-advanced-features)
5. [Testing Strategy](#testing-strategy)
6. [Appendix A: Event and Log Formats](#appendix-a-event-and-log-formats)

---

## 1. Implementation Phases

### Phase 1: Core Harness Implementation (MVP) — 20-30 hours

**Goal:** Headless mode with `stream-json` output, process-exit completion detection.

**Deliverables:**
- ✅ 5 provider files in `src/flightpath/harness/gemini/`
- ✅ Stream-JSON parser for real-time output
- ✅ Session ID extraction from stdout
- ✅ Process-exit completion detection
- ✅ Tool permission mapping (mode-based)
- ✅ Basic log parser for session discovery

---

### Phase 2: Interactive Mode Support — 10-15 hours

**Goal:** TUI support with log file monitoring for completion detection.

**Deliverables:**
- ✅ Log file monitor with inactivity timeout
- ✅ Session discovery via log file matching
- ✅ TUI stream processor for terminal UI

---

## 2. Phase 1: Core Harness Implementation

### 2.1 Directory Structure

```
src/flightpath/harness/gemini/
├── GeminiCliProvider.ts           # Main provider descriptor
├── GeminiResponseParser.ts        # Stream-JSON parser, session ID extraction
├── GeminiNotificationMonitor.ts   # Process exit detection (headless)
├── GeminiToolPermissionMapper.ts  # Mode-based permission mapping
└── GeminiLogParser.ts             # Log file parser for session discovery
```

### 2.2 Implementation Details

#### Step 1: GeminiCliProvider.ts

**Key Fields:**
- `harnessId`: `gemini-cli`
- `cliCommand`: `gemini`
- `shouldStreamHeadlessOutput`: `true`
- `usesInteractiveNotificationMonitor`: `false` (Phase 1 uses process exit)

#### Step 2: GeminiResponseParser.ts

**Stream-JSON Event Mapping:**
- `init` -> Extract `session_id`, `model`
- `message` (role: assistant) -> Extract text content (handle `delta: true`)
- `tool_use` -> Map to `TOOL_CALL` event
- `tool_result` -> Map to `TOOL_RESULT` event
- `result` -> Extract final stats (`total_tokens`, `input_tokens`, `output_tokens`)

#### Step 3: GeminiToolPermissionMapper.ts

**Mapping Table:**

| FlightPath Setting | Gemini Mapping |
|-------------------|----------------|
| `dangerouslyAllowAll` | `-y` or `--approval-mode yolo` |
| `allowAll` | `--approval-mode auto_edit` |
| `custom` | `--approval-mode default` (Gemini's policy engine preferred) |

#### Step 4: GeminiLogParser.ts

**Log Location:** `~/.gemini/tmp/<project-name>/chats/session-<timestamp>-<short-uuid>.json`

**Logic:**
- Read the entire JSON object (it's a valid single JSON, not NDJSON)
- Parse the `messages` array
- Map `gemini` type messages to assistant responses
- Map `toolCalls` array inside `gemini` messages to tool events

---

## 3. Phase 2: Interactive Mode Support

### 3.1 Log File Monitoring

Gemini writes to a single JSON file that grows as messages are added. The `GeminiNotificationMonitor` will need to poll the log file and check the `lastUpdated` timestamp or the length of the `messages` array.

### 3.2 TUI Filtering

Gemini's TUI uses standard box-drawing characters and spinners. `GeminiTuiStreamProcessor` will implement patterns to filter these from the output.

---

## 4. Phase 3: Advanced Features

### 4.1 MCP Integration

Gemini supports MCP servers. FlightPath can generate a temp MCP config and pass it to Gemini if Gemini supports a `--mcp-config` equivalent (needs further research, or use `gemini mcp add` via shell).

---

## 5. Testing Strategy

### 5.1 Manual Test Workflows

```yaml
# manual-test/gemini-simple.flightpath.yaml
harness: gemini-cli
model: auto-gemini-3
prompts:
  - prompt: "Say hi"
    endCondition:
      script: echo "success"
      returns: "0"
```

---

## Appendix A: Event and Log Formats

### Sample Stream-JSON
```json
{"type":"init","session_id":"656a5df3-e1dd-406e-83a7-7974d1f29238","model":"auto-gemini-3"}
{"type":"message","role":"assistant","content":"Hello!","delta":true}
{"type":"tool_use","tool_name":"list_directory","tool_id":"id_0","parameters":{"dir_path":"."}}
{"type":"result","status":"success","stats":{"total_tokens":11155,...}}
```

### Sample Log File Structure
```json
{
  "sessionId": "UUID",
  "messages": [
    { "type": "user", "content": [{"text": "hi"}] },
    { 
      "type": "gemini", 
      "content": "Hello!", 
      "toolCalls": [
        { "name": "list_directory", "status": "success", "resultDisplay": "..." }
      ]
    }
  ]
}
```
