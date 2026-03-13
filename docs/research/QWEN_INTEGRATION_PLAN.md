# Qwen Code CLI Integration Plan

**Date:** March 13, 2026  
**Status:** Ready for Implementation  
**Qwen Code Version:** 0.12.3  
**Target FlightPath Version:** 1.2.0  

---

## Executive Summary

This plan outlines the implementation of **Qwen Code CLI** as a first-class harness in FlightPath. Qwen Code is an open-source AI agent optimized for Qwen3-Coder models, providing structured output formats (`text`, `json`, `stream-json`) and session management via JSONL log files.

**Key Architectural Decisions:**

1. **Completion Detection:** Process exit (headless) + log file monitoring (interactive) — **NOT** hook-based (undocumented/partially implemented)
2. **Output Format:** `--output-format stream-json` for real-time streaming
3. **Session Management:** UUID extraction from stdout events, log file fallback
4. **Permission Model:** Mode-based (`plan`, `default`, `auto-edit`, `yolo`) — converted from FlightPath's pattern-based settings
5. **Hook Strategy:** Hooks exist (`qwen hooks enable/disable`) but are undocumented and reportedly buggy (issue #1708). Phase 3 will implement when Qwen publishes stable API.

**Estimated Effort:** 24-35 hours (Phase 1 MVP)  
**Risk Level:** Medium (hooks undocumented, but core functionality stable)

---

## Table of Contents

1. [Implementation Phases](#1-implementation-phases)
2. [Phase 1: Core Harness Implementation](#phase-1-core-harness-implementation)
3. [Phase 2: Interactive Mode Support](#phase-2-interactive-mode-support)
4. [Phase 3: Advanced Features](#phase-3-advanced-features)
5. [Testing Strategy](#testing-strategy)
6. [Migration Path](#migration-path)
7. [Open Questions](#open-questions)

---

## 1. Implementation Phases

### Phase 1: Core Harness Implementation (MVP) — 24-35 hours

**Goal:** Headless mode with `stream-json` output, process-exit completion detection

**Deliverables:**
- ✅ 5 provider files in `src/flightpath/harness/qwen/`
- ✅ Stream-JSON parser for real-time output
- ✅ Session ID extraction from stdout
- ✅ Process-exit completion detection
- ✅ Tool permission mapping (mode-based)
- ✅ Basic log parser for session discovery

**Excluded:**
- ❌ Interactive mode (Phase 2)
- ❌ Hook-based completion (not stable)
- ❌ Advanced tool approval workflows

---

### Phase 2: Interactive Mode Support — 12-18 hours

**Goal:** TUI support with log file monitoring for completion detection

**Deliverables:**
- ✅ Log file monitor with inactivity timeout
- ✅ Session discovery via log file matching
- ✅ TUI stream processor for terminal UI
- ✅ Fallback completion detection (timeout-based)

**Excluded:**
- ❌ Hook-based features (waiting for stable API)

---

### Phase 3: Advanced Features — TBD

**Goal:** Hook support, advanced tool workflows (when Qwen stabilizes hooks)

**Deliverables:**
- ⏳ PreToolUse/PostToolUse hook integration
- ⏳ SessionStart/Stop hook completion detection
- ⏳ Custom hook script execution

**Blockers:**
- ⚠️ Qwen Code hook API stabilization
- ⚠️ Official documentation publication

---

## 2. Phase 1: Core Harness Implementation

### 2.1 Directory Structure

```
src/flightpath/harness/qwen/
├── QwenCliProvider.ts           # Main provider descriptor
├── QwenResponseParser.ts        # Stream-JSON parser, session ID extraction
├── QwenNotificationMonitor.ts   # Process exit detection (headless)
├── QwenToolPermissionMapper.ts  # Mode-based permission mapping
└── QwenLogParser.ts             # Log file parser for session discovery
```

---

### 2.2 Implementation Checklist

#### Step 1: QwenCliProvider.ts (2-3 hours)

**Purpose:** Aggregate all Qwen-specific components into a single provider descriptor

**Key Fields:**
```typescript
export class QwenCliProvider implements ICliProvider {
  readonly name = 'Qwen Code';
  readonly harnessId = Harness.QWEN_CLI;
  readonly cliCommand = 'qwen';
  
  // Stream-JSON mode for real-time output
  readonly config = {
    supportsHeadless: true,
    supportsInteractive: true,
    shouldStreamHeadlessOutput: true,
    streamOutputFormat: 'stream-json',
    chromePatterns: [...], // TUI output patterns to filter
  };
  
  // Aggregates parser, monitor, mapper, logParser
  getResponseParser() { ... }
  getNotificationMonitor() { ... }
  getToolPermissionMapper() { ... }
  getLogParser() { ... }
}
```

**Implementation:**
- [ ] Create class implementing `ICliProvider`
- [ ] Define `cliCommand = 'qwen'`
- [ ] Set `harnessId = Harness.QWEN_CLI` (add to `Harness` enum)
- [ ] Configure `shouldStreamHeadlessOutput = true`
- [ ] Define Chrome output patterns (filter TUI artifacts)
- [ ] Wire up parser, monitor, mapper, logParser

**Reference:** `src/flightpath/harness/claude/ClaudeCliProvider.ts`

---

#### Step 2: QwenResponseParser.ts (4-5 hours)

**Purpose:** Parse stream-JSON output, extract session IDs, tokens, tool calls

**Key Methods:**
```typescript
export class QwenResponseParser implements IResponseParser {
  // Parse line-delimited JSON (NDJSON)
  parseStreamChunk(chunk: string): ParsedEvent[];
  
  // Extract session ID from system/init event
  extractSessionId(stdout: string): string | null;
  
  // Extract final response text from assistant events
  extractFinalResponse(stdout: string): string;
  
  // Extract tool calls from assistant events
  extractToolCalls(stdout: string): ToolCall[];
  
  // Extract usage statistics from result event
  extractUsageStats(stdout: string): UsageStats;
}
```

**Stream-JSON Event Types:**
```json
// 1. System init event (contains session_id)
{"type":"system","subtype":"init","session_id":"uuid-123",...}

// 2. Assistant message (thinking + text/tool_use)
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."}]}}

// 3. User message (tool results)
{"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}

// 4. Result event (final summary)
{"type":"result","subtype":"success","result":"...","usage":{...},"permission_denials":[...]}
```

**Implementation:**
- [ ] Implement NDJSON parser (split by newline, parse each line)
- [ ] Extract `session_id` from first `system` event
- [ ] Accumulate `assistant.message.content` for full response
- [ ] Parse `tool_use` content blocks for tool calls
- [ ] Extract `result` event for final output + stats
- [ ] Handle `permission_denials` array from result event
- [ ] Map Qwen `functionCall` format to FlightPath `ToolCall` interface

**Reference:** `src/flightpath/harness/claude/ClaudeResponseParser.ts`

---

#### Step 3: QwenNotificationMonitor.ts (3-4 hours)

**Purpose:** Detect completion via process exit (headless mode)

**Key Insight:** Qwen does **NOT** support stable session lifecycle hooks. Use process exit as primary completion signal.

```typescript
export class QwenNotificationMonitor implements INotificationMonitor {
  // Headless: process exit = completion
  async startMonitoring(options: MonitoringOptions): Promise<void> {
    const process = options.process; // ChildProcess
    
    // Wait for process exit
    process.on('exit', (code) => {
      if (code === 0) {
        options.onComplete();
      } else {
        options.onError(new Error(`Qwen exited with code ${code}`));
      }
    });
  }
  
  // Interactive: NOT implemented in Phase 1 (Phase 2: log file monitoring)
  stopMonitoring(): void { ... }
}
```

**Implementation:**
- [ ] Implement `startMonitoring()` for headless mode
- [ ] Listen for `exit` event on child process
- [ ] Call `onComplete()` callback on successful exit
- [ ] Call `onError()` callback on non-zero exit code
- [ ] Implement `stopMonitoring()` (no-op for headless)

**Note:** Interactive mode completion detection (log file polling) deferred to Phase 2.

**Reference:** `src/flightpath/harness/copilot/CopilotNotificationMonitor.ts`

---

#### Step 4: QwenToolPermissionMapper.ts (2-3 hours)

**Purpose:** Convert FlightPath's permission settings to Qwen CLI arguments

**Key Difference:** Qwen uses **mode-based** permissions, not pattern-based like Claude/Copilot.

| FlightPath Setting | Qwen Mapping |
|-------------------|--------------|
| `cliExecutionMode: 'headless'` | No flag (default) |
| `cliExecutionMode: 'interactive'` | Terminal TUI (handled by CliIntegration) |
| `cliToolPermissions: 'dangerouslyAllowAll'` | `-y` (YOLO mode) |
| `cliToolPermissions: 'allowAll'` | `--approval-mode auto-edit` |
| `cliToolPermissions: 'custom'` | `--approval-mode default` + tool lists |
| `cliAllowedTools: [...]` | `--allowed-tools [...]` |
| `cliDeniedTools: [...]` | `--exclude-tools [...]` |

**Implementation:**
```typescript
export class QwenToolPermissionMapper implements IToolPermissionMapper {
  mapToCliArgs(settings: ToolPermissionSettings): string[] {
    const args: string[] = [];
    
    if (settings.permissions === 'dangerouslyAllowAll') {
      args.push('-y'); // YOLO mode
    } else if (settings.permissions === 'allowAll') {
      args.push('--approval-mode', 'auto-edit');
    } else if (settings.permissions === 'custom') {
      args.push('--approval-mode', 'default');
      
      if (settings.allowedTools?.length > 0) {
        args.push('--allowed-tools', settings.allowedTools.join(','));
      }
      
      if (settings.deniedTools?.length > 0) {
        args.push('--exclude-tools', settings.deniedTools.join(','));
      }
    }
    
    return args;
  }
}
```

**Reference:** `src/flightpath/harness/claude/ClaudeToolPermissionMapper.ts`

---

#### Step 5: QwenLogParser.ts (4-5 hours)

**Purpose:** Parse JSONL log files for session discovery (fallback when session ID not in stdout)

**Log File Location:**
```
~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl
```

**Sanitization:**
- `C:\dev\FlightPath` → `c--dev-flightpath`
- Backslashes → dashes

**Event Types to Parse:**
```typescript
interface QwenLogEvent {
  uuid: string;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'system' | 'tool_result';
  message?: {
    role: 'user' | 'model';
    parts: Array<{
      text?: string;
      functionCall?: { name: string; args: any };
      functionResponse?: { name: string; response: any };
    }>;
  };
}
```

**Implementation:**
```typescript
export class QwenLogParser extends BaseLogParser implements ILogParser {
  // Find session ID by matching prompt text in log file
  async findSessionIdByPrompt(logFile: string, prompt: string): Promise<string | null> {
    const events = await this.readJsonlFile(logFile);
    
    // Find first user event with matching prompt
    const userEvent = events.find(e => 
      e.type === 'user' && 
      e.message?.parts?.[0]?.text?.startsWith(prompt.slice(0, 100))
    );
    
    return userEvent?.sessionId ?? null;
  }
  
  // Extract session ID from log file (first event)
  async extractSessionId(logFile: string): Promise<string | null> {
    const events = await this.readJsonlFile(logFile);
    return events[0]?.sessionId ?? null;
  }
  
  // Parse tool calls from log events
  async extractToolCalls(logFile: string): Promise<ToolCall[]> {
    const events = await this.readJsonlFile(logFile);
    
    return events
      .filter(e => e.type === 'assistant')
      .flatMap(e => e.message?.parts ?? [])
      .filter(p => p.functionCall)
      .map(p => ({
        name: p.functionCall!.name,
        args: p.functionCall!.args,
        id: p.functionCall!.id,
      }));
  }
  
  // Helper: read JSONL file (one JSON per line)
  private async readJsonlFile(filePath: string): Promise<QwenLogEvent[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }
}
```

**Reference:** `src/flightpath/harness/copilot/CopilotLogParser.ts`

---

#### Step 6: Add Harness Enum Value (30 min)

**File:** `src/types/FlightPathTypes.ts`

```typescript
export enum Harness {
  COPILOT_CLI = 'copilot-cli',
  COPILOT_CHAT = 'copilot-chat',
  CLAUDE_CLI = 'claude-cli',
  CODEX_CLI = 'codex-cli',
  OPENCODE_CLI = 'opencode-cli',
  QWEN_CLI = 'qwen-cli', // ADD THIS
}
```

**File:** `src/types/DashboardConstants.ts`

```typescript
export const HARNESS_IDS = {
  COPILOT_CLI: 'copilot-cli',
  COPILOT_CHAT: 'copilot-chat',
  CLAUDE_CLI: 'claude-cli',
  CODEX_CLI: 'codex-cli',
  OPENCODE_CLI: 'opencode-cli',
  QWEN_CLI: 'qwen-cli', // ADD THIS
} as const;
```

---

#### Step 7: Add Model Constants (1 hour)

**File:** `src/utils/ModelConstants.ts`

```typescript
export const QWEN_CLI_MODEL_LABELS: Record<string, string> = {
  'coder-model': 'Qwen Coder',
  'qwen-3-coder': 'Qwen 3 Coder',
  'qwen-3-max': 'Qwen 3 Max',
  'qwen-3-max-thinking': 'Qwen 3 Max Thinking',
} as const;

export const QWEN_CLI_DEFAULT_MODEL = 'coder-model';
```

**File:** `package.json` (settings)

```json
"flightpath.qwenCliModel": {
  "type": "string",
  "default": "coder-model",
  "enum": ["coder-model", "qwen-3-coder", "qwen-3-max", "qwen-3-max-thinking"],
  "description": "Default model for Qwen Code CLI"
}
```

---

#### Step 8: Integration Factory Registration (1 hour)

**File:** `src/flightpath/IntegrationFactory.ts`

```typescript
import { QwenCliProvider } from './harness/qwen/QwenCliProvider';

export class IntegrationFactory {
  static createQwenIntegration(context: ExtensionContext): CliIntegration {
    return new CliIntegration(new QwenCliProvider(), context);
  }
}
```

**File:** `src/flightpath/WorkflowOrchestrator.ts`

```typescript
import { IntegrationFactory } from './IntegrationFactory';

export class WorkflowOrchestrator {
  private qwenIntegration: CliIntegration;
  
  constructor(...) {
    this.qwenIntegration = IntegrationFactory.createQwenIntegration(context);
    this.allIntegrations.push(this.qwenIntegration);
  }
  
  protected resolveDetectorIntegration(harnessId: string): HarnessIntegration {
    switch (harnessId) {
      case HARNESS_IDS.QWEN_CLI:
        return this.qwenIntegration;
      // ... other cases
    }
  }
}
```

---

#### Step 9: Add VS Code Settings (1 hour)

**File:** `package.json` (contributes.configuration)

```json
{
  "flightpath.qwenCliModel": {
    "type": "string",
    "default": "coder-model",
    "enum": ["coder-model", "qwen-3-coder", "qwen-3-max", "qwen-3-max-thinking"],
    "description": "Default model for Qwen Code CLI",
    "order": 4
  },
  "flightpath.qwenCliApprovalMode": {
    "type": "string",
    "default": "default",
    "enum": ["plan", "default", "auto-edit", "yolo"],
    "description": "Tool approval mode for Qwen Code CLI",
    "order": 5
  }
}
```

---

### 2.3 Phase 1 Testing Checklist

**Headless Mode:**
- [ ] `qwen -p "just say hi" --output-format stream-json` completes successfully
- [ ] Session ID extracted from stdout
- [ ] Final response text parsed correctly
- [ ] Usage statistics extracted from result event
- [ ] Process exit triggers completion callback

**Tool Calls:**
- [ ] `qwen -p "create a file" --output-format stream-json` parses tool_use events
- [ ] `functionCall` format mapped to FlightPath `ToolCall` interface
- [ ] Permission denials captured from result event

**Session Resumption:**
- [ ] `qwen --continue -p "continue..."` resumes previous session
- [ ] Session ID passed via `--session-id` flag

**Settings:**
- [ ] `flightpath.qwenCliModel` setting respected
- [ ] `flightpath.qwenCliApprovalMode` setting mapped to CLI args
- [ ] YOLO mode (`-y`) applied for `dangerouslyAllowAll`

---

## 3. Phase 2: Interactive Mode Support

### 3.1 Implementation Checklist

#### Step 1: Log File Monitor (4-6 hours)

**Purpose:** Poll log file for completion when running in interactive mode

```typescript
export class QwenNotificationMonitor implements INotificationMonitor {
  private pollTimer?: NodeJS.Timeout;
  
  async startMonitoring(options: MonitoringOptions): Promise<void> {
    if (options.mode === 'headless') {
      // Phase 1: process exit
      return this.monitorProcessExit(options.process);
    }
    
    // Interactive: poll log file
    const logFilePath = await this.discoverLogFile(options.sessionId);
    
    let lastEventTime = Date.now();
    const timeout = 30000; // 30 second inactivity timeout
    
    this.pollTimer = setInterval(async () => {
      const events = await this.readRecentEvents(logFilePath, lastEventTime);
      
      if (events.length > 0) {
        lastEventTime = Date.now();
        
        // Check for result event
        if (events.some(e => e.type === 'result')) {
          options.onComplete();
          this.stopMonitoring();
        }
      }
      
      // Timeout-based completion
      if (Date.now() - lastEventTime > timeout) {
        options.onComplete(); // Treat timeout as success (configurable)
        this.stopMonitoring();
      }
    }, 2000); // Poll every 2 seconds
  }
}
```

**Testing:**
- [ ] Log file discovered by session ID
- [ ] Recent events read without re-reading entire file
- [ ] Result event triggers completion
- [ ] Inactivity timeout triggers completion

---

#### Step 2: Session Discovery (3-4 hours)

**Purpose:** Find log file when session ID unknown

```typescript
export class QwenLogParser {
  async discoverRecentSession(cwd: string, prompt: string): Promise<string | null> {
    const projectsDir = path.join(os.homedir(), '.qwen', 'projects');
    const sanitizedCwd = this.sanitizePath(cwd);
    const chatsDir = path.join(projectsDir, sanitizedCwd, 'chats');
    
    // Find recently modified .jsonl files
    const files = await fs.promises.readdir(chatsDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    
    // Sort by modification time
    const sorted = await Promise.all(
      jsonlFiles.map(async f => ({
        file: path.join(chatsDir, f),
        mtime: (await fs.promises.stat(path.join(chatsDir, f))).mtimeMs,
      }))
    );
    sorted.sort((a, b) => b.mtime - a.mtime);
    
    // Match prompt text in most recent files
    for (const { file } of sorted.slice(0, 5)) {
      const sessionId = await this.matchPromptInFile(file, prompt);
      if (sessionId) return sessionId;
    }
    
    return null;
  }
  
  private sanitizePath(cwd: string): string {
    return cwd
      .toLowerCase()
      .replace(/[:\\]/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }
}
```

**Testing:**
- [ ] Recent session discovered by prompt matching
- [ ] Path sanitization matches Qwen's format
- [ ] Fallback to most recent session if no match

---

#### Step 3: TUI Stream Processor (2-3 hours)

**Purpose:** Filter TUI artifacts from terminal output

```typescript
export class QwenTuiStreamProcessor extends TuiStreamProcessor {
  // Filter Qwen-specific TUI patterns
  readonly chromePatterns = [
    /\x1b\[\?25[hl]/g, // Cursor show/hide
    /\x1b\[[0-9]+;[0-9]+[Hf]/g, // Cursor movement
    /\x1b\[2J/g, // Clear screen
    /╔.*╗/g, // Box drawing
    /║.*║/g,
    /╚.*╝/g,
  ];
  
  filterChunk(chunk: string): string {
    let filtered = chunk;
    for (const pattern of this.chromePatterns) {
      filtered = filtered.replace(pattern, '');
    }
    return filtered;
  }
}
```

**Testing:**
- [ ] TUI artifacts filtered from output
- [ ] JSON lines preserved intact
- [ ] No data loss in filtering

---

### 3.2 Phase 2 Testing Checklist

**Interactive Mode:**
- [ ] Log file monitoring starts on session launch
- [ ] Completion detected via result event
- [ ] Completion detected via inactivity timeout
- [ ] Session discovery finds correct log file

**TUI Filtering:**
- [ ] Box drawing characters filtered
- [ ] Cursor movement codes filtered
- [ ] JSON output preserved

---

## 4. Phase 3: Advanced Features (TBD)

### 4.1 Hook Support (When Documented)

**Current State (v0.12.3):**

Hooks are **IMPLEMENTED** - 10 core lifecycle events (per arxiv paper 2603.05344v1, March 2026):

1. `SessionStart` - Session initialization
2. `UserPromptSubmit` - User submits prompt
3. `PreToolUse` - Before tool execution (blocking)
4. `PostToolUse` - After tool execution
5. `PostToolUseFailure` - After tool execution fails
6. `SubagentStart` - Subagent invocation
7. `SubagentStop` - Subagent completion
8. `Stop` - Session completion (critical for completion detection)
9. `PreCompact` - Before context compaction
10. `SessionEnd` - Session cleanup

**Configuration:**
- Location: `~/.qwen/settings.json` (global) or `<project>/.qwen/settings.json` (project)
- Format: JSON (similar to Claude Code)
- Hooks receive event context on stdin as JSON

**Capabilities:**
- **Blocking**: Exit code 2 prevents operation
- **Mutation**: Stdout JSON with `tool_input` modifies tool arguments
- **Override**: Can override approval decisions

**Blockers:**
- ⚠️ No official documentation for exact JSON schema
- ⚠️ Notification file mechanism unconfirmed (Claude uses `{sessionId}-start.json`, `{sessionId}-stop.json`)
- ⚠️ No working example configurations published
- ⚠️ Stdin payload schema not documented per hook type

**Implementation Plan:**
1. Test Qwen Code hooks with manual configuration in `~/.qwen/settings.json`
2. Reverse-engineer stdin payload by logging hook input during test runs
3. Determine if notification files are used (monitor `~/.qwen/` for new files during session lifecycle)
4. Implement `QwenHookManager` based on findings
5. Create notification file watcher for `Stop` hook (completion detection)
6. Update `QwenNotificationMonitor` to integrate with hook-based detection

---

### 4.2 Tool Approval Workflows

**Future Enhancement:**
- PreToolUse hook → custom approval UI
- PostToolUse hook → validation scripts
- Modify hook → auto-fix tool arguments

---

## 5. Testing Strategy

### 5.1 Unit Tests

**Files:**
- `src/flightpath/harness/qwen/QwenResponseParser.test.ts`
- `src/flightpath/harness/qwen/QwenLogParser.test.ts`
- `src/flightpath/harness/qwen/QwenToolPermissionMapper.test.ts`

**Test Fixtures:**
- Sample stream-JSON output (simple prompt)
- Sample stream-JSON output (with tool calls)
- Sample JSONL log file
- Various permission mode configurations

---

### 5.2 Integration Tests

**Manual Test Workflows:**
```yaml
# test-qwen-simple.flightpath.yaml
harness: qwen-cli
model: coder-model
prompts:
  - prompt: "Just say hi"
    endCondition:
      script: echo "success"
      returns: "true"
```

```yaml
# test-qwen-tool-calls.flightpath.yaml
harness: qwen-cli
model: coder-model
approvalMode: auto-edit
prompts:
  - prompt: "Create a file called test.txt with 'hello world'"
    endCondition:
      script: test -f test.txt && cat test.txt | grep "hello world"
      returns: "true"
```

---

### 5.3 Performance Benchmarks

**Metrics:**
- Time to first token (streaming)
- Total execution time (headless vs interactive)
- Log file polling overhead
- Memory usage during large responses

---

## 6. Migration Path

### 6.1 For Existing FlightPath Users

**No Breaking Changes:**
- Qwen harness added alongside existing harnesses
- No changes to Copilot/Claude/Codex integrations
- Opt-in via `flightpath.harness: qwen-cli` setting

### 6.2 For Qwen Code Users

**Benefits:**
- Unified prompt editor with spell check and completions
- Sequential workflow execution
- End condition validation scripts
- Session resumption across VS Code restarts
- Output history tracking

---

## 7. Open Questions

### 7.1 Technical Unknowns

1. **Hook API Timeline:** When will Qwen stabilize hooks?
   - **Mitigation:** Phase 1/2 work without hooks
   - **Risk:** Low — process exit and log polling are reliable

2. **Log File Concurrency:** What happens with parallel Qwen sessions?
   - **Mitigation:** Session-scoped log files (`<session-id>.jsonl`)
   - **Risk:** Low — each session has unique file

3. **Stream-JSON Buffering:** Is output line-buffered or token-buffered?
   - **Mitigation:** Test with simple prompts, measure latency
   - **Risk:** Low — even line-buffered is acceptable

### 7.2 Product Decisions

1. **Default Approval Mode:** What should `flightpath.qwenCliApprovalMode` default to?
   - **Recommendation:** `default` (prompt for approval) — safest for new users

2. **Telemetry:** Should FlightPath track Qwen usage metrics?
   - **Recommendation:** Yes — consistent with existing harnesses

3. **Documentation:** Should Qwen integration have separate docs?
   - **Recommendation:** Yes — `docs/QWEN_INTEGRATION.md` with setup guide

---

## Appendix A: Comparison to Existing Harnesses

| Feature | Qwen Code | Claude Code | Copilot CLI |
|---------|-----------|-------------|-------------|
| **Session ID in stdout** | ✅ | ✅ | ❌ |
| **Stream-json mode** | ✅ | ✅ | ❌ |
| **Session hooks** | ❌ (experimental) | ✅ | ✅ |
| **Tool call format** | `functionCall` | `tool_use` | `toolRequests` |
| **Permission model** | Mode-based | Pattern-based | Pattern-based |
| **Log file format** | JSONL | JSONL | Plain text |
| **Completion detection** | Process exit / Log polling | Hook notification | Hook notification |
| **Session resumption** | `--continue` / `--resume` | `--resume` | `--resume` |

---

## Appendix B: Code Samples

### B.1 Sample Stream-JSON Parser

```typescript
// QwenResponseParser.ts
export class QwenResponseParser implements IResponseParser {
  parseStreamChunk(chunk: string): ParsedEvent[] {
    const lines = chunk.split('\n').filter(line => line.trim());
    const events: ParsedEvent[] = [];
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        
        if (event.type === 'system' && event.subtype === 'init') {
          events.push({
            type: 'session_start',
            sessionId: event.session_id,
            model: event.model,
          });
        } else if (event.type === 'assistant') {
          const textContent = event.message?.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
          
          const thinkingContent = event.message?.content
            .filter((c: any) => c.type === 'thinking')
            .map((c: any) => c.thinking)
            .join('');
          
          events.push({
            type: 'response_chunk',
            text: textContent,
            thinking: thinkingContent,
          });
        } else if (event.type === 'result') {
          events.push({
            type: 'response_complete',
            result: event.result,
            usage: event.usage,
            permissionDenials: event.permission_denials,
          });
        }
      } catch (e) {
        // Skip malformed JSON lines
      }
    }
    
    return events;
  }
}
```

---

### B.2 Sample Log File Monitor

```typescript
// QwenNotificationMonitor.ts
export class QwenNotificationMonitor implements INotificationMonitor {
  private lastReadPosition = 0;
  
  async pollLogFile(logFilePath: string, onComplete: () => void): Promise<void> {
    const stats = await fs.promises.stat(logFilePath);
    const newSize = stats.size;
    
    if (newSize > this.lastReadPosition) {
      const buffer = Buffer.alloc(newSize - this.lastReadPosition);
      const fd = await fs.promises.open(logFilePath, 'r');
      
      try {
        await fd.read(buffer, 0, buffer.length, this.lastReadPosition);
        const newContent = buffer.toString('utf-8');
        
        for (const line of newContent.split('\n')) {
          if (line.trim()) {
            const event = JSON.parse(line);
            
            if (event.type === 'result') {
              onComplete();
              return;
            }
          }
        }
        
        this.lastReadPosition = newSize;
      } finally {
        await fd.close();
      }
    }
  }
}
```

---

## Appendix C: References

- **Qwen Code GitHub:** https://github.com/QwenLM/qwen-code
- **FlightPath Harness Guide:** `docs/ADDING_NEW_CLI_PROVIDER.md`
- **Claude Integration:** `src/flightpath/harness/claude/` (reference implementation)
- **Research Document:** `docs/research/QWEN_INTEGRATION_RESEARCH.md`

---

**End of Plan**
