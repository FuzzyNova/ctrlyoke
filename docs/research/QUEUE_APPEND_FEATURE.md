# Queue Append Feature - User-Driven Workflow Extension

## Overview

Enable users to append prompts, prompt files, or workflows to the current FlightPath queue without clearing the dashboard. This allows continuous workflow execution and follow-up questions while preserving all output history.

**Status**: ✅ **IMPLEMENTED - MVP Complete** (December 22, 2024)

**MVP Scope**:

- ✅ Single command: `flightpath.queueFromContext`
- ✅ Context menu item: "Queue with FlightPath"
- ✅ Editor title bar button (icon next to existing "Run" button)
- ✅ No dashboard UI changes (appended prompts appear as regular queue items)
- ✅ No new settings required (reuses Dynamic Queue settings)
- 🔜 **Working file system**: On-disk queue state for crash recovery (`.flightpath/.queue/<workflow>-<timestamp>.flightpath.json`)
- 🔜 **Single schema**: Working files use same schema as user-created files, with optional `_runtime` object for execution state
- 🔜 **MCP-compatible backend**: Position control (`"next" | "end"`) built-in from day one

## Implementation Status

**Phase 1: Core Queue Append** - ✅ **COMPLETE** (~1 hour implementation)

All MVP requirements implemented:

- ✅ `PromptQueue.appendPrompts()` method
- ✅ `PromptQueue.canAppend()` validation
- ✅ `PromptQueue.isCompleted()` helper
- ✅ `FlightPathManager.appendFromFile()` orchestration
- ✅ Command registration: `flightpath.queueFromContext`
- ✅ Context menu entries (Explorer, Editor Title, Editor Title Context)
- ✅ Auto-execution for completed queues
- ✅ Queue size limit enforcement
- ✅ User notifications
- ✅ Documentation (README.md, QUICK_START.md)

**Files Modified:**

1. `src/flightpath/PromptQueue.ts` - Added 3 new public methods (65 lines)
2. `package.json` - Added command and 3 context menu entries (30 lines)
3. `src/types/DashboardConstants.ts` - Added message type constant (1 line)
4. `src/flightpath/FlightPathManager.ts` - Added appendFromFile method (90 lines)
5. `src/extension.ts` - Registered new command (10 lines)
6. `README.md` - Added feature to features list
7. `QUICK_START.md` - Added Queue Append tutorial section

**Total New Code:** ~200 lines (excluding documentation)

## Bugs Fixed

### Bug 1: Queue Restart Loses History

**Problem**: Appending to completed queue would restart from beginning, losing all history.

**Root Cause**: `executeLoadedPromptFile()` always called `restart()` for completed queues.

**Fix**: Added `continueFromCurrent: boolean` parameter to skip restart in append mode.

```typescript
async executeLoadedPromptFile(
  modeOverride?: Provider,
  continueFromCurrent: boolean = false
): Promise<void>
```

**Behavior Now:**

- Normal execution: `continueFromCurrent = false` → restarts completed/paused queues
- Append mode: `continueFromCurrent = true` → preserves position and history

### Bug 2: Dashboard Clears Output

**Problem**: Dashboard cleared all output when appending to completed queue.

**Root Cause 1**: `loadPromptFile()` sends `FILE_SELECTED` message which clears dashboard state.

**Fix 1**: Set `currentPromptFile` directly instead of calling `loadPromptFile()`:

```typescript
// Store the loaded file without calling loadPromptFile (which clears dashboard)
this.currentPromptFile = { filePath, promptFile: parsed };
// Set up file watcher for live reload
this.setupPromptFileWatcher(filePath);
```

**Root Cause 2**: `EXECUTION_STARTED` message resets `currentStep = 0` and clears outputs.

**Fix 2**: Send `PROGRESS_UPDATE` instead when continuing from append:

```typescript
if (!continueFromCurrent) {
  // Fresh start - send EXECUTION_STARTED message
  this.dashboardProvider.updateExecutionStarted(fileName, totalPrompts);
} else {
  // Continuing from append - just update progress, don't reset state
  const currentIndex = currentQueueState.currentIndex;
  this.dashboardProvider.updateProgress(currentIndex, totalPrompts);
}
```

**Behavior Now:**

- Dashboard preserves all previous prompts, statuses, and CLI outputs
- Step counter shows correct values (e.g., "1 of 2" when starting appended prompt)
- No output clearing on append

## How to Use

### Via Context Menu (Recommended)

1. Start a workflow (or wait for one to complete)
2. Right-click on another prompt file in Explorer
3. Select "Queue with FlightPath"
4. Prompts are appended and execute automatically

### Via Editor Title Button

1. Open a prompt file (`.prompt.md`, `.flightpath.yaml`, `.flightpath.json`)
2. Click the "Queue" icon (➕) in the editor title bar
3. Prompts are appended to active workflow

**Working File as Source of Truth**:

- ✅ Queue state persisted to `.flightpath/.queue/<workflow>-<timestamp>.flightpath.json` on every change
- ✅ Crash recovery: Resume workflows after VS Code restarts (can run working file directly)
- ✅ Same schema as user-created files, extended with optional `_runtime` object for execution state
- ✅ Same file used by both user actions (Queue Append) and AI actions (MCP)
- ✅ Atomic writes (temp file + rename) prevent corruption

**Unexpanded Prompts Explained**:

- **Unexpanded**: Raw prompt text from `.flightpath.json` file (no `<attachment>` XML blocks)
- **Expanded**: Prompt with `<attachment>` XML added by `processPromptAttachments()` before sending to AI
- **Working file stores**: Unexpanded prompts only (cleaner, smaller file size)
- **Runtime expansion**: Attachments added dynamically when prompts are executed

**MCP Compatibility** (Key Design Decision):

- ✅ `PromptQueue.appendPrompts(prompts, position)` supports both "next" and "end" positions
- ✅ Same backend used by user commands AND future MCP `flightpath_append_queue` tool
- ✅ MVP only exposes "end" position via UI, but backend ready for MCP "next" position
- ✅ Zero refactoring needed when MCP is implemented later

**Future Enhancements**:

- Visual segmentation of appended prompt groups
- Additional commands for queueing text input
- Queue Next feature (insert after current position)
- Working file system for crash recovery
- Advanced append analytics

## Current Behavior

### Queue State Transitions

| Initial State              | Action        | Result                                          |
| -------------------------- | ------------- | ----------------------------------------------- |
| **Empty/Idle (0 prompts)** | Queue prompts | **Loads and starts workflow (like Run)**        |
| Running                    | Queue prompts | Appended, execution continues                   |
| Completed                  | Queue prompts | Appended, execution resumes (preserves history) |
| Idle (has prompts)         | Queue prompts | Appended, execution starts                      |
| Paused                     | Queue prompts | Appended, remains paused                        |
| Cancelling                 | Queue prompts | ❌ Error: "Cannot append..."                    |
| Error                      | Queue prompts | ❌ Error: "Cannot append..."                    |

### Queue Size Limits

Respects existing Dynamic Queue settings:

| Scenario                                   | Behavior                                   |
| ------------------------------------------ | ------------------------------------------ |
| Current: 3, New: 2, Max: 100               | ✅ Appended (total: 5)                     |
| Current: 99, New: 2, Max: 100              | ❌ Warning: "Queue size limit exceeded..." |
| Current: 50, New: 100, unlimitedMode: true | ✅ Appended (total: 150)                   |

**Settings Used** (no new settings required):

- `flightpath.maxQueueSize` (default: 100)
- `flightpath.maxExecutionTime` (default: 18000s = 5 hours)
- `flightpath.unlimitedMode` (default: false)

## Next Steps

**Immediate (Phase 2):**

- 🔜 Manual testing across all scenarios
- 🔜 User feedback on UX and behavior
- 🔜 Consider visual segmentation if requested

**Future Phases (from original plan):**

- Phase 3: Settings & polish (status bar append counts)
- Phase 4: Headless CI/CD support
- Phase 5: Queue Next (insert after current position)
- Phase 6-10: Full queue management UI (drag-drop, removal, undo/redo)
- Phase 11: Working file system for crash recovery
- Phase 12: MCP integration (AI-driven queue extension)

---

## Original Planning Documentation

The sections below contain the original MVP planning and future enhancement designs. Implementation details above reflect what was actually built.

## Business Context

**Use Cases**:

1. **Sequential Workflows**: Run workflow A, then automatically queue workflow B
2. **Follow-up Questions**: After workflow completes, ask follow-up without losing output
3. **Headless CI/Automation**: Send initial prompt, wait for completion, send follow-up, view all output together
4. **Interactive Debugging**: Queue multiple investigation prompts during debugging session

**Key Distinction**: This is user-driven queue extension (external append), not AI-driven (Dynamic Queue feature where AI edits .flightpath.json).

## Current Limitations

**Problem**: Loading a new prompt/workflow always:

1. Clears the dashboard completely
2. Creates a new queue (loses previous queue state)
3. Loses all previous output in headless mode
4. Forces user to track multiple workflow outputs separately

**Current Workarounds**:

- `newChatSessionPerPrompt: false` - Continues same chat session but still clears dashboard
- Dynamic Queue - Only works if AI decides to extend, or if user pauses current workflow, manually edits the flightpath.json file, and then continues the workflow.

## Requirements

### 1. Queue Appending (Core Feature)

**Append Operations**:

- **Single Prompt**: Append raw prompt text to queue
- **Prompt File** (`.prompt.md`, `.flightpath.yaml`): Parse and append prompts
- **Workflow** (`.flightpath.json`): Parse and append all prompts

**Append Modes**:

- **Append to Running Queue**: Add prompts to end of active queue
- **Append to Completed Queue**: If queue is idle/completed, append and start immediately
- **Append to Empty Queue**: If no workflow loaded, treat as "load workflow"

**Dashboard Preservation**:

- ✅ Keep all existing output visible
- ✅ Show clear separation between original and appended prompts
- ✅ Preserve scroll position (or scroll to new prompts)
- ✅ Show visual indicator of append operation

### 2. User Interface (MVP)

**Commands**:

- `flightpath.queueFromContext` - Append prompt/workflow file to current queue

**Context Menu**:

- Right-click on `.prompt.md`, `.flightpath.yaml`, `.flightpath.json`
- New option: "**Queue with FlightPath**" (existing: "Run with FlightPath")
- Shows notification: "Queued {count} prompts to active workflow"

**Editor Title Bar**:

- Add "Queue" icon button next to existing "Run" button
- Only visible when workflow file is open

**Status Bar**:

- Update existing status to show: "FlightPath: Running (3/8)" when prompts appended
- No new UI elements needed

### 3. Queue Management

**Queue State Extensions (MVP)**:

```typescript
interface QueueState {
  // ... existing fields
  // No new fields needed for MVP - just append to existing prompts array
}

// AppendSegment tracks each queue append operation for audit and visual separation
interface AppendSegment {
  id: string; // Unique segment identifier (UUID)
  timestamp: number; // When the append occurred (ms since epoch)
  source: string; // "user-command" | "mcp-tool" | "copilot-cli" | "claude-cli" | "codex-cli"
  reason?: string; // Optional explanation for the append
  position: "next" | "end"; // Where prompts were inserted
  promptIndices: number[]; // Which prompts in the queue belong to this segment
}
```

**PromptQueue Methods**:

```typescript
class PromptQueue {
  // New public methods
  appendPrompts(prompts: PromptItem[]): void;
  canAppend(): boolean; // Check if append is allowed

  // Future: Add segment tracking for visual separation
}
```

**Append Logic (MVP - MCP Compatible with Concurrency Control)**:

```typescript
class PromptQueue {
  private operationQueue: Promise<void> = Promise.resolve();
  private operationLock = false;

  /**
   * Append prompts to queue (thread-safe, queues operations)
   * Multiple simultaneous calls are serialized automatically
   */
  async appendPrompts(
    newPrompts: PromptItem[],
    position: "next" | "end" = "end",
    source: string = "user"
  ): Promise<void> {
    // Queue this operation to prevent race conditions
    return this.queueOperation(async () => {
      await this.appendPromptsInternal(newPrompts, position, source);
    });
  }

  /**
   * Internal implementation (called by queued operation)
   */
  private async appendPromptsInternal(
    newPrompts: PromptItem[],
    position: "next" | "end",
    source: string
  ): Promise<void> {
    // 1. Validate state (can append?)
    if (!this.canAppend()) {
      throw new Error("Cannot append: Queue is in invalid state");
    }

    // 2. Read current working file state (fresh read for concurrency)
    const currentState = await this.workingFileManager.readWorkingFile();

    // 3. Calculate insert index based on position
    const insertIndex =
      position === "next"
        ? currentState.currentIndex + 1 // Insert after current
        : currentState.prompts.length; // Append to end (default)

    // 4. Insert prompts at calculated position
    currentState.prompts.splice(insertIndex, 0, ...newPrompts);

    // 5. Track segment metadata
    const segment: AppendSegment = {
      segmentId: generateId(),
      appendedAt: new Date(),
      startIndex: insertIndex,
      endIndex: insertIndex + newPrompts.length - 1,
      source,
      sourceType: "prompt",
      insertionType: position,
    };
    currentState.appendSegments.push(segment);

    // 6. Write back atomically (temp + rename)
    await this.workingFileManager.writeWorkingFile(currentState);

    // 7. Update in-memory state (after successful write)
    this.state = currentState;

    // 8. If queue is completed/idle, restart execution
    if (this.isCompleted()) {
      await this.resume();
    }

    // 9. Emit state change
    this.emitStateChange();
  }

  /**
   * Queue an operation to prevent concurrent file writes
   * All append/modify operations go through this
   */
  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    // Chain operation after previous operation completes
    const previousOperation = this.operationQueue;

    // Create new promise for this operation
    let resolveOperation: (value: T) => void;
    let rejectOperation: (error: any) => void;

    const operationPromise = new Promise<T>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });

    // Queue this operation
    this.operationQueue = previousOperation
      .then(async () => {
        try {
          const result = await operation();
          resolveOperation!(result);
        } catch (err) {
          rejectOperation!(err);
        }
      })
      .catch(() => {
        // Ignore errors from previous operations
        // (already handled by their own promise)
      });

    return operationPromise;
  }
}
```

**Concurrency Guarantees**:

- ✅ **Serialized operations**: Multiple `appendPrompts()` calls execute sequentially
- ✅ **Atomic file writes**: Temp file + rename ensures no corruption
- ✅ **Fresh reads**: Each operation reads current file state before modifying
- ✅ **Order preserved**: Operations execute in call order (FIFO queue)
- ✅ **Error isolation**: One operation's error doesn't block subsequent operations
- ✅ **No lost updates**: All appends are guaranteed to persist

### 4. Execution Behavior

**When Queue is Running**:

1. Append prompts to end of queue
2. Continue current execution (no interruption)
3. New prompts execute when reached
4. Show notification: "Queued {count} prompts"

**When Queue is Completed**:

1. Append prompts to completed queue
2. **Automatically start execution** (no manual restart needed)
3. Dashboard shows continuous output (no clear)
4. Show notification: "Queued {count} prompts - Executing now"

**When Queue is Paused**:

1. Append prompts to end of queue
2. Remain paused (user resumes manually)
3. New prompts will execute after resume
4. Show notification: "Queued {count} prompts (paused)"

**When Queue is Idle** (no workflow loaded):

1. Treat as "load workflow" (initialize new queue)
2. Start execution immediately
3. Dashboard shows new workflow
4. Show notification: "Started workflow with {count} prompts"

### 5. Dashboard Changes (MVP - Minimal)

**No Visual Changes Required**:

- Appended prompts appear as regular steps in the existing queue
- Step counter automatically updates: "Step 4/8" (was "3/5")
- No special visual segmentation in MVP
- Dashboard continues to work exactly as it does now

**Future Enhancement**: Visual segmentation with segment headers can be added later

**Message Types** (add to `DashboardConstants.ts`):

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  PROMPTS_APPENDED: "promptsAppended",
} as const;
```

### 6. Safety & Validation

**Append Restrictions**:

- ✅ Can append when: Running, Paused, Completed, Idle
- ❌ Cannot append when: Cancelling, Error (must clear first)

**Queue Size Limits** (reuse Dynamic Queue settings):

- Respect `maxQueueSize` setting (default: 100)
- Check: `currentSize + newPrompts.length <= maxQueueSize`
- Show warning if limit reached: "Queue limit reached ({currentSize}/{maxSize})"

**Execution Time Limits** (reuse Dynamic Queue tracking):

- Appending does NOT reset execution timer
- New prompts count toward existing `maxExecutionTime` limit
- Show remaining time: "Time remaining: {remaining}s of {maxTime}s"

**Unlimited Mode**:

- Respect `unlimitedMode` setting (bypass size/time limits)

**Edge Cases**:
| Scenario | Behavior |
|----------|----------|
| Append duplicate prompts | Allow (no deduplication, user intent) |
| Append while retrying | Allow (queue to end) |
| Append with end conditions | Support (each prompt can have endCondition) |
| Append with different models | Support (each prompt can override model) |
| Append to cancelled queue | Reject (must clear first) |
| Append to errored queue | Reject (must clear first) |

### 7. API Design (MVP)

**FlightPathManager Methods**:

```typescript
class FlightPathManager {
  // New public method
  async appendFromFile(
    filePath: string,
    position: "next" | "end" = "end" // Future: expose via command parameter
  ): Promise<void> {
    // 1. Parse file (same as loadPrompt - reuse PromptFileParser)
    const parsed = await this.promptParser.parseFile(filePath);

    // 2. Validate queue state
    if (!this.queue.canAppend()) {
      throw new Error("Cannot append to queue in current state");
    }

    // 3. Append prompts with position control
    await this.queue.appendPrompts(parsed.prompts, position);

    // 4. Show notification
    vscode.window.showInformationMessage(
      `Queued ${parsed.prompts.length} prompts to active workflow`
    );
  }
}
```

**Command Handlers**:

```typescript
// Command: flightpath.queueFromContext
async function queueFromContextCommand(uri: vscode.Uri) {
  await manager.appendFromFile(uri.fsPath);
}
```

**MCP Integration Point**:

MCP tools will call `PromptQueue.appendPrompts()` with position control:

```typescript
// MCP tool handler (matches flightpath_append_queue tool signature)
async function handleMcpAppendQueue(args: {
  prompts: PromptItem[];
  position: "next" | "end"; // Insert after current or append to end
  source: string; // e.g., "copilot-cli", "claude-cli", "codex-cli"
  reason?: string; // Optional explanation for the append
}) {
  const queue = flightPathManager.getQueue();
  if (!queue) {
    throw new Error("No active workflow queue");
  }

  // Use the same backend as user-driven queue append
  await queue.appendPrompts(args.prompts, args.position, {
    source: args.source,
    reason: args.reason || "MCP tool invocation",
  });

  return {
    success: true,
    promptsAdded: args.prompts.length,
    newQueueSize: queue.getState().prompts.length,
  };
}
```

### 8. MCP Compatibility

**Design Alignment**: This user-driven queue append feature shares the same backend logic with MCP-driven queue extension:

**Shared Implementation**:

- `PromptQueue.appendPrompts()` - Core append logic used by both user commands and MCP tools
- `PromptQueue.canAppend()` - State validation used by both
- **Operation queue** - Serializes concurrent append calls (no race conditions)
- **Working file system** - `.flightpath/.queue/<workflow>.flightpath.json` is THE source of truth
- **Atomic writes** - Temp file + rename prevents corruption
- Same safety limits: `maxQueueSize`, `maxExecutionTime`, `unlimitedMode`

**User-Driven Flow** (this feature):

```
User → Context Menu → flightpath.queueFromContext → FlightPathManager.appendFromFile() →
  PromptQueue.appendPrompts() → Update working file (.flightpath.json + _runtime) → Dashboard reloads
```

**MCP-Driven Flow** (future):

````
AI Agent → MCP Tool → flightpath_append_queue → Read working file (.flightpath.json) →
  Modify prompts array → Update _runtime.completedPrompts → Write working file → FlightPath detects change → Queue reloads
```json
{
  "originalFile": "c:/dev/project/bugfix.flightpath.json",
  "prompts": [
    { "prompt": "Analyze auth module" },
    { "prompt": "Fix OAuth bug" },
    { "prompt": "Write tests" }
  ],
  "_runtime": {
    "startTime": 1703185200000,
    "currentIndex": 2,
    "completedPrompts": [0, 1],
    "state": "running"
  },
  "appendSegments": []
}
````

**Why Working Files?**

- ✅ **Crash recovery**: Resume after VS Code restarts (working files are valid `.flightpath.json`)
- ✅ **Single schema**: No separate format to maintain (just add optional `_runtime` object)
- ✅ **Single source of truth**: Both user and AI modify same file
- ✅ **No race conditions**: Atomic file writes
- ✅ **Debuggable**: Users can inspect queue state and run working files directly
- ✅ **MCP-compatible**: AI can read current state, append, and write back

**Future Enhancement**: Add MCP tool `flightpath_append_queue` that wraps `PromptQueue.appendPrompts()` with JSON-RPC interface.

### 9. Settings (MVP)

**No New Settings Required** - Reuse existing Dynamic Queue settings:

**No New Settings Required** - Reuse existing Dynamic Queue settings:

- `maxQueueSize` - Maximum total queue size (includes appended prompts)
- `maxExecutionTime` - Total execution time limit (not reset on append)
- `unlimitedMode` - Bypass size/time limits
- `enableDynamicQueue` - Independent feature (both can be enabled simultaneously)

**Behavior**: Appended prompts automatically execute when queue is completed. No configuration needed.

### 10. Headless CI Mode Support

**Critical Requirements**:

- ✅ Preserve all output across appends
- ✅ No dashboard clearing
- ✅ Sequential execution guaranteed
- ✅ Exit codes reflect final state

**Example CI Workflow**:

```bash
# Initial workflow
flightpath run initial-analysis.flightpath.json

# (Wait for completion or use --wait flag)

# Follow-up question (appends to queue)
flightpath queue "Analyze the test coverage report"

# Another follow-up
flightpath queue followup-review.prompt.md

# View combined output
flightpath output
```

**Implementation Notes**:

- CLI integration needs `queue` subcommand
- Output should be continuous (no breaks between segments)
- Support `--wait` flag to block until completion
- Support `--no-autostart` to queue without executing

### 10. Implementation Phases

#### Phase 1: Core Queue Append (4-5 hours)

**Files to Modify**:

- `src/types/FlightPathTypes.ts` - Add AppendSegment types
- `src/flightpath/PromptQueue.ts` - Add append methods
- `src/flightpath/FlightPathManager.ts` - Add append orchestration
- `package.json` - Register new commands

**Tasks**:

1. Extend QueueState with append tracking
2. Implement `appendPrompts()` in PromptQueue
3. Add validation logic (can append, size limits)
4. Implement auto-execution for completed queues
5. Add command handlers (queuePrompt, queuePromptFile, queueWorkflow)
6. Register context menu entries ("Queue with FlightPath")
7. Add notifications for append operations

**Testing**:

- Append to running queue (verify no interruption)
- Append to completed queue (verify auto-execution)
- Append to paused queue (verify stays paused)
- Append to idle queue (verify treats as load)
- Test size limit enforcement
- **Concurrency test**: Call appendPrompts() 10 times rapidly, verify all 10 operations complete and all prompts appear in queue
- **Race condition test**: Simulate user append + AI append simultaneously, verify no lost updates

#### Phase 2: Dashboard Integration (3-4 hours)

**Files to Modify**:

- `src/types/DashboardConstants.ts` - Add message types
- `src/ui/FlightPathDashboardProvider.ts` - Handle append messages
- `src/ui/webview/dashboard.html` - Add segment UI
- `src/ui/webview/dashboard.css` - Style separators
- `src/ui/webview/dashboard.js` - Render segments

**Tasks**:

1. Add append segment message types
2. Implement segment rendering with visual separators
3. Add queue stats with append counts
4. Update step rendering to show segment membership
5. Add "Queue Prompt" and "Queue Workflow" buttons
6. Preserve dashboard output across appends
7. Add segment headers with timestamps

**Testing**:

- Visual segmentation appears correctly
- Dashboard doesn't clear on append
- Buttons work as expected
- Stats update correctly

#### Phase 3: Settings & Polish (2-3 hours)

**Files to Modify**:

- `package.json` - Add settings
- `src/utils/ConfigurationUtils.ts` - Add getters
- Status bar updates
- Documentation

**Tasks**:

1. Add settings (autoExecuteAppendedPrompts, showAppendSegments, notifyOnQueue)
2. Implement setting-aware behavior
3. Update status bar to show append counts
4. Add comprehensive error messages
5. Write user documentation
6. Update copilot-instructions.md

**Testing**:

- Settings affect behavior correctly
- Status bar shows accurate state
- Error messages are clear

#### Phase 4: Headless/CLI Support (Future)

**Files to Create**:

- CLI integration for queue commands

**Tasks**:

1. Add `flightpath queue <prompt>` CLI command
2. Add `flightpath queue --file <path>` CLI command
3. Support `--wait` flag for blocking behavior
4. Ensure output continuity in headless mode
5. Document CI/CD usage patterns

## Architecture Decisions

### 1. Dynamic Queue vs Queue Append Conflict Resolution

**Problem**: The two features can conflict when both are enabled:

**Conflict Scenario**:

```
1. Queue: [1✓, 2✓, 3⏳ (running), 4⏸, 5⏸]
2. User calls queueNext("fix authentication bug")
   → Queue: [1✓, 2✓, 3⏳, 4NEW⏸, 5⏸, 6⏸]
3. While prompt 3 runs, AI (Dynamic Queue) edits .flightpath.json
   → Adds 10 new prompts to file
4. FlightPath reloads file:
   → File has: [1, 2, 3, 4, 5, ...10 AI-added prompts]
   → Memory has: [1✓, 2✓, 3⏳, 4NEW⏸, 5⏸, 6⏸]

❌ CONFLICT: File doesn't know about user-queued prompt 4NEW
   How do we merge without losing user's queued prompt?
```

**Solution Options Evaluated**:

#### Option 1: API-Based Dynamic Queue (Language Model Tools) ⭐ **RECOMMENDED**

**Decision**: **Unify both features through queue management APIs**

AI and users call the same queue management methods instead of AI editing files.

**Implementation**:

```typescript
// Expose Language Model Tools for AI to call
class FlightPathLanguageModelTool {
  async queueNext(prompts: PromptItem[], source: string): Promise<void>;
  async queueAtEnd(prompts: PromptItem[], source: string): Promise<void>;
  async queueWorkflow(
    filePath: string,
    position: "next" | "end"
  ): Promise<void>;
}
```

**How AI Extends Queue**:

```xml
<criticalInstruction>
You can extend the workflow using FlightPath's queue management tools:

AVAILABLE TOOLS:
- queueNext(prompts, source) - Insert prompts after current position
- queueAtEnd(prompts, source) - Append prompts to end of queue
- queueWorkflow(filePath, position) - Load and queue external workflow

EXAMPLE - Add testing tasks:
Tool: queueNext
Arguments: {
  "prompts": [
    {"prompt": "Write unit tests for authentication"},
    {"prompt": "Write integration tests for OAuth flow"}
  ],
  "source": "AI-generated testing tasks"
}

Queue state: {current}/{total} prompts
Max queue size: {maxSize}
</criticalInstruction>
```

**Advantages**:

- ✅ **Single source of truth**: In-memory queue is authoritative
- ✅ **No file conflicts**: All modifications go through atomic APIs
- ✅ **Consistent APIs**: User and AI use same code paths
- ✅ **Simpler logic**: No complex file merge algorithms
- ✅ **Better control**: API can enforce limits, validate, track sources
- ✅ **Atomic operations**: No race conditions from file I/O
- ✅ **Extensible**: Easy to add new operations (queueBefore, removeFromQueue)

**Disadvantages**:

- ⚠️ **CLI mode limitation**: Language Model Tools only work in Chat mode
  - Solution: For CLI mode, use file-based mechanism (Option 3 below)
- ⚠️ **Migration required**: Changes Dynamic Queue implementation
- ⚠️ **Tool discovery**: AI needs to understand available tools

**Chat Mode Implementation**:

```typescript
// Register Language Model Tool
vscode.lm.registerTool(
  "flightpath-queue-next",
  {
    name: "flightpath-queue-next",
    description:
      "Insert prompts immediately after current position in FlightPath queue",
    inputSchema: {
      type: "object",
      properties: {
        prompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              model: { type: "string" },
              endCondition: { type: "object" },
            },
          },
        },
        source: { type: "string" },
      },
    },
  },
  async (input) => {
    await manager.appendPromptsToQueue(
      input.prompts,
      input.source,
      "prompt",
      "next"
    );
    return { success: true, queueSize: queue.getState().prompts.length };
  }
);
```

**CLI Mode Alternative** (File-based with sync):

```typescript
// Before sending prompt with allowDynamicExtension in CLI mode:
async function preparePromptForCliDynamicExtension(prompt: PromptItem) {
  // 1. Write current queue state to temp working file
  const workingFile = await syncQueueToWorkingFile();

  // 2. Update instructions to reference working file
  const instructions = buildDynamicQueueInstructions(workingFile);

  // 3. After prompt completes, reload working file (includes all changes)
  await reloadQueueFromWorkingFile(workingFile);
}
```

---

#### Option 2: Smart Merge Algorithm (Complex)

Keep file-based Dynamic Queue but make reload smart enough to preserve in-memory changes.

**Implementation**:

```typescript
interface AppendSegment {
  // ... existing fields
  source: "file" | "memory"; // Track origin
  preserveOnReload: boolean; // Keep in-memory segments during file reload
}

async function reloadAndMergeQueue(filePath: string): Promise<number> {
  // 1. Load new file contents
  const filePrompts = await parser.parse(filePath);

  // 2. Identify in-memory-only segments (user queued)
  const memorySegments = this.state.appendSegments.filter(
    (s) => s.source === "memory"
  );

  // 3. Merge: file prompts + preserved memory segments
  //    Challenge: Where do memory segments go relative to new file prompts?
  const merged = complexMergeAlgorithm(filePrompts, memorySegments);

  // 4. Update queue
  this.state.prompts = merged;
}
```

**Disadvantages**:

- ❌ **Complex merge logic**: Hard to determine correct insertion points
- ❌ **Ambiguous semantics**: Where should "queueNext" prompt go after file adds 10 prompts?
- ❌ **Race conditions**: File edits can happen anytime
- ❌ **Hard to reason about**: Two sources of truth (file + memory)
- ❌ **Testing nightmare**: Many edge cases to cover

**Verdict**: ❌ **Too complex, avoid**

---

#### Option 3: Sync-Before-Extend (Hybrid Approach)

Write in-memory changes back to file before AI can extend the queue.

**Implementation**:

```typescript
async function syncQueueToWorkingFile(): Promise<string> {
  // 1. Create working copy of workflow file
  const workingFile = path.join(
    tmpDir,
    `${workflowName}-working.flightpath.json`
  );

  // 2. Serialize complete queue state (including user-queued prompts)
  const queueSnapshot = {
    prompts: this.state.prompts.map(serializePrompt),
  };

  // 3. Write to working file
  await fs.writeFile(workingFile, JSON.stringify(queueSnapshot, null, 2));

  return workingFile;
}

async function prepareForDynamicExtension(prompt: PromptItem) {
  if (shouldInjectExtensionInstructions(prompt)) {
    // Sync memory state to file before AI can edit
    const workingFile = await syncQueueToWorkingFile();

    // Update instructions to reference working file
    prompt._workingFile = workingFile;
  }
}
```

**Advantages**:

- ✅ **Works in CLI mode**: AI edits files (natural interface)
- ✅ **Simple reload**: File is authoritative after sync
- ✅ **No complex merge**: Memory → File → Reload
- ✅ **Preserves user intent**: All queued prompts included in file

**Disadvantages**:

- ⚠️ **File I/O overhead**: Write before every dynamic prompt
- ⚠️ **Temp file management**: Need to clean up working files
- ⚠️ **Not truly in-memory**: User queuing triggers persistence

**Verdict**: ✅ **Good fallback for CLI mode**

---

### Final Decision: Unified Working File Approach ⭐

**Single Mechanism for Both CLI and Chat**: Use working temp file as single source of truth

**Core Concept**:

1. When workflow starts, create working file: `.flightpath/.queue/{workflowName}-{timestamp}.queue.json`
2. User calls `queueNext` → Updates working file → Triggers queue reload
3. AI with Dynamic Queue enabled → Updates working file → Triggers queue reload
4. All queue modifications go through working file (single code path)
5. Working file persists across sessions (crash recovery!)

**Implementation**:

```typescript
interface WorkingQueueFile {
  originalFile: string; // Path to original .flightpath.json
  workflowName: string; // Name of workflow
  sessionId: string; // Unique session ID
  startTime: Date; // When workflow started
  prompts: PromptItem[]; // Current queue state
  completed: number[]; // Indices of completed prompts
  currentIndex: number; // Current execution position
  appendSegments: AppendSegment[]; // Track all append operations
}

class QueueWorkingFileManager {
  private workingFilePath: string | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;

  /**
   * Initialize working file when workflow starts
   */
  async initializeWorkingFile(
    originalFile: string,
    initialPrompts: PromptItem[]
  ): Promise<string> {
    // Create working file path
    const workflowName = path.basename(originalFile, ".flightpath.json");
    const timestamp = Date.now();
    const sessionId = generateSessionId();

    this.workingFilePath = path.join(
      workspaceRoot,
      ".flightpath",
      ".queue",
      `${workflowName}-${timestamp}.queue.json`
    );

    // Write initial state
    const workingState: WorkingQueueFile = {
      originalFile,
      workflowName,
      sessionId,
      startTime: new Date(),
      prompts: initialPrompts,
      completed: [],
      currentIndex: 0,
      appendSegments: [],
    };

    await fs.writeFile(
      this.workingFilePath,
      JSON.stringify(workingState, null, 2)
    );

    // Start watching for changes
    this.startWatching();

    return this.workingFilePath;
  }

  /**
   * Read working file (fresh read for concurrency safety)
   */
  async readWorkingFile(): Promise<WorkingQueueFile> {
    if (!this.workingFilePath) {
      throw new Error("Working file not initialized");
    }

    const content = await fs.promises.readFile(this.workingFilePath, "utf8");
    return JSON.parse(content) as WorkingQueueFile;
  }

  /**
   * Write working file atomically (temp + rename)
   * Prevents corruption from concurrent writes
   */
  async writeWorkingFile(state: WorkingQueueFile): Promise<void> {
    if (!this.workingFilePath) {
      throw new Error("Working file not initialized");
    }

    // Write to temp file first
    const tempPath = `${this.workingFilePath}.tmp`;
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(state, null, 2),
      "utf8"
    );

    // Atomic rename (overwrites existing file)
    await fs.promises.rename(tempPath, this.workingFilePath);

    // File watcher will trigger queue reload
  }

  /**
   * Update current execution position
   */
  async updateProgress(
    currentIndex: number,
    completed: number[]
  ): Promise<void> {
    if (!this.workingFilePath) return;

    const state = await this.readWorkingFile();
    state.currentIndex = currentIndex;
    state.completed = completed;

    await fs.writeFile(this.workingFilePath, JSON.stringify(state, null, 2));
  }

  /**
   * Watch for external changes (AI edits during Dynamic Queue)
   */
  private startWatching(): void {
    if (!this.workingFilePath) return;

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      this.workingFilePath
    );

    this.fileWatcher.onDidChange(async () => {
      // File changed externally (AI edited it)
      // Trigger queue reload in FlightPathManager
      await this.onWorkingFileChanged();
    });
  }

  /**
   * Cleanup working file after workflow completes
   */
  async cleanup(keepFile: boolean = false): Promise<void> {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    if (!keepFile && this.workingFilePath) {
      // Optionally delete working file
      // Or keep for crash recovery and later cleanup
      await fs.unlink(this.workingFilePath).catch(() => {});
    }
  }

  /**
   * List recent working files for crash recovery
   */
  static async listRecentWorkingFiles(): Promise<WorkingQueueFile[]> {
    const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");
    const files = await fs.readdir(queueDir);

    const workingFiles = await Promise.all(
      files
        .filter((f) => f.endsWith(".queue.json"))
        .map(async (f) => {
          const content = await fs.readFile(path.join(queueDir, f), "utf8");
          return JSON.parse(content) as WorkingQueueFile;
        })
    );

    // Sort by start time (most recent first)
    return workingFiles.sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }
}
```

**How AI Extends Queue** (Dynamic Queue):

```xml
<criticalInstruction>
You can extend this workflow by editing the working queue file.

QUEUE MANAGEMENT:
- Working file: {workingFilePath}
- Current position: {currentIndex}/{totalPrompts}
- Max queue size: {maxSize}

TO EXTEND QUEUE:
1. Read the working file (it contains the current queue state)
2. Add new prompts to the "prompts" array
   - For "queue next": Insert after index {currentIndex}
   - For "queue at end": Append to end of array
3. Update the "appendSegments" array to track your changes:
   {
     "segmentId": "unique-id",
     "appendedAt": "2025-12-17T...",
     "startIndex": {insertIndex},
     "endIndex": {insertIndex + newPromptsCount - 1},
     "source": "AI: Description of why you added these prompts",
     "sourceType": "prompt",
     "insertionType": "next" or "end"
   }
4. Save the file - FlightPath will detect changes and continue

EXAMPLE - Add testing and documentation tasks:
Read: {workingFilePath}
Current prompts array has 5 items, currentIndex is 2

Insert after current (index 3):
- "Write unit tests for authentication module"
- "Write integration tests for OAuth flow"
- "Add API documentation"

Update appendSegments array with metadata about these 3 new prompts.

FlightPath will automatically reload the queue and execute the new prompts.
</criticalInstruction>
```

**Advantages**:

- ✅ **Unified mechanism**: Both CLI and Chat use same file-based approach
- ✅ **No mode detection**: Works identically in both environments
- ✅ **Crash recovery**: Working file persists across VS Code sessions
- ✅ **Simple merge logic**: File is always authoritative
- ✅ **Atomic operations**: File writes are atomic (no race conditions)
- ✅ **Debuggable**: Users can inspect working file to see queue state
- ✅ **Restorable**: "Resume last workflow" feature comes free
- ✅ **Clean separation**: Working files separate from user's .flightpath.json

**Additional Benefits**:

- **History tracking**: Keep working files for audit trail
- **Multi-workspace**: Each workspace has its own `.flightpath/.queue/` directory
- **Garbage collection**: Clean up old working files after N days
- **Testing**: Easy to test by directly manipulating working files

**User Experience**:

**Starting Workflow**:

```
FlightPath: Starting workflow 'bugfix.flightpath.json'
           Working file: .flightpath/.queue/bugfix-1734480000.queue.json
```

**User Queues Next**:

```
User: Runs command "Queue Next" with prompt "fix authentication"
FlightPath: Updated working file (+ 1 prompt)
           Queue: 3/6 prompts (+ 1 queued)
```

**AI Extends (Dynamic Queue)**:

```
AI: Edits .flightpath/.queue/bugfix-1734480000.queue.json
    Adds 3 prompts for testing
FlightPath: Working file changed (+ 3 prompts)
           Queue: 3/9 prompts (+ 3 queued by AI)
```

**Crash Recovery**:

```
User: Reopens VS Code after crash
FlightPath: Found incomplete workflow 'bugfix-1734480000.queue.json'
           Resume from prompt 4/9? [Yes] [No] [View]
```

**Migration Path**:

1. **Phase 1-3**: Implement Queue Append with working file system
2. **Phase 4**: Add crash recovery (resume from working file)
3. **Phase 11**: Migrate Dynamic Queue to use working file (deprecate old reload mechanism)
4. **Phase 12**: Add working file garbage collection and management UI

### 2. Append vs Reload

**Decision**: **Append in-memory, don't reload file**

**Rationale**:

- Appending is user-driven (external), not AI-driven (Dynamic Queue)
- No need to persist appended prompts to original file
- Simpler state management (queue is source of truth)
- Allows appending from multiple sources without file conflicts

**Updated Contrast with Dynamic Queue**:
| Feature | Dynamic Queue (File) | Dynamic Queue (API) | Queue Append |
|---------|----------------------|---------------------|--------------|
| Trigger | AI edits .flightpath.json | AI calls tools | User calls command |
| Persistence | Saved to file | In-memory | In-memory |
| Source tracking | File change detection | API call logs | AppendSegment metadata |
| Execution | Automatic (on file change) | Immediate | Immediate or on completion |
| Mode support | CLI only | Chat only | Both |

### 3. Auto-Execution

**Decision**: **Auto-execute by default when queue completed**

**Rationale**:

- Natural UX for follow-up questions ("just send it")
- Critical for headless CI mode (no manual intervention)
- Can be disabled via `autoExecuteAppendedPrompts` setting

**Alternative**: Always require manual start (rejected - too much friction)

### 4. Dashboard Preservation

**Decision**: **Never clear dashboard on append**

**Rationale**:

- Core requirement: preserve output history
- Enables continuous workflow tracking
- Essential for debugging and review

**Implementation**: Add clear "segment boundaries" to show append points

### 5. Queue Size Limits

**Decision**: **Reuse Dynamic Queue limits (maxQueueSize, unlimitedMode)**

**Rationale**:

- Consistent UX across features
- Same safety concerns (infinite loops)
- Settings already exist

**Note**: Execution time limit continues across appends (not reset)

## Related Features

**Dynamic Queue** (`enableDynamicQueue`) - **UNIFIED with Queue Append**:

- AI-driven: AI edits working queue file during execution
- File-persisted: Changes saved to working file (not original .flightpath.json)
- Automatic reload: File watcher detects changes
- **Uses same mechanism as Queue Append**

**Queue Append** (this feature):

- User-driven: User calls commands to append prompts
- File-persisted: Updates working queue file
- Immediate execution: File watcher triggers reload
- **Uses same mechanism as Dynamic Queue**

**Unified Architecture**: Both features edit the same working file (`.flightpath/.queue/{workflow}-{timestamp}.queue.json`), eliminating conflicts and simplifying implementation. No separate mechanisms for CLI vs Chat mode.

## Open Questions

1. **CLI Integration**: Should we implement CLI queue commands in Phase 1 or defer?
   - **Recommendation**: Defer to Phase 4, focus on VS Code UX first

2. **Append History**: Should we persist append history across sessions?
   - **Recommendation**: No - queue is ephemeral, output is in dashboard

3. **Undo Append**: Should we allow removing appended segments?
   - **Recommendation**: Not in v1 - use stop/restart workflow instead

4. **Cross-Workflow Appending**: Allow appending prompts from workflow A to workflow B?
   - **Recommendation**: Yes - queue is global, source is just metadata

5. **Model Overrides**: If appended prompt has different model, how to handle?
   - **Recommendation**: Respect per-prompt model setting (existing behavior)

## Success Metrics

**User Experience**:

- ✅ Zero dashboard clears during append operations
- ✅ Continuous output visible in single view
- ✅ One-click append from context menu
- ✅ Clear visual separation of segments

**Technical**:

- ✅ No execution interruption on append
- ✅ Append operations < 100ms
- ✅ Memory efficient (no duplicate storage)
- ✅ Thread-safe queue modifications

**Headless/CI**:

- ✅ Complete output preservation
- ✅ Sequential execution guaranteed
- ✅ Blocking wait support
- ✅ Clear exit codes

## Documentation Requirements

1. **User Guide**: Add "Queueing Workflows" section to README.md
2. **Examples**: Create example workflows showing append patterns
3. **Settings Reference**: Document new settings in copilot-instructions.md
4. **API Reference**: Document new commands and methods
5. **CI/CD Guide**: Show headless append usage patterns (Phase 4)

## Future Enhancements

### Queue Next / Queue Immediate

**Feature**: Insert prompts immediately after the current prompt instead of at the end.

**Use Case**: User notices an issue during execution and wants to fix it before subsequent prompts run.

**Example**:

```
Queue: [1✓, 2✓, 3✓, 4✓, 5⏳, 6⏸, 7⏸, 8⏸, 9⏸, 10⏸]
                       ^current

User: "Undo that last change, use this utility instead"
Action: Queue Next

Result: [1✓, 2✓, 3✓, 4✓, 5⏳, 6NEW⏸, 7⏸, 8⏸, 9⏸, 10⏸, 11⏸]
                       ^current  ^inserted
```

**Implementation**:

```typescript
// New method in PromptQueue
insertPromptsAfterCurrent(
  prompts: PromptItem[],
  source: string,
  sourceType: string
): AppendSegment {
  const insertIndex = this.state.currentIndex + 1;

  // Insert prompts at position
  this.state.prompts.splice(insertIndex, 0, ...prompts);

  // Insert results at same position
  const newResults = prompts.map(p => ({
    prompt: p.prompt,
    status: STEP_STATUS.PENDING,
    timestamp: new Date(),
    appendSegmentId: segment.segmentId
  }));
  this.state.results.splice(insertIndex, 0, ...newResults);

  // Update all append segments after insertion point
  this.updateSegmentIndicesAfterInsertion(insertIndex, prompts.length);

  // Create segment
  const segment: AppendSegment = {
    segmentId: generateId(),
    appendedAt: new Date(),
    startIndex: insertIndex,
    endIndex: insertIndex + prompts.length - 1,
    source,
    sourceType,
    insertionType: 'next'  // vs 'end' for append
  };

  this.state.appendSegments.push(segment);
  this.emitStateChange();

  return segment;
}
```

**Commands**:

- `flightpath.queueNext` - Insert after current prompt
- `flightpath.queueAtPosition` - Insert at specific position (future)

**Context Menu**:

- "Queue with FlightPath" (append to end)
- "Queue Next in FlightPath" (insert after current) ⬅️ **NEW**

**Dashboard Button**:

- "Queue Prompt ▼" with dropdown:
  - "Queue at End"
  - "Queue Next" (only enabled when running)
  - "Queue at Position..." (future)

### Full Queue Management (Future Vision)

**Goal**: Transform dashboard into a full queue editor with drag-and-drop, removal, and build-before-execute modes.

#### UX Design Principles

**1. Visual Queue Editor**

Dashboard shows interactive queue with:

```
┌─ Prompt Queue Editor ───────────────────────────┐
│ [▶ Start] [⏸ Pause] [⏹ Stop] [+ Add Prompt ▼]  │
├─────────────────────────────────────────────────┤
│ ✓ [☰] 1. Analyze authentication module         │
│ ✓ [☰] 2. Implement OAuth2 flow                 │
│ ✓ [☰] 3. Add unit tests                        │
│ ⏳ [☰] 4. Review security [❌ Edit ⋯]          │  ← Running (can't remove/reorder)
│ ⏸ [☰] 5. Add integration tests [❌ Edit ⋯]    │  ← Pending (fully editable)
│ ⏸ [☰] 6. Update documentation [❌ Edit ⋯]     │  ← Can drag/drop
│   [+ Add Here]                                  │  ← Insert between items
└─────────────────────────────────────────────────┘

Legend:
[☰] = Drag handle
[❌] = Remove button
[Edit] = Edit prompt inline
[⋯] = More actions (move up/down, copy, duplicate)
```

**Features**:

- ✅ Drag handle ([☰]) for reordering
- ✅ Remove button (❌) for each pending prompt
- ✅ Inline editing (click prompt text or "Edit" button)
- ✅ Context menu (right-click): Remove, Move Up, Move Down, Duplicate, Edit
- ✅ "Add Here" buttons between items for precise insertion
- ✅ Status indicators with color coding
- ✅ Locked/unlocked states (completed prompts locked)

**2. Build Mode vs Execute Mode**

Two distinct workflows:

**Build Mode** (queue starts in IDLE state):

1. User adds multiple prompts via "Queue" commands
2. Queue remains in IDLE state (doesn't auto-execute)
3. User can reorder, remove, edit prompts freely
4. When ready, user clicks "▶ Start" to begin execution
5. Use case: Planning complex workflows interactively

**Execute Mode** (queue auto-starts when prompts added):

1. User adds prompt via "Queue" command
2. If queue is completed/idle and `autoExecuteAppendedPrompts: true`, starts immediately
3. Can still modify pending prompts during execution
4. Use case: Sequential follow-up questions

**Implementation**:

```typescript
// New setting
"flightpath.queueAutoStart": {
  "type": "boolean",
  "default": true,
  "description": "Automatically start execution when prompts are queued to an idle/completed queue",
  "markdownDescription": "When enabled (default), queued prompts start executing immediately if the queue is idle or completed. Disable to build up a queue before manually starting execution (Build Mode)."
}
```

**3. Queue Modification Operations**

**Add Operations**:

- `queueAtEnd(prompts, source)` - Append to end (default)
- `queueNext(prompts, source)` - Insert after current
- `queueAtPosition(prompts, position, source)` - Insert at specific index
- `queueBefore(prompts, targetIndex, source)` - Insert before specific prompt

**Remove Operations**:

- `removeFromQueue(index)` - Remove single prompt
- `removeFromQueue(indices)` - Remove multiple prompts
- `clearPendingPrompts()` - Remove all pending prompts

**Reorder Operations**:

- `movePrompt(fromIndex, toIndex)` - Move single prompt
- `swapPrompts(indexA, indexB)` - Swap two prompts
- `reorderQueue(newOrder)` - Reorder entire queue (drag-drop result)

**Edit Operations**:

- `updatePrompt(index, newPrompt)` - Modify prompt text/config
- `duplicatePrompt(index)` - Copy and insert after

**Validation Rules**:

- ✅ Can modify: Pending prompts only (status: PENDING)
- ❌ Cannot modify: Running, completed, failed prompts
- ❌ Cannot insert before: Current running prompt
- ✅ Can remove: Pending prompts (index > currentIndex)
- ✅ Can reorder: Pending prompts only (maintain completed order)

**4. Dashboard Commands**

**Primary Actions** (toolbar buttons):

- "▶ Start" - Begin execution (only visible in IDLE/PAUSED)
- "⏸ Pause" - Pause execution (only visible when RUNNING)
- "⏹ Stop" - Stop and clear queue
- "+ Add Prompt ▼" - Dropdown with position options

**Per-Item Actions** (context menu):

- "Remove" - Delete from queue
- "Edit" - Open inline editor
- "Duplicate" - Copy and insert after
- "Move Up" - Swap with previous pending prompt
- "Move Down" - Swap with next pending prompt
- "Insert Before" - Add new prompt before this one
- "Insert After" - Add new prompt after this one

**Keyboard Shortcuts**:

- `Delete` - Remove selected prompt
- `Ctrl+D` - Duplicate selected prompt
- `Ctrl+↑` - Move up
- `Ctrl+↓` - Move down
- `Enter` - Edit selected prompt
- `Ctrl+Enter` - Insert new prompt after selected

**5. Undo/Redo System**

Track queue modifications with undo stack:

```typescript
interface QueueModification {
  type: "add" | "remove" | "reorder" | "update";
  timestamp: Date;
  before: QueueSnapshot;
  after: QueueSnapshot;
  description: string; // "Added 3 prompts", "Removed prompt 7"
}

class QueueHistory {
  private undoStack: QueueModification[] = [];
  private redoStack: QueueModification[] = [];

  recordModification(modification: QueueModification): void;
  undo(): QueueSnapshot | null;
  redo(): QueueSnapshot | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}
```

**Commands**:

- `flightpath.undoQueueChange` - Undo last modification
- `flightpath.redoQueueChange` - Redo last undone modification

**UI**:

- Toolbar buttons: "↶ Undo" (grayed when empty)
- Toolbar buttons: "↷ Redo" (grayed when empty)
- Tooltip shows last action: "Undo: Removed prompt 5"

**6. Drag-and-Drop Implementation**

**HTML Structure**:

```html
<div class="queue-item" data-index="5" draggable="true">
  <span class="drag-handle">☰</span>
  <span class="status-icon">⏸</span>
  <span class="prompt-text">Add integration tests</span>
  <button class="remove-btn">❌</button>
</div>
```

**Drag Events**:

```javascript
// dashboard.js
let draggedIndex = null;

function handleDragStart(e) {
  draggedIndex = parseInt(e.target.dataset.index);
  e.dataTransfer.effectAllowed = "move";
  e.target.classList.add("dragging");
}

function handleDragOver(e) {
  e.preventDefault(); // Allow drop
  const targetIndex = parseInt(e.target.closest(".queue-item").dataset.index);

  // Can only reorder pending prompts
  if (isPending(draggedIndex) && isPending(targetIndex)) {
    e.dataTransfer.dropEffect = "move";
  } else {
    e.dataTransfer.dropEffect = "none";
  }
}

function handleDrop(e) {
  e.preventDefault();
  const targetIndex = parseInt(e.target.closest(".queue-item").dataset.index);

  if (
    draggedIndex !== null &&
    isPending(draggedIndex) &&
    isPending(targetIndex)
  ) {
    vscode.postMessage({
      type: "movePrompt",
      fromIndex: draggedIndex,
      toIndex: targetIndex,
    });
  }

  draggedIndex = null;
}
```

**Visual Feedback**:

- Dragged item gets `.dragging` class (opacity: 0.5)
- Drop zones highlight with blue border
- Invalid drop zones show red border
- Cursor changes: move cursor (valid), no-drop cursor (invalid)

#### Architecture Considerations

**1. Queue State Integrity**

**Immutable Regions**:

```typescript
interface QueueState {
  // ... existing fields

  // New: Track what's mutable
  firstMutableIndex: number; // First index that can be modified
  // (currentIndex + 1 when running, 0 when idle)

  // New: Track modifications
  modifications: QueueModification[];
  modificationHistory: QueueHistory;
}

function canModifyPrompt(
  index: number,
  operation: "remove" | "reorder" | "edit"
): boolean {
  const prompt = this.state.prompts[index];
  const result = this.state.results[index];

  // Can't modify completed/failed/running prompts
  if (result.status !== STEP_STATUS.PENDING) {
    return false;
  }

  // Can't modify before current execution point
  if (index <= this.state.currentIndex) {
    return false;
  }

  // Reordering requires both positions to be mutable
  if (operation === "reorder" && index < this.state.firstMutableIndex) {
    return false;
  }

  return true;
}
```

**2. Segment Tracking After Modifications**

When prompts are reordered/removed, segment metadata becomes stale:

```typescript
interface AppendSegment {
  // ... existing fields

  // New: Track modifications
  originalStartIndex: number; // Original position when appended
  originalEndIndex: number;
  currentPromptIds: string[]; // Track individual prompts (use hash)

  // New: Modification tracking
  modified: boolean; // Has this segment been reordered/removed from?
  removedPromptIds: string[]; // Prompts removed from this segment
}

function updateSegmentsAfterModification(operation: QueueModification): void {
  // Update all segment indices after removal/insertion
  // Mark segments as modified
  // Track removed prompts
}
```

**3. Dashboard Synchronization**

**Message Types**:

```typescript
// Add to DashboardConstants.ts
export const MESSAGE_TYPES = {
  // ... existing types

  // Queue modification messages
  QUEUE_MODIFIED: "queue_modified",
  PROMPT_REMOVED: "prompt_removed",
  PROMPT_MOVED: "prompt_moved",
  PROMPT_UPDATED: "prompt_updated",
  PROMPT_DUPLICATED: "prompt_duplicated",

  // Undo/redo
  UNDO_AVAILABLE: "undo_available",
  REDO_AVAILABLE: "redo_available",
} as const;
```

**Optimistic Updates**:

```javascript
// dashboard.js
function removePrompt(index) {
  // Optimistic update
  const queueItem = document.querySelector(`[data-index="${index}"]`);
  queueItem.classList.add("removing"); // Fade out animation

  // Send message
  vscode.postMessage({ type: "removePrompt", index });

  // Wait for confirmation or rollback on error
  setTimeout(() => {
    if (!confirmed) {
      queueItem.classList.remove("removing");
      showError("Failed to remove prompt");
    }
  }, 500);
}
```

**4. Performance Considerations**

**Large Queues** (100+ prompts):

- Virtual scrolling for queue list (only render visible items)
- Debounce drag-over events (16ms = 60fps)
- Batch segment updates (don't recalculate on every change)
- Cache mutable/immutable indices

**Implementation**:

```typescript
// Use virtual scrolling library or custom implementation
class VirtualQueueList {
  private visibleRange = { start: 0, end: 20 };
  private itemHeight = 40; // Fixed height for performance

  renderVisibleItems(): void {
    // Only render items in view
    // Update on scroll
  }
}
```

#### Implementation Phases

**Phase 5: Queue Next (2-3 hours)**

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Add `insertPromptsAfterCurrent()`
- `src/flightpath/FlightPathManager.ts` - Add queue next orchestration
- `package.json` - Register `flightpath.queueNext` command

**Tasks**:

1. Implement `insertPromptsAfterCurrent()` with index shifting
2. Add `updateSegmentIndicesAfterInsertion()` helper
3. Add `queueNext` command handler
4. Update context menu with "Queue Next" option
5. Add dropdown to dashboard "Add Prompt" button

**Phase 6: Queue Removal (3-4 hours)**

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Add removal methods
- `src/ui/webview/dashboard.html` - Add remove buttons
- `src/ui/webview/dashboard.js` - Handle removal messages

**Tasks**:

1. Implement `removeFromQueue(index)` with validation
2. Update segment tracking after removal
3. Add "Remove" button to each pending prompt
4. Add context menu "Remove" option
5. Add keyboard shortcut (Delete key)

**Phase 7: Drag-and-Drop Reordering (5-6 hours)**

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Add reorder methods
- `src/ui/webview/dashboard.html` - Add drag handles
- `src/ui/webview/dashboard.css` - Add drag styles
- `src/ui/webview/dashboard.js` - Implement drag-and-drop

**Tasks**:

1. Implement `movePrompt(fromIndex, toIndex)` with validation
2. Add drag handles to queue items
3. Implement drag event handlers
4. Add visual feedback (highlighting, cursors)
5. Restrict dragging to pending prompts only

**Phase 8: Build Mode & Auto-Start (2-3 hours)**

**Files to Modify**:

- `package.json` - Add `queueAutoStart` setting
- `src/flightpath/FlightPathManager.ts` - Implement auto-start logic
- `src/ui/webview/dashboard.html` - Add "Start" button

**Tasks**:

1. Add `queueAutoStart` setting (default: true)
2. Implement conditional auto-start in queue operations
3. Show "Start" button when queue is IDLE with prompts
4. Update documentation for Build Mode

**Phase 9: Undo/Redo System (4-5 hours)**

**Files to Create**:

- `src/flightpath/QueueHistory.ts` - Undo/redo implementation

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Integrate history tracking
- `src/ui/webview/dashboard.html` - Add undo/redo buttons
- `package.json` - Register undo/redo commands

**Tasks**:

1. Create `QueueHistory` class with undo/redo stacks
2. Record modifications in queue operations
3. Implement `undo()` and `redo()` methods
4. Add toolbar buttons with state-aware enabling
5. Add keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z)

**Phase 10: Inline Editing (3-4 hours)**

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Add `updatePrompt()` method
- `src/ui/webview/dashboard.html` - Add inline editor
- `src/ui/webview/dashboard.js` - Handle editing flow

**Tasks**:

1. Implement `updatePrompt(index, newPrompt)` with validation
2. Add "Edit" button to pending prompts
3. Show inline editor (textarea or modal)
4. Save changes and update queue
5. Validate edited prompt (JSON schema if applicable)

#### UX Recommendations Summary

**Best Practices**:

1. ✅ **Visual First**: Make queue state immediately visible and manipulable
2. ✅ **Clear Constraints**: Show what's locked (completed) vs editable (pending)
3. ✅ **Forgiving**: Support undo/redo for all modifications
4. ✅ **Flexible**: Support both "queue and go" and "build then execute" workflows
5. ✅ **Responsive**: Optimistic updates with rollback on error
6. ✅ **Accessible**: Keyboard shortcuts for power users

**Recommended Priority**:

1. **Phase 5** (Queue Next) - High impact, low complexity
2. **Phase 8** (Build Mode) - Critical for workflow planning use case
3. **Phase 6** (Removal) - Natural next step after insertion
4. **Phase 7** (Drag-and-Drop) - Polish, nice-to-have but not essential
5. **Phase 9** (Undo/Redo) - Safety net, implement before public release
6. **Phase 10** (Inline Editing) - Advanced feature, can defer

**Anti-Patterns to Avoid**:

- ❌ Allowing modification of completed prompts (breaks execution history)
- ❌ Auto-saving queue state to disk (queue is ephemeral, output is what matters)
- ❌ Complex modal workflows for simple operations (keep it inline)
- ❌ Removing all prompts at once without confirmation (destructive)

## Next Steps

1. ✅ Review and approve this plan (including future enhancements)
2. Implement Phase 1 (Core Queue Append)
3. Test thoroughly with manual workflows
4. Implement Phase 2 (Dashboard Integration)
5. Add comprehensive tests
6. Implement Phase 3 (Settings & Polish)
7. Beta test with users
8. Implement Phase 5 (Queue Next) - Quick win
9. Implement Phase 8 (Build Mode) - Enable workflow planning
10. Evaluate remaining phases based on user feedback
