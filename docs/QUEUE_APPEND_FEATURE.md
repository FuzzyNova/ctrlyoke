# Queue Append & Dynamic Queue Extension

**Last Updated**: December 27, 2024  
**Status**: ✅ Production Ready  
**Related**: [FLIGHTPATH_MCP_IMPLEMENTATION.md](FLIGHTPATH_MCP_IMPLEMENTATION.md)

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Core Concepts](#core-concepts)
4. [User-Driven Queue Append](#user-driven-queue-append)
5. [AI-Driven Queue Extension (MCP)](#ai-driven-queue-extension-mcp)
6. [Working File System](#working-file-system)
7. [Settings Reference](#settings-reference)
8. [Architecture & Implementation](#architecture--implementation)
9. [Troubleshooting](#troubleshooting)

---

## Overview

FlightPath supports two ways to extend workflows dynamically:

1. **User-Driven Queue Append**: Manually add prompts/workflows to the current queue via context menu
2. **AI-Driven Queue Extension (MCP)**: AI agents autonomously extend queues through Model Context Protocol

Both approaches use the same backend (`PromptQueue.appendPrompts()`) and working file system, ensuring consistent behavior.

### Key Features

- ✅ **Append without clearing**: Add prompts while preserving dashboard history
- ✅ **Crash recovery**: Auto-resume workflows after VS Code restarts
- ✅ **Working file persistence**: Queue state saved to `.flightpath/.queue/` on every change
- ✅ **Two insertion modes**: "end" (append to queue end) and "next" (insert after current prompt)
- ✅ **Atomic operations**: Race-condition-free concurrent queue modifications
- ✅ **MCP integration**: AI agents can extend queues via standardized MCP protocol
- ✅ **Cross-platform**: Works with Copilot CLI, Claude CLI, Codex CLI, and VS Code Chat

---

## Quick Start

### User: Queue Additional Prompts

**Option 1: Context Menu (Recommended)**

1. Start a workflow (or complete one)
2. Right-click on another prompt file in Explorer
3. Select **"Queue with FlightPath"** (appends to end) or **"Queue Next"** (inserts after current)
4. Prompts execute automatically

**Option 2: Editor Title Button**

1. Open a prompt file (`.prompt.md`, `.flightpath.yaml`, `.flightpath.json`)
2. Click the **Queue** icon (➕) in the editor title bar
3. Prompts are appended

### AI: Extend Queue via MCP

**Prerequisites**:

- MCP server running (see [MCP Setup](FLIGHTPATH_MCP_IMPLEMENTATION.md))
- CLI provider configured with FlightPath MCP server

**Example MCP Tool Call**:

```json
{
  "name": "flightpath_append_queue",
  "arguments": {
    "prompts": [
      {
        "id": "implement-tests",
        "prompt": "Write comprehensive unit tests for the authentication module"
      }
    ],
    "position": "next",
    "source": "MCP extension: Follow-up testing"
  }
}
```

AI agents automatically discover and invoke this tool when FlightPath MCP server is configured.

---

## Core Concepts

### 1. Queue Append vs Queue Extension

| Term                      | Actor | Trigger      | Use Case                      |
| ------------------------- | ----- | ------------ | ----------------------------- |
| **Queue Append**          | User  | Context menu | Add pre-written workflows     |
| **Queue Extension (MCP)** | AI    | Tool call    | AI-driven multi-step planning |

Both use the same `appendPrompts()` method and working file system.

### 2. Insertion Positions

**"end"** (default for user actions):

- Appends prompts to the end of the queue
- Queued prompts execute after all currently-queued prompts

**"next"** (available for both user and MCP):

- Inserts prompts immediately after the current position
- Useful for follow-up tasks that should run before later steps

**Example**:

```
Current queue: [Step 1*, Step 2, Step 3]  (* = current position)

Append "end":   [Step 1*, Step 2, Step 3, New A, New B]
Append "next":  [Step 1*, New A, New B, Step 2, Step 3]
```

### 3. Working Files

**Purpose**: Persistent queue state for crash recovery and MCP coordination

**Location**: `.flightpath/.queue/<workflow>-<timestamp>.flightpath.json`

**Format**:

```json
{
  "originalFile": "c:/dev/project/bugfix.flightpath.json",
  "workflowName": "bugfix",
  "startedAt": 1703174400000,
  "prompts": [
    { "id": "step-1", "prompt": "Analyze bug" },
    { "id": "step-2", "prompt": "Fix bug" }
  ],
  "_runtime": {
    "currentIndex": 0,
    "completedPrompts": ["hash-of-step-1"],
    "executionState": "running",
    "appendSegments": [
      {
        "id": "1734480001-abc123",
        "timestamp": 1734480001000,
        "source": "User append (end): follow-up.flightpath.json",
        "promptCount": 2,
        "promptIndices": [2, 3]
      }
    ]
  }
}
```

**Key Points**:

- **Source of truth**: Both user actions and MCP writes modify this file
- **Atomic writes**: Uses temp file + rename to prevent corruption
- **File watcher**: Detects external changes (e.g., MCP appends) and reloads queue
- **Auto-resume**: Most recent working file auto-loads on VS Code startup

---

## User-Driven Queue Append

### Commands

FlightPath provides two context menu commands:

| Command                           | Position | Icon | Description                    |
| --------------------------------- | -------- | ---- | ------------------------------ |
| `flightpath.queueFromContext`     | `end`    | ➕   | Append prompts to end of queue |
| `flightpath.queueNextFromContext` | `next`   | ⏭️   | Insert prompts after current   |

Both commands are available in:

- Explorer context menu (right-click on file)
- Editor title bar (icon button)
- Editor title context menu (right-click on editor tab)

### Supported File Formats

- `.prompt.md` - Single markdown prompt
- `.flightpath.yaml` / `.flightpath.yml` - Multi-step YAML workflow
- `.flightpath.json` - Multi-step JSON workflow

### Behavior by Queue State

| Queue State | Action        | Result                                        |
| ----------- | ------------- | --------------------------------------------- |
| Empty/Idle  | Queue prompts | **Loads and starts workflow** (like "Run")    |
| Running     | Queue prompts | Appended, execution continues                 |
| Completed   | Queue prompts | Appended, execution **auto-resumes**          |
| Paused      | Queue prompts | Appended, remains paused (resume to continue) |
| Cancelling  | Queue prompts | ❌ Error: "Cannot append..."                  |
| Error       | Queue prompts | ❌ Error: "Cannot append..."                  |

### Queue Size Limits

**Settings**:

- `flightpath.maxQueueSize` (default: 100, range: 1-1000)
- `flightpath.unlimitedMode` (default: false)

**Enforcement**:

```
Current: 3, New: 2, Max: 100     → ✅ Appended (total: 5)
Current: 99, New: 2, Max: 100    → ❌ Warning: "Queue size limit exceeded..."
Current: 50, New: 100, Unlimited → ✅ Appended (total: 150)
```

### Examples

**Example 1: Append to Completed Workflow**

```bash
# 1. Run initial analysis workflow
.flightpath/analyze-code.flightpath.yaml → Completes

# 2. Right-click follow-up file in Explorer
.flightpath/implement-fixes.flightpath.yaml → "Queue with FlightPath"

# 3. Queue auto-resumes with 5 new prompts
Dashboard shows: "Step 4 of 8" (3 original + 5 new)
```

**Example 2: Queue Next for Immediate Follow-Up**

```bash
# Current queue: [Analyze*, Implement, Test, Deploy]

# Right-click urgent-fix.prompt.md → "Queue Next"

# New queue: [Analyze*, Urgent Fix, Implement, Test, Deploy]
# Urgent fix runs before implementation
```

---

## AI-Driven Queue Extension (MCP)

**See [FLIGHTPATH_MCP_IMPLEMENTATION.md](FLIGHTPATH_MCP_IMPLEMENTATION.md) for full details.**

### Overview

FlightPath's MCP server exposes queue management tools that AI agents can invoke during workflow execution. This enables autonomous multi-step planning without user intervention.

### MCP Tools

**1. `flightpath_queue_status` (Read)**

Returns current queue state for decision-making.

**Input**: None

**Output**:

```json
{
  "workingFilePath": ".flightpath/.queue/bugfix-2024-12-27T10-30-00.flightpath.json",
  "currentIndex": 2,
  "totalPrompts": 5,
  "executionState": "running",
  "completedPrompts": 2,
  "pendingPrompts": 3
}
```

**2. `flightpath_append_queue` (Write)**

Appends prompts to the queue.

**Input**:

```json
{
  "prompts": [
    {
      "id": "optional-id",
      "prompt": "Prompt text with @workspace and #file: references"
    }
  ],
  "position": "next", // or "end"
  "source": "MCP extension: Testing phase"
}
```

**Output**:

```json
{
  "success": true,
  "promptsAdded": 1,
  "newQueueSize": 6,
  "insertPosition": 3
}
```

### Supported CLI Platforms

| Platform     | Config Method             | Setup Required     | Status         |
| ------------ | ------------------------- | ------------------ | -------------- |
| Copilot CLI  | `--additional-mcp-config` | Temp JSON file     | ✅ Tested      |
| Claude CLI   | `--mcp-config`            | Temp JSON file     | ✅ Tested      |
| Codex CLI    | `-c` inline TOML          | None (inline)      | ✅ Tested      |
| VS Code Chat | `package.json`            | Extension manifest | 🚧 In Progress |

### How AI Agents Use MCP

**Scenario**: Copilot discovers bugs during code analysis and extends workflow to fix them.

```typescript
// AI's internal reasoning (not visible to user):
// "I found 3 critical bugs. I'll extend the workflow with fix tasks."

// AI invokes MCP tool:
flightpath_append_queue({
  prompts: [
    {
      id: "fix-auth-bug",
      prompt: "Fix authentication null pointer in login.ts:45",
    },
    {
      id: "fix-validation",
      prompt: "Add input validation to user registration",
    },
    { id: "test-fixes", prompt: "Write tests for the bug fixes" },
  ],
  position: "next", // Run immediately after current analysis
  source: "MCP extension: Bug fixes from analysis",
});

// FlightPath automatically:
// 1. Writes prompts to working file atomically
// 2. File watcher detects change
// 3. Queue reloads with new prompts
// 4. Execution continues with extended queue
```

### MCP Configuration Examples

**Copilot CLI**:

```json
{
  "mcpServers": {
    "flightpath": {
      "type": "local",
      "tools": ["*"],
      "command": "node",
      "args": ["c:/dev/FlightPath/out/mcp-server.js"],
      "env": {
        "FLIGHTPATH_WORKSPACE": "c:/dev/my-project"
      }
    }
  }
}
```

**Claude CLI**:

```json
{
  "mcpServers": {
    "flightpath": {
      "type": "stdio",
      "command": "node",
      "args": ["c:/dev/FlightPath/out/mcp-server.js"],
      "env": {
        "FLIGHTPATH_WORKSPACE": "c:/dev/my-project"
      }
    }
  }
}
```

**Codex CLI** (inline TOML):

```bash
codex -c '[mcp_servers.flightpath]
type = "stdio"
command = "node"
args = ["c:/dev/FlightPath/out/mcp-server.js"]
env = {FLIGHTPATH_WORKSPACE = "c:/dev/my-project"}'
```

---

## Working File System

### Architecture

FlightPath uses a **working file system** to persist queue state independently from original prompt files.

**Lifecycle**:

1. **Creation**: When workflow starts, FlightPath copies prompts to `.flightpath/.queue/<workflow>-<timestamp>.flightpath.json`
2. **Updates**: Every queue modification writes to working file atomically (temp file + rename)
3. **Watching**: File watcher monitors working file for external changes (e.g., MCP appends)
4. **Reload**: On change detection, queue reloads and merges new prompts (deduplicates by hash/ID)
5. **Auto-Resume**: On VS Code startup, most recent working file auto-loads if `autoLoadRecentSession: true`

### Atomic Operations

**Problem**: Concurrent writes (user append + MCP append) could corrupt working file.

**Solution**: Operation queue serializes all file operations.

```typescript
// All file operations queued sequentially
this.operationQueue = this.operationQueue.then(async () => {
  await this._updateWorkingFileInternal();
});
```

**Pattern**: Temp file + atomic rename

```typescript
const tempPath = workingFilePath + ".tmp";
await fs.writeFile(tempPath, JSON.stringify(workingFile, null, 2));
await fs.rename(tempPath, workingFilePath); // Atomic on most filesystems
```

### Prompt Deduplication

**Challenge**: MCP might append prompts that already exist in memory.

**Solution**: Hash-based identity tracking.

```typescript
function hashPromptContent(prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(prompt)
    .digest("hex")
    .substring(0, 16);
}

// Deduplication logic (in _updateWorkingFileInternal)
const memoryHashes = new Set(
  memoryPrompts.map((p) => hashPromptContent(p.prompt))
);
const newPromptsFromDisk = diskPrompts.filter((p) => {
  const hash = hashPromptContent(p.prompt);
  return !memoryHashes.has(hash);
});
```

### Runtime State Persistence

**`_runtime` Object**: Tracks execution progress for crash recovery.

```json
{
  "_runtime": {
    "currentIndex": 2,
    "completedPrompts": ["hash1", "hash2"],
    "executionState": "running",
    "appendSegments": [
      {
        "id": "1734480001-abc123",
        "timestamp": 1734480001000,
        "source": "MCP extension: Testing",
        "promptCount": 3,
        "promptIndices": [3, 4, 5]
      }
    ]
  }
}
```

**Updated on**:

- Prompt completion (`completeCurrentAndMoveNext()`)
- Workflow completion (`markCompleted()`)
- Error state (`markErrored()`)
- Queue append (`appendPrompts()`)

### File Watching Strategy

**What's Watched**: Working file (`.flightpath/.queue/<workflow>.flightpath.json`), NOT original prompt file.

**Why**: MCP writes to working file, not original. Watching original file would miss MCP appends.

**Reload Scenarios**:

| Queue State      | File Change Detected     | Action                            |
| ---------------- | ------------------------ | --------------------------------- |
| IDLE             | New working file appears | Load into queue (initial startup) |
| RUNNING/PAUSED   | Working file modified    | Reload and merge new prompts      |
| COMPLETED        | Working file modified    | Reload (for manual edits)         |
| CANCELLING/ERROR | Any change               | Ignore (queue locked)             |

---

## Settings Reference

### Queue Append Settings

| Setting                            | Type    | Default | Description                                      |
| ---------------------------------- | ------- | ------- | ------------------------------------------------ |
| `flightpath.maxQueueSize`          | number  | 100     | Maximum prompts allowed (range: 1-1000)          |
| `flightpath.maxExecutionTime`      | number  | 18000   | Max execution time in seconds (5 hours)          |
| `flightpath.unlimitedMode`         | boolean | false   | Ignore size and time limits (use with caution)   |
| `flightpath.autoLoadRecentSession` | boolean | true    | Auto-load most recent session on VS Code startup |

### MCP Settings

| Setting                  | Type    | Default | Description                                     |
| ------------------------ | ------- | ------- | ----------------------------------------------- |
| `flightpath.enableMcp`   | boolean | false   | Enable MCP server for AI-driven queue extension |
| `flightpath.mcpLogLevel` | enum    | "info"  | MCP server log level (debug/info/warn/error)    |

### Dynamic Queue Settings (Legacy)

**Note**: Dynamic Queue was the original implementation approach using instructions instead of MCP tools. It's now **deprecated** in favor of MCP-based queue extension.

| Setting (Deprecated)                      | Type    | Default | Description                                      |
| ----------------------------------------- | ------- | ------- | ------------------------------------------------ |
| `flightpath.enableDynamicQueue`           | boolean | false   | Inject queue extension instructions into prompts |
| `flightpath.dynamicExtensionOnLastPrompt` | boolean | true    | Allow extension on last prompt by default        |

**Migration Path**: Disable `enableDynamicQueue` and use MCP instead. MCP provides:

- ✅ Standardized protocol (works across all AI platforms)
- ✅ Better error handling (JSON-RPC)
- ✅ Fine-grained control (two dedicated tools)
- ✅ No prompt token overhead (tool calls separate from prompts)

---

## Architecture & Implementation

### Backend Components

**1. PromptQueue.ts**

Core queue state management and file operations.

**Key Methods**:

- `appendPrompts(prompts, source, position)` - Add prompts to queue (supports "next" and "end")
- `canAppend()` - Validate queue state before appending
- `isCompleted()` - Check if queue finished
- `updateWorkingFile()` - Persist queue state to disk
- `_updateWorkingFileInternal()` - Internal update without operation queue (prevents deadlock)
- `readWorkingFile()` / `writeWorkingFileAtomic()` - File I/O with atomic writes

**State Tracking**:

```typescript
interface QueueState {
  currentIndex: number;
  status: ExecutionState;
  prompts: PromptItem[];
  results: PromptResult[];
  completedIds: Set<string>;
  workingFilePath?: string;
  appendSegments: AppendSegment[];
}
```

**2. FlightPathManager.ts**

Orchestrates user commands and file watching.

**Key Methods**:

- `appendFromFile(filePath, position)` - User-driven append via context menu
- `setupPromptFileWatcher(filePath)` - Watch working file for changes
- `onWorkingFileChanged()` - Reload queue on external modifications
- `autoLoadRecentSession()` - Load most recent working file on startup

**3. WorkflowExecutor.ts**

Drives prompt execution loop.

**Dynamic Queue Support**:

```typescript
async execute() {
  while (this.queue.hasNext()) {  // Checks queue state each iteration
    const prompt = this.queue.getCurrentPrompt();
    await this.integration.sendPrompt(prompt);
    await this.queue.completeCurrentAndMoveNext();
    // If MCP appended prompts, hasNext() returns true again
  }
}
```

**4. MCP Server (mcp-server.ts)**

Standalone Node.js process exposing FlightPath tools via stdio.

**Transport**: JSON-RPC over stdio (compatible with all MCP clients)

**Tools**:

- `flightpath_queue_status` - Read current queue state
- `flightpath_append_queue` - Write prompts to working file

**Logging**: File-based logging to `.flightpath/logs/mcp-<timestamp>.log` (avoids stderr capture by CLIs)

### Data Flow Diagrams

**User-Driven Append**:

```
User (Context Menu)
  ↓
flightpath.queueFromContext command
  ↓
FlightPathManager.appendFromFile(filePath, "end")
  ↓
PromptQueue.appendPrompts(prompts, source, "end")
  ↓
[Operation Queue] → _updateWorkingFileInternal()
  ↓
Working File (atomic write)
  ↓
File Watcher detects change
  ↓
onWorkingFileChanged() (no-op if change from FlightPath itself)
  ↓
Dashboard updates
```

**MCP-Driven Extension**:

```
AI Agent (CLI or VS Code Chat)
  ↓
MCP Tool Call: flightpath_append_queue
  ↓
mcp-server.ts (stdio process)
  ↓
Read working file from disk
  ↓
Merge new prompts (deduplication)
  ↓
Write working file atomically
  ↓
Return success response
  ↓
File Watcher (in FlightPath extension) detects change
  ↓
FlightPathManager.onWorkingFileChanged()
  ↓
PromptQueue.reloadFromWorkingFile()
  ↓
Merge prompts into memory queue (skip duplicates)
  ↓
Dashboard notification: "Queue extended (+3 prompts)"
  ↓
WorkflowExecutor.execute() continues with new prompts
```

### Critical Implementation Details

**1. Operation Queue (Prevents Race Conditions)**

All queue modifications and file writes are serialized:

```typescript
private operationQueue: Promise<void> = Promise.resolve();

public async appendPrompts(...) {
  this.operationQueue = this.operationQueue.then(async () => {
    // Critical section - no concurrent access
    this.state.prompts.push(...prompts);
    await this._updateWorkingFileInternal();
  });
  await this.operationQueue;
}
```

**2. Internal vs Public updateWorkingFile (Prevents Deadlock)**

**Problem**: Calling `updateWorkingFile()` from within an operation queue would deadlock.

**Solution**: Public method queues operation, internal method executes directly.

```typescript
// Public (uses operation queue)
public async updateWorkingFile(): Promise<void> {
  this.operationQueue = this.operationQueue.then(async () => {
    await this._updateWorkingFileInternal();
  });
  await this.operationQueue;
}

// Internal (no queue - safe to call from within queued operations)
private async _updateWorkingFileInternal(): Promise<void> {
  // Actual file I/O here
}
```

**3. Prompt Identity Tracking**

**Hash-Based**:

```typescript
function hashPromptContent(prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(prompt.trim().toLowerCase())
    .digest("hex")
    .substring(0, 16);
}
```

**ID-Based** (optional):

```typescript
function isPromptCompleted(
  prompt: PromptItem,
  completedIds: Set<string>
): boolean {
  if (prompt.id && completedIds.has(prompt.id)) {
    return true;
  }
  const hash = hashPromptContent(prompt.prompt);
  return completedIds.has(hash);
}
```

**4. Dashboard Preservation on Append**

**Problem**: Appending to completed queue would clear dashboard output.

**Solution**: Skip restart when continuing from append.

```typescript
async executeLoadedPromptFile(modeOverride, continueFromCurrent = false) {
  if (!continueFromCurrent) {
    // Fresh start - send EXECUTION_STARTED (clears dashboard)
    this.dashboardProvider.updateExecutionStarted(...);
  } else {
    // Continuing from append - send PROGRESS_UPDATE (preserves state)
    this.dashboardProvider.updateProgress(...);
  }
}
```

---

## Troubleshooting

### Common Issues

**1. Queue Not Appending**

**Symptoms**:

- Context menu does nothing
- No notification shown

**Possible Causes**:

- Queue in invalid state (cancelling/error)
- Queue size limit exceeded
- File parse error

**Solutions**:

- Check Output panel (FlightPath channel) for errors
- Verify queue state in dashboard (must be running/completed/paused)
- Increase `maxQueueSize` or enable `unlimitedMode`

**2. Working File Not Updating**

**Symptoms**:

- Working file in `.flightpath/.queue/` doesn't reflect queue changes
- Console shows "About to update working file..." but never "Successfully wrote"

**Possible Causes**:

- Operation queue deadlock (should be fixed in current version)
- File system permissions

**Solutions**:

- Check console for errors
- Verify write permissions on `.flightpath/.queue/` directory
- Restart VS Code

**3. MCP Appends Not Detected**

**Symptoms**:

- AI calls MCP tool, returns success, but queue doesn't extend
- File watcher not triggering reload

**Possible Causes**:

- File watcher not set up
- Working file path mismatch
- Queue in IDLE state (file watcher only active during execution)

**Solutions**:

- Check console: "FlightPath: Working file watcher activated"
- Verify MCP server logs in `.flightpath/logs/mcp-*.log`
- Ensure queue is in RUNNING or PAUSED state when MCP appends

**4. Auto-Resume Not Working**

**Symptoms**:

- VS Code restarts, but workflow doesn't load
- Dashboard empty on startup

**Possible Causes**:

- `autoLoadRecentSession` setting disabled
- No working files in `.flightpath/.queue/`
- Working file corrupted (invalid JSON)

**Solutions**:

- Check setting: Settings → FlightPath → Auto Load Recent Session
- Verify `.flightpath/.queue/` directory exists and has `.flightpath.json` files
- Check console: "FlightPath: Auto-loaded recent session: <workflow>"

**5. Dashboard Shows Wrong Step Count**

**Symptoms**:

- Step counter shows "Step 3 of 2" (count lower than index)
- Appended prompts missing from prompt list

**Possible Causes**:

- Dashboard not receiving PROMPTS_EXTENDED message
- State change event not fired

**Solutions**:

- Check `FlightPathManager.appendFromFile()` calls `dashboardProvider.updatePromptsExtended()`
- Verify `PromptQueue.appendPrompts()` calls `this.emitStateChange()`

### Debug Checklist

When troubleshooting queue append issues:

- [ ] Check Output panel (FlightPath channel) for errors
- [ ] Check console logs (F12 → Console tab)
- [ ] Verify working file exists in `.flightpath/.queue/`
- [ ] Verify working file has valid JSON (open and inspect)
- [ ] Check MCP server logs in `.flightpath/logs/mcp-*.log` (if using MCP)
- [ ] Verify queue state in dashboard (should be running/paused/completed, not error/cancelling)
- [ ] Check file watcher status: Console should show "Working file watcher activated: <path>"

---

## Migration Guide: Dynamic Queue → MCP

**Legacy Feature**: FlightPath originally implemented queue extension by injecting instructions into prompts (Dynamic Queue).

**Current Recommendation**: Use MCP-based queue extension instead.

### Why Migrate?

| Aspect             | Dynamic Queue (Legacy)        | MCP (Current)                             |
| ------------------ | ----------------------------- | ----------------------------------------- |
| **Protocol**       | Custom instructions           | Standard MCP protocol                     |
| **Compatibility**  | Copilot-specific              | All AI platforms (Copilot, Claude, Codex) |
| **Token Overhead** | ~200 tokens per prompt        | Zero (tool calls separate)                |
| **Error Handling** | Manual (AI might fail)        | JSON-RPC error responses                  |
| **Reliability**    | Depends on AI following rules | Standardized tool invocation              |
| **Debugging**      | Prompt inspection             | MCP server logs                           |

### Migration Steps

**Step 1: Disable Dynamic Queue**

Settings → FlightPath:

- `Enable Dynamic Queue`: false

**Step 2: Set Up MCP**

Follow [MCP Setup Guide](FLIGHTPATH_MCP_IMPLEMENTATION.md#automated-setup).

**Step 3: Test MCP Extension**

1. Start a workflow
2. Check MCP server logs: `.flightpath/logs/mcp-*.log`
3. Verify AI can invoke `flightpath_queue_status` and `flightpath_append_queue`

**Step 4: Remove Legacy Settings**

After confirming MCP works, remove from settings:

- `flightpath.enableDynamicQueue`
- `flightpath.dynamicExtensionOnLastPrompt`

### Backward Compatibility

Dynamic Queue instructions are still supported for users who haven't migrated to MCP. Both systems can coexist:

- **Dynamic Queue** (if enabled): Injects instructions into prompts
- **MCP** (if configured): AI uses tools instead

**Recommendation**: Disable Dynamic Queue once MCP is working to reduce token usage.

---

## Future Enhancements

### Planned Features

**1. Visual Segmentation**

Show append boundaries in dashboard with headers/separators:

```
Prompt 1: Analyze code                  [Completed]
Prompt 2: Fix bugs                      [Running]
─────────────────────────────────────────────────────
Queued: follow-up.flightpath.json (3 prompts)
─────────────────────────────────────────────────────
Prompt 3: Write tests                   [Pending]
Prompt 4: Update docs                   [Pending]
Prompt 5: Deploy                        [Pending]
```

**2. Queue Management UI**

- Drag-and-drop reordering
- Remove specific prompts
- Edit prompts in-place
- Pause/resume individual prompts

**3. Queue Analytics**

- Track append sources (user vs MCP)
- Measure queue growth patterns
- Identify bottleneck prompts
- Success rate by append type

**4. Advanced MCP Tools**

- `flightpath_queue_insert` - Insert at arbitrary position (not just next/end)
- `flightpath_queue_remove` - Remove prompts by ID/index
- `flightpath_queue_reorder` - Change execution order
- `flightpath_queue_branch` - Create conditional workflow paths

**5. Multi-Workspace Support**

- Support multiple concurrent workflows
- Queue switching in dashboard
- Cross-workspace queue dependencies

### Community Contributions

We welcome contributions! Areas needing help:

- Automated tests for MCP server
- Additional MCP tool implementations
- VS Code Language Model Tools integration
- Documentation improvements

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

---

## Related Documentation

- [FLIGHTPATH_MCP_IMPLEMENTATION.md](FLIGHTPATH_MCP_IMPLEMENTATION.md) - Complete MCP integration guide
- [.github/copilot-instructions.md](../.github/copilot-instructions.md) - Project architecture
- [CHANGELOG.md](../CHANGELOG.md) - Version history

---

## Changelog

### December 27, 2024 - Documentation Consolidation

- Merged QUEUE_APPEND_FEATURE.md, DYNAMIC_QUEUE_IMPLEMENTATION.md, DYNAMIC_QUEUE_USAGE.md
- Added comprehensive MCP section with cross-references
- Updated troubleshooting section
- Added migration guide from Dynamic Queue to MCP

### December 23, 2024 - Bug Fixes

- Fixed operation queue deadlock (Bug 3)
- Fixed runtime state persistence (Bug 4)
- All queue modifications now update working file immediately

### December 22, 2024 - Phase 2 Complete

- Auto-load recent session on startup
- Added `autoLoadRecentSession` setting
- Silent session loading (no intrusive notifications)

### December 21, 2024 - Phase 1 Complete

- Core queue append functionality
- Working file system with atomic operations
- File watcher for external changes
- Dashboard preservation on append
