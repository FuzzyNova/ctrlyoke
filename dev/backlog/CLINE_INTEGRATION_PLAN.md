# Cline CLI Integration Plan

**Date:** March 19, 2026  
**Status:** Ready for Implementation  
**Cline CLI Version:** 3.74.0  
**Target FlightPath Version:** 1.2.0

---

## Executive Summary

This plan outlines the implementation of **Cline CLI** as a first-class harness in FlightPath. Cline is an AI coding assistant CLI that provides structured JSON output, session management via task IDs, and MCP server support. It is architecturally similar to Claude Code and Codex, supporting real-time streaming and tool execution.

**Key Architectural Decisions:**

1. **Completion Detection:** Process exit (headless) + log file monitoring (interactive)
2. **Output Format:** `--json` for structured JSONL output
3. **Session Management:** Task ID extraction from `task_started` events, task storage fallback
4. **Permission Model:** Mode-based (`--yolo`, `--auto-approve-all`) — mapped from FlightPath's settings
5. **MCP Integration:** Native `cline mcp add` command for MCP server configuration

**Estimated Effort:** 20-30 hours (Phase 1 MVP)  
**Risk Level:** Low (well-structured output and task storage)

---

## Table of Contents

1. [Cline CLI Capabilities](#1-cline-cli-capabilities)
2. [JSON Output Format](#2-json-output-format)
3. [Session & Task Management](#3-session--task-management)
4. [Implementation Phases](#4-implementation-phases)
5. [Phase 1: Core Harness Implementation](#5-phase-1-core-harness-implementation)
6. [Phase 2: Interactive Mode Support](#6-phase-2-interactive-mode-support)
7. [Testing Strategy](#7-testing-strategy)
8. [Appendix A: Event Format Reference](#appendix-a-event-format-reference)
9. [Appendix B: Comparison to Existing Harnesses](#appendix-b-comparison-to-existing-harnesses)

---

## 1. Cline CLI Capabilities

### 1.1 Command Structure

```bash
# Basic usage
cline "prompt"                    # Start task immediately
cline task "prompt"               # Same as above (subcommand)
cline task "prompt" --json        # Structured JSON output

# Session management
cline --taskId <id>               # Resume existing task
cline --continue                  # Resume most recent task from cwd

# Model selection
cline -m <model>                  # Specify model (provider/model format)

# Execution modes
cline -a                          # Act mode (default)
cline -p                          # Plan mode
cline -y                          # YOLO mode (auto-approve all)
cline --auto-approve-all          # Auto-approve with interactive mode

# Working directory
cline -c <path>                   # Set working directory

# Timeout
cline -t <seconds>                # Execution timeout

# MCP integration
cline mcp add <name> <command>    # Add MCP server

# Other
cline --json                      # JSON output mode
cline --thinking [tokens]         # Extended thinking
cline --reasoning-effort <level>  # none|low|medium|high|xhigh
cline --hooks-dir <path>          # Custom hooks directory
cline --acp                       # Agent Client Protocol mode
```

### 1.2 Key Features

| Feature            | Supported | Notes                            |
| ------------------ | --------- | -------------------------------- |
| JSON output        | ✅        | `--json` flag produces JSONL     |
| Session resumption | ✅        | `--taskId <id>` or `--continue`  |
| Model selection    | ✅        | `-m provider/model` format       |
| MCP integration    | ✅        | `cline mcp add` command          |
| Auto-approve       | ✅        | `--yolo` or `--auto-approve-all` |
| Timeout            | ✅        | `-t <seconds>`                   |
| Working directory  | ✅        | `-c <path>`                      |
| Extended thinking  | ✅        | `--thinking [tokens]`            |
| Hooks              | ✅        | `--hooks-dir <path>`             |
| ACP mode           | ✅        | `--acp` for editor integration   |

---

## 2. JSON Output Format

### 2.1 Event Types

Cline's `--json` mode produces JSONL (one JSON object per line):

```json
{"type":"task_started","taskId":"1773930847934"}
{"ts":1773930847940,"type":"say","say":"task","text":"Say hello","modelInfo":{"providerId":"cline","modelId":"xiaomi/mimo-v2-pro","mode":"act"},"conversationHistoryIndex":-1}
{"ts":1773930851676,"type":"say","say":"api_req_started","text":"{\"request\":\"...\",\"model\":\"...\"}","modelInfo":{...},"conversationHistoryIndex":-1}
{"ts":1773930854006,"type":"say","say":"reasoning","text":"The user wants me to say hello...","partial":false,"modelInfo":{...},"conversationHistoryIndex":0}
{"ts":1773930855667,"type":"say","say":"completion_result","text":"Hello! I'm Cline, ready to help...","modelInfo":{...},"conversationHistoryIndex":0}
```

### 2.2 Event Structure

| Event Type     | `say` Field         | Purpose               | Key Fields                                |
| -------------- | ------------------- | --------------------- | ----------------------------------------- |
| `task_started` | —                   | Task initialization   | `taskId`                                  |
| `say`          | `task`              | User prompt echo      | `text`, `modelInfo`                       |
| `say`          | `api_req_started`   | API request initiated | `text` (JSON string with request details) |
| `say`          | `reasoning`         | AI thinking/reasoning | `text`, `partial`                         |
| `say`          | `completion_result` | Final AI response     | `text`                                    |
| `say`          | `tool_use`          | Tool execution        | `text`, `tool`                            |
| `say`          | `tool_result`       | Tool result           | `text`, `tool`                            |

### 2.3 Token Usage

Token usage is available in the final streaming chunk's `usage` field:

```json
{
  "usage": {
    "prompt_tokens": 30193,
    "completion_tokens": 299,
    "total_tokens": 30492,
    "cost": 0.0015417,
    "is_byok": true,
    "prompt_tokens_details": {
      "cached_tokens": 320,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "cost_details": {
      "upstream_inference_cost": 0.030834,
      "upstream_inference_prompt_cost": 0.029937,
      "upstream_inference_completions_cost": 0.000897
    },
    "completion_tokens_details": {
      "reasoning_tokens": 193,
      "image_tokens": 0,
      "audio_tokens": 0
    }
  }
}
```

---

## 3. Session & Task Management

### 3.1 Task Storage

**Location:** `~/.cline/data/tasks/<taskId>/`

**Structure:**

```
~/.cline/data/tasks/1773930847934/
├── api_conversation_history.json
├── task_metadata.json
├── ui_messages.json
└── focus_chain_taskid_1773930847934.md
```

**Task Metadata:**

```json
{
  "files_in_context": [],
  "model_usage": [
    {
      "ts": 1773930848285,
      "model_id": "xiaomi/mimo-v2-pro",
      "model_provider_id": "cline",
      "mode": "act"
    }
  ],
  "environment_history": [
    {
      "ts": 1773930848281,
      "os_name": "win32",
      "os_version": "10.0.26200",
      "os_arch": "x64",
      "host_name": "Cline CLI - Node.js",
      "host_version": "2.8.1",
      "cline_version": "3.74.0"
    }
  ]
}
```

### 3.2 Task ID Format

**Format:** Numeric timestamp (milliseconds since epoch)  
**Example:** `1773930847934`

**Availability:**

- ✅ Included in `task_started` event (JSON output)
- ✅ Available in task storage directory name
- ✅ Can be passed via `--taskId` flag for resumption

### 3.3 Session Resumption

```bash
# Resume specific task
cline --taskId 1773930847934 "Continue working on this"

# Resume most recent task from current directory
cline --continue "Pick up where we left off"
```

### 3.4 Task Discovery

**Method 1: Task ID from stdout (Headless)**

```json
{ "type": "task_started", "taskId": "1773930847934" }
```

**Method 2: Task storage matching (Interactive)**

1. List files in `~/.cline/data/tasks/`
2. Sort by modification time (most recent first)
3. Read `task_metadata.json` from each candidate
4. Match `model_usage` timestamps against execution start time
5. Extract task ID from matching directory name

**Method 3: Workspace state matching**

```json
// ~/.cline/data/workspaces/<hash>/workspaceState.json
{
  "lastTaskId": "1773930847934",
  "cwd": "C:\\dev\\FlightPath"
}
```

---

## 4. Implementation Phases

### Phase 1: Core Harness Implementation (MVP) — 20-30 hours

**Goal:** Headless mode with `--json` output, process-exit completion detection.

**Deliverables:**

- ✅ 5 provider files in `src/flightpath/harness/cline/`
- ✅ JSONL parser for real-time output
- ✅ Task ID extraction from stdout
- ✅ Process-exit completion detection
- ✅ Tool permission mapping (mode-based)
- ✅ Basic task storage parser for session discovery

---

### Phase 2: Interactive Mode Support — 10-15 hours

**Goal:** TUI support with task storage monitoring for completion detection.

**Deliverables:**

- ✅ Task storage monitor with inactivity timeout
- ✅ Session discovery via task metadata matching
- ✅ TUI stream processor for terminal UI

---

## 5. Phase 1: Core Harness Implementation

### 5.1 Directory Structure

```
src/flightpath/harness/cline/
├── ClineCliProvider.ts           # Main provider descriptor
├── ClineResponseParser.ts        # JSONL parser, task ID extraction
├── ClineNotificationMonitor.ts   # Process exit detection (headless)
├── ClineToolPermissionMapper.ts  # Mode-based permission mapping
└── ClineLogParser.ts             # Task storage parser for session discovery
```

### 5.2 Implementation Checklist

#### Step 1: ClineCliProvider.ts (2-3 hours)

**Purpose:** Aggregate all Cline-specific components into a single provider descriptor

**Key Fields:**

```typescript
export class ClineCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "cline",
    displayName: "Cline CLI",
    terminalName: "Cline",
    installHint: "Install via: npm install -g cline",
    shouldStreamHeadlessOutput: true,
    usesInteractiveNotificationMonitor: false, // Phase 1: process exit
  };

  readonly responseParser = new ClineResponseParser();
  readonly notificationMonitor = new ClineNotificationMonitor();
  readonly toolPermissionMapper = new ClineToolPermissionMapper();
  readonly logParser = new ClineLogParser();
}
```

**Implementation:**

- [ ] Create class implementing `ICliProvider`
- [ ] Define `config` with `name: "cline"`, `displayName: "Cline CLI"`
- [ ] Set `shouldStreamHeadlessOutput: true`
- [ ] Wire up parser, monitor, mapper, logParser
- [ ] Implement `buildCliArgs()` with model, session, workspace, permissions
- [ ] Implement `buildHeadlessArgs()` with `--json` flag
- [ ] Implement `buildInteractiveTuiCommand()` for TUI mode
- [ ] Implement `checkAvailability()` via `cline --version`
- [ ] Implement `getVersion()` via `cline --version`

**Reference:** `src/flightpath/harness/claude/ClaudeCliProvider.ts`

---

#### Step 2: ClineResponseParser.ts (4-5 hours)

**Purpose:** Parse JSONL output, extract task IDs, tokens, tool calls

**Key Methods:**

```typescript
export class ClineResponseParser extends ResponseParserBase {
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let taskId: string | undefined;
    let modelInfo: ModelInfo | undefined;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);

      if (event.type === "task_started") {
        taskId = event.taskId;
      } else if (event.type === "say") {
        switch (event.say) {
          case "task":
            // User prompt echo
            break;
          case "reasoning":
            events.push({
              type: CLI_EVENT_TYPES.THINKING,
              data: { text: event.text },
            });
            break;
          case "completion_result":
            events.push({
              type: CLI_EVENT_TYPES.TEXT,
              data: { text: event.text },
            });
            break;
          case "tool_use":
            events.push({
              type: CLI_EVENT_TYPES.TOOL_CALL,
              data: {
                toolCallId: event.tool?.id,
                name: event.tool?.name,
                parameters: event.tool?.input,
              },
            });
            break;
          case "tool_result":
            events.push({
              type: CLI_EVENT_TYPES.TOOL_RESULT,
              data: {
                toolCallId: event.tool?.id,
                result: event.text,
              },
            });
            break;
        }
      }
    }

    return {
      events,
      metadata: {
        sessionId: taskId,
        model: modelInfo?.modelId,
        usage: this.extractUsageFromFinalChunk(stdout),
      },
    };
  }

  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    // Extract from final chunk's usage field
    const lines = output.split("\n").reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.usage?.prompt_tokens) {
          return {
            prompt: event.usage.prompt_tokens,
            completion: event.usage.completion_tokens,
          };
        }
      } catch {}
    }
    return undefined;
  }
}
```

**Implementation:**

- [ ] Implement NDJSON parser (split by newline, parse each line)
- [ ] Extract `taskId` from `task_started` event
- [ ] Extract `reasoning` events as thinking blocks
- [ ] Extract `completion_result` events as text content
- [ ] Extract `tool_use` events as tool calls
- [ ] Extract `tool_result` events as tool results
- [ ] Extract usage statistics from final chunk
- [ ] Handle `api_req_started` events for model info
- [ ] Map Cline event format to FlightPath `CliEvent` interface

**Reference:** `src/flightpath/harness/claude/ClaudeResponseParser.ts`

---

#### Step 3: ClineNotificationMonitor.ts (2-3 hours)

**Purpose:** Detect completion via process exit (headless mode)

**Implementation:**

```typescript
export class ClineNotificationMonitor implements INotificationMonitor {
  readonly supportsSessionIdInFilename = false;
  readonly supportsSessionStart = false;

  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    // Headless mode: process exit = completion
    // No hook-based detection in Phase 1
    return { completed: true };
  }

  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // No hook support in Phase 1
    return { type: "none" };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(
      workspaceRoot,
      ".flightpath",
      "temp",
      "cline-notifications"
    );
  }
}
```

**Implementation:**

- [ ] Implement `monitorForCompletion()` for headless mode (process exit)
- [ ] Implement `buildHookConfig()` returning `{ type: "none" }`
- [ ] Implement `getNotificationDirectory()`
- [ ] Handle cancellation via `onCancel` callback

**Reference:** `src/flightpath/harness/codex/CodexNotificationMonitor.ts`

---

#### Step 4: ClineToolPermissionMapper.ts (1-2 hours)

**Purpose:** Convert FlightPath's permission settings to Cline CLI arguments

**Mapping Table:**

| FlightPath Setting    | Cline Mapping                  |
| --------------------- | ------------------------------ |
| `dangerouslyAllowAll` | `--yolo`                       |
| `allowAll`            | `--auto-approve-all`           |
| `custom`              | No flag (interactive approval) |

**Implementation:**

```typescript
export class ClineToolPermissionMapper extends ToolPermissionMapperBase {
  buildArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];

    switch (config.mode) {
      case "dangerouslyAllowAll":
        args.push("--yolo");
        break;
      case "allowAll":
        args.push("--auto-approve-all");
        break;
      case "custom":
        // Cline doesn't support granular tool permissions
        // Fall back to interactive approval
        break;
    }

    return args;
  }

  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return config.mode === "dangerouslyAllowAll" || config.mode === "allowAll";
  }
}
```

**Implementation:**

- [ ] Implement `buildArgs()` mapping permission modes to CLI flags
- [ ] Implement `hasFullPermissions()` for headless mode safety check
- [ ] Handle `custom` mode (no CLI flag, interactive approval)

**Reference:** `src/flightpath/harness/claude/ClaudeToolPermissionMapper.ts`

---

#### Step 5: ClineLogParser.ts (3-4 hours)

**Purpose:** Parse task storage for session discovery (fallback when task ID not in stdout)

**Task Storage Location:**

```
~/.cline/data/tasks/<taskId>/
├── task_metadata.json
├── api_conversation_history.json
└── ui_messages.json
```

**Implementation:**

```typescript
export class ClineLogParser implements ILogParser {
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    const tasksDir = path.join(os.homedir(), ".cline", "data", "tasks");

    if (sessionId) {
      // Fast path: task ID provided
      const taskDir = path.join(tasksDir, sessionId);
      if (fs.existsSync(taskDir)) {
        return path.join(taskDir, "ui_messages.json");
      }
      return null;
    }

    // Fallback: find recently modified task directories
    const dirs = fs
      .readdirSync(tasksDir)
      .map((d) => ({
        name: d,
        path: path.join(tasksDir, d),
        mtime: fs.statSync(path.join(tasksDir, d)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    // Match by task metadata
    for (const dir of dirs) {
      const metadataPath = path.join(dir.path, "task_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        // Check if task was created around startTime
        const taskTime = metadata.model_usage?.[0]?.ts;
        if (taskTime && Math.abs(taskTime - startTime.getTime()) < 30000) {
          return path.join(dir.path, "ui_messages.json");
        }
      }
    }

    return null;
  }

  extractSessionId(events: BaseCliEvent[]): string | null {
    for (const event of events) {
      if (event.type === "task_started" && event.taskId) {
        return event.taskId;
      }
    }
    return null;
  }

  extractContentFromEvent(event: BaseCliEvent): string | undefined {
    if (event.type === "say") {
      switch (event.say) {
        case "reasoning":
          return `\n[Thinking]\n${event.text}\n[/Thinking]\n`;
        case "completion_result":
          return event.text;
        case "tool_use":
          return `\n[Tool: ${event.tool?.name}]\n`;
        case "tool_result":
          return `\n[Tool Result]\n${event.text}\n`;
      }
    }
    return undefined;
  }

  isComplete(event: BaseCliEvent): boolean {
    // Cline doesn't emit a specific completion event in JSON mode
    // Completion is detected via process exit
    return false;
  }

  // ... other ILogParser methods
}
```

**Implementation:**

- [ ] Implement `discoverSessionLog()` with task ID matching
- [ ] Implement `extractSessionId()` from `task_started` events
- [ ] Implement `extractContentFromEvent()` for streaming
- [ ] Implement `isComplete()` (always false — use process exit)
- [ ] Implement `readNewLines()` for task storage monitoring
- [ ] Implement `watchLogFile()` for task storage file watching
- [ ] Implement `extractResponse()` to build `UniversalCliOutput` from task events

**Reference:** `src/flightpath/harness/claude/ClaudeLogParser.ts`

---

#### Step 6: Add Harness Enum Value (30 min)

**File:** `src/types/FlightPathTypes.ts`

```typescript
export enum Harness {
  CopilotCli = "copilot-cli",
  CopilotChat = "copilot-chat",
  ClaudeCli = "claude-cli",
  CodexCli = "codex-cli",
  OpenCodeCli = "opencode-cli",
  ClineCli = "cline-cli", // NEW
}
```

**File:** `src/types/DashboardConstants.ts`

```typescript
export const HARNESS_IDS = {
  COPILOT_CLI: "copilot-cli",
  COPILOT_CHAT: "copilot-chat",
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
  OPENCODE_CLI: "opencode-cli",
  CLINE_CLI: "cline-cli", // NEW
} as const;
```

---

#### Step 7: Integration Factory Registration (1 hour)

**File:** `src/flightpath/IntegrationFactory.ts`

```typescript
import { ClineCliProvider } from "./harness/cline/ClineCliProvider";

export class IntegrationFactory {
  // ... existing methods

  /** Create a new Cline CLI integration */
  createClineCli(registerWithContext: boolean = true): CliIntegration {
    const provider = new ClineCliProvider();
    return new CliIntegration(provider, this.platform, registerWithContext);
  }

  /** Create a new integration for the given harness */
  createForHarness(
    harness: Harness,
    registerWithContext: boolean = true
  ): HarnessIntegration {
    switch (harness) {
      case Harness.ClineCli:
        return this.createClineCli(registerWithContext);
      // ... existing cases
    }
  }
}
```

---

#### Step 8: Add VS Code Settings (1 hour)

**File:** `package.json` (contributes.configuration)

```json
{
  "flightpath.clineCliModel": {
    "type": "string",
    "default": "",
    "description": "Default model for Cline CLI (e.g., anthropic/claude-sonnet-4-5). Leave empty to use Cline's configured default.",
    "order": 4
  }
}
```

---

#### Step 9: Add Model Constants (30 min)

**File:** `src/utils/ModelConstants.ts`

```typescript
export const CLINE_CLI_MODELS = [
  { id: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-opus-4", displayName: "Claude Opus 4" },
  { id: "openai/gpt-4o", displayName: "GPT-4o" },
  { id: "openai/o3-mini", displayName: "o3-mini" },
  { id: "google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
] as const;
```

---

### 5.3 Phase 1 Testing Checklist

**Headless Mode:**

- [ ] `cline task "say hello" --json --timeout 10` completes successfully
- [ ] Task ID extracted from `task_started` event
- [ ] Final response text parsed from `completion_result` events
- [ ] Reasoning extracted from `reasoning` events
- [ ] Usage statistics extracted from final chunk
- [ ] Process exit triggers completion callback

**Tool Calls:**

- [ ] `cline task "create a file" --json --yolo` parses tool_use events
- [ ] Tool calls mapped to FlightPath `CliEvent` interface
- [ ] Tool results captured correctly

**Session Resumption:**

- [ ] `cline --taskId <id> "continue..."` resumes previous task
- [ ] Task ID passed via `--taskId` flag

**Settings:**

- [ ] `flightpath.clineCliModel` setting respected
- [ ] YOLO mode (`--yolo`) applied for `dangerouslyAllowAll`
- [ ] Auto-approve mode (`--auto-approve-all`) applied for `allowAll`

---

## 6. Phase 2: Interactive Mode Support

### 6.1 Implementation Checklist

#### Step 1: Task Storage Monitor (3-4 hours)

**Purpose:** Monitor task storage for completion when running in interactive mode

```typescript
export class ClineNotificationMonitor implements INotificationMonitor {
  private pollTimer?: NodeJS.Timeout;

  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    // Interactive: poll task storage for completion
    const tasksDir = path.join(os.homedir(), ".cline", "data", "tasks");
    const timeout = config.timeoutMs;
    const pollMs = config.pollMs || 2000;

    let lastEventTime = Date.now();

    return new Promise((resolve) => {
      this.pollTimer = setInterval(async () => {
        if (onCancel?.()) {
          clearInterval(this.pollTimer);
          resolve({ completed: false, error: "Cancelled" });
          return;
        }

        // Check for task completion via process exit or inactivity
        if (Date.now() - lastEventTime > 30000) {
          // 30 second inactivity timeout
          clearInterval(this.pollTimer);
          resolve({ completed: true });
          return;
        }

        // Check if task directory has been updated
        if (sessionId) {
          const taskDir = path.join(tasksDir, sessionId);
          if (fs.existsSync(taskDir)) {
            const mtime = fs.statSync(taskDir).mtimeMs;
            if (mtime > lastEventTime) {
              lastEventTime = Date.now();
            }
          }
        }
      }, pollMs);

      // Timeout
      setTimeout(() => {
        clearInterval(this.pollTimer);
        resolve({ completed: false, error: "Timeout" });
      }, timeout);
    });
  }
}
```

**Testing:**

- [ ] Task storage discovered by task ID
- [ ] Recent task directories read without re-reading entire storage
- [ ] Inactivity timeout triggers completion
- [ ] Cancellation works correctly

---

#### Step 2: Session Discovery (2-3 hours)

**Purpose:** Find task when task ID unknown

```typescript
export class ClineLogParser {
  async discoverRecentTask(
    cwd: string,
    prompt: string
  ): Promise<string | null> {
    const tasksDir = path.join(os.homedir(), ".cline", "data", "tasks");

    // Find recently modified task directories
    const dirs = fs
      .readdirSync(tasksDir)
      .map((d) => ({
        name: d,
        path: path.join(tasksDir, d),
        mtime: fs.statSync(path.join(tasksDir, d)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    // Match by workspace and prompt
    for (const dir of dirs) {
      const metadataPath = path.join(dir.path, "task_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));

        // Check if task was for this workspace
        const workspaceState = this.getWorkspaceState(cwd);
        if (workspaceState?.lastTaskId === dir.name) {
          return dir.name;
        }
      }
    }

    return null;
  }

  private getWorkspaceState(cwd: string): any {
    const workspacesDir = path.join(
      os.homedir(),
      ".cline",
      "data",
      "workspaces"
    );
    const dirs = fs.readdirSync(workspacesDir);

    for (const dir of dirs) {
      const statePath = path.join(workspacesDir, dir, "workspaceState.json");
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        if (state.cwd === cwd) {
          return state;
        }
      }
    }

    return null;
  }
}
```

**Testing:**

- [ ] Recent task discovered by workspace matching
- [ ] Workspace state lookup works correctly
- [ ] Fallback to most recent task if no match

---

#### Step 3: TUI Stream Processor (2-3 hours)

**Purpose:** Filter TUI artifacts from terminal output

```typescript
export class ClineTuiStreamProcessor extends TuiStreamProcessor {
  readonly chromePatterns = [
    /\x1b\[\?25[hl]/g, // Cursor show/hide
    /\x1b\[[0-9]+;[0-9]+[Hf]/g, // Cursor movement
    /\x1b\[2J/g, // Clear screen
    /╭.*╮/g, // Box drawing
    /│.*│/g,
    /╰.*╯/g,
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/g, // Spinner
  ];

  filterChunk(chunk: string): string {
    let filtered = chunk;
    for (const pattern of this.chromePatterns) {
      filtered = filtered.replace(pattern, "");
    }
    return filtered;
  }
}
```

**Testing:**

- [ ] TUI artifacts filtered from output
- [ ] JSON output preserved intact
- [ ] No data loss in filtering

---

### 6.2 Phase 2 Testing Checklist

**Interactive Mode:**

- [ ] Task storage monitoring starts on session launch
- [ ] Completion detected via inactivity timeout
- [ ] Session discovery finds correct task

**TUI Filtering:**

- [ ] Box drawing characters filtered
- [ ] Cursor movement codes filtered
- [ ] Spinner characters filtered
- [ ] JSON output preserved

---

## 7. Testing Strategy

### 7.1 Unit Tests

**Files:**

- `src/flightpath/harness/cline/ClineResponseParser.test.ts`
- `src/flightpath/harness/cline/ClineLogParser.test.ts`
- `src/flightpath/harness/cline/ClineToolPermissionMapper.test.ts`

**Test Fixtures:**

- Sample JSONL output (simple prompt)
- Sample JSONL output (with tool calls)
- Sample task metadata JSON
- Various permission mode configurations

---

### 7.2 Integration Tests

**Manual Test Workflows:**

```yaml
# test-cline-simple.flightpath.yaml
harness: cline-cli
model: anthropic/claude-sonnet-4-5
prompts:
  - prompt: "Just say hi"
    endCondition:
      script: echo "success"
      returns: "true"
```

```yaml
# test-cline-tool-calls.flightpath.yaml
harness: cline-cli
model: anthropic/claude-sonnet-4-5
toolPermissions:
  mode: dangerouslyAllowAll
prompts:
  - prompt: "Create a file called test.txt with 'hello world'"
    endCondition:
      script: test -f test.txt && cat test.txt | grep "hello world"
      returns: "true"
```

```yaml
# test-cline-session-resume.flightpath.yaml
harness: cline-cli
prompts:
  - prompt: "My favorite color is blue."
  - prompt: "What is my favorite color?"
    resumeSession: true
```

---

### 7.3 Performance Benchmarks

**Metrics:**

- Time to first token (streaming)
- Total execution time (headless vs interactive)
- Task storage polling overhead
- Memory usage during large responses

---

## Appendix A: Event Format Reference

### A.1 Task Started Event

```json
{ "type": "task_started", "taskId": "1773930847934" }
```

### A.2 Say Event (Task)

```json
{
  "ts": 1773930847940,
  "type": "say",
  "say": "task",
  "text": "Say hello",
  "modelInfo": {
    "providerId": "cline",
    "modelId": "xiaomi/mimo-v2-pro",
    "mode": "act"
  },
  "conversationHistoryIndex": -1
}
```

### A.3 Say Event (Reasoning)

```json
{
  "ts": 1773930854006,
  "type": "say",
  "say": "reasoning",
  "text": "The user wants me to say hello. This is a simple task...",
  "partial": false,
  "modelInfo": {...},
  "conversationHistoryIndex": 0
}
```

### A.4 Say Event (Completion Result)

```json
{
  "ts": 1773930855667,
  "type": "say",
  "say": "completion_result",
  "text": "Hello! I'm Cline, ready to help you with your FlightPath project.",
  "modelInfo": {...},
  "conversationHistoryIndex": 0
}
```

### A.5 API Request Started Event

```json
{
  "ts": 1773930851676,
  "type": "say",
  "say": "api_req_started",
  "text": "{\"request\":\"<task>\\nSay hello\\n</task>\\n\\n...\",\"model\":\"xiaomi/mimo-v2-pro\"}",
  "modelInfo": {...},
  "conversationHistoryIndex": -1
}
```

---

## Appendix B: Comparison to Existing Harnesses

| Feature               | Cline CLI              | Claude Code                      | Codex CLI             | Copilot CLI           |
| --------------------- | ---------------------- | -------------------------------- | --------------------- | --------------------- |
| JSON output           | ✅ `--json`            | ✅ `--output-format stream-json` | ✅ `--format json`    | ❌                    |
| Session ID in stdout  | ✅ `task_started`      | ✅ `system.init`                 | ✅ `session_id`       | ❌                    |
| Session resumption    | ✅ `--taskId`          | ✅ `--resume`                    | ✅ `--resume`         | ✅ `--resume`         |
| Tool permission model | Mode-based (`--yolo`)  | Pattern-based                    | Pattern-based         | Pattern-based         |
| Task storage          | `~/.cline/data/tasks/` | `~/.claude/projects/`            | `~/.codex/sessions/`  | `~/.copilot/`         |
| MCP support           | ✅ `cline mcp add`     | ✅ `--mcp-config`                | ✅ `--mcp-config`     | ✅ `--mcp-config`     |
| Completion detection  | Process exit           | Stop hook                        | Notify hook           | SessionEnd hook       |
| Thinking/reasoning    | ✅ `reasoning` events  | ✅ `thinking` blocks             | ✅ `thinking` blocks  | ✅ `reasoning` events |
| Cost tracking         | ✅ `usage.cost`        | ✅ `usage`                       | ✅ `usage`            | ❌                    |
| Extended thinking     | ✅ `--thinking`        | ✅ `thinking` budget             | ✅ `reasoning.effort` | ❌                    |

### B.1 Key Differences

**Cline Advantages:**

- ✅ Task ID in `task_started` event (easy extraction)
- ✅ Rich cost tracking with detailed breakdowns
- ✅ Native MCP integration (`cline mcp add`)
- ✅ Extended thinking support (`--thinking`, `--reasoning-effort`)
- ✅ ACP mode for editor integration
- ✅ Simple permission model (mode-based)

**Cline Disadvantages:**

- ❌ No hook-based completion detection (process exit only in Phase 1)
- ❌ No granular tool permissions (mode-based only)
- ❌ Task ID is numeric timestamp (not UUID)
- ❌ Less mature than Claude/Copilot (fewer integrations)

### B.2 Integration Complexity

| Component              | Cline CLI             | Claude Code             | Copilot CLI               |
| ---------------------- | --------------------- | ----------------------- | ------------------------- |
| CLI Provider           | Medium                | Medium                  | Medium                    |
| Response Parser        | Medium (JSONL events) | Medium (stream-json)    | Medium (JSONL events)     |
| Notification Monitor   | Simple (process exit) | Complex (Stop hook)     | Complex (SessionEnd hook) |
| Log Parser             | Medium (task storage) | Medium (session logs)   | Complex (session logs)    |
| Tool Permission Mapper | Simple (mode-based)   | Complex (pattern-based) | Complex (pattern-based)   |

---

## Appendix C: Code Samples

### C.1 Sample Response Parser

```typescript
// ClineResponseParser.ts
export class ClineResponseParser extends ResponseParserBase {
  parse(stdout: string, stderr: string, exitCode: number): UniversalCliOutput {
    const events: CliEvent[] = [];
    let taskId: string | undefined;
    let modelId: string | undefined;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        if (event.type === "task_started") {
          taskId = event.taskId;
        } else if (event.type === "say") {
          switch (event.say) {
            case "task":
              modelId = event.modelInfo?.modelId;
              break;
            case "reasoning":
              events.push({
                type: CLI_EVENT_TYPES.THINKING,
                data: { text: event.text },
              });
              break;
            case "completion_result":
              events.push({
                type: CLI_EVENT_TYPES.TEXT,
                data: { text: event.text },
              });
              break;
            case "tool_use":
              events.push({
                type: CLI_EVENT_TYPES.TOOL_CALL,
                data: {
                  toolCallId: event.tool?.id,
                  name: event.tool?.name,
                  parameters: event.tool?.input,
                },
              });
              break;
            case "tool_result":
              events.push({
                type: CLI_EVENT_TYPES.TOOL_RESULT,
                data: {
                  toolCallId: event.tool?.id,
                  result: event.text,
                },
              });
              break;
          }
        }
      } catch (e) {
        // Skip malformed JSON lines
      }
    }

    return {
      events,
      metadata: {
        sessionId: taskId,
        model: modelId,
        usage: this.extractUsageFromFinalChunk(stdout),
      },
    };
  }

  private extractUsageFromFinalChunk(stdout: string): any {
    const lines = stdout.split("\n").reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.usage) {
          return {
            inputTokens: event.usage.prompt_tokens || 0,
            outputTokens: event.usage.completion_tokens || 0,
            totalTokens: event.usage.total_tokens || 0,
          };
        }
      } catch {}
    }
    return undefined;
  }
}
```

---

### C.2 Sample Task Storage Parser

```typescript
// ClineLogParser.ts
export class ClineLogParser implements ILogParser {
  async discoverSessionLog(
    promptText: string,
    startTime: Date,
    sessionId?: string
  ): Promise<string | null> {
    const tasksDir = path.join(os.homedir(), ".cline", "data", "tasks");

    if (sessionId) {
      const taskDir = path.join(tasksDir, sessionId);
      if (fs.existsSync(taskDir)) {
        return path.join(taskDir, "ui_messages.json");
      }
      return null;
    }

    // Find recently modified task directories
    const dirs = fs
      .readdirSync(tasksDir)
      .map((d) => ({
        name: d,
        path: path.join(tasksDir, d),
        mtime: fs.statSync(path.join(tasksDir, d)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    // Match by task metadata timestamp
    for (const dir of dirs) {
      const metadataPath = path.join(dir.path, "task_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        const taskTime = metadata.model_usage?.[0]?.ts;

        if (taskTime && Math.abs(taskTime - startTime.getTime()) < 30000) {
          return path.join(dir.path, "ui_messages.json");
        }
      }
    }

    return null;
  }

  async readNewLines(filePath: string): Promise<BaseCliEvent[]> {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as BaseCliEvent[];
  }
}
```

---

## Appendix D: References

- **Cline CLI GitHub:** https://github.com/cline/cline
- **Cline CLI Version:** 3.74.0 (as of March 2026)
- **FlightPath Harness Guide:** `docs/ADDING_NEW_CLI_HARNESS.md`
- **Claude Integration:** `src/flightpath/harness/claude/` (reference implementation)
- **Codex Integration:** `src/flightpath/harness/codex/` (reference implementation)
- **OpenCode Integration:** `src/flightpath/harness/opencode/` (reference implementation)

---

**Document Version:** 1.0  
**Last Updated:** March 19, 2026  
**Next Review:** After Cline CLI v4.0 (expected hook stabilization)
