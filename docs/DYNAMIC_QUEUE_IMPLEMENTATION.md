# Dynamic Queue Implementation Plan

## Overview

Enable Copilot to extend FlightPath workflows autonomously by editing `.flightpath.json` files during execution. This transforms FlightPath from a static workflow executor into an adaptive autonomous agent framework.

> **Implementation Note**: This document contains the original design plan. The actual implementation took a simpler approach:
>
> - The `QueuedPrompt` interface and `generatePromptIdentity()` function were removed
> - `PromptQueue` uses `PromptItem` directly with inline hash computation
> - The core functions (`hashPromptContent`, `isPromptCompleted`, `shouldInjectExtensionInstructions`) are implemented in `src/utils/PromptIdentity.ts`

## Business Context

**Monetization Strategy**: This feature is designed to be opt-in and may be gated in a future paid tier:

- Free tier: Static queues only
- Paid tier: Dynamic queue expansion

**Setting**: `flightpath.enableDynamicQueue` (boolean, default: `false`)

## Use Case

```json
// bugfix.flightpath.json (initial state)
{
  "prompts": [
    {
      "id": "analyze",
      "prompt": "Examine the workspace and identify files related to authentication bug"
    },
    {
      "id": "diagnose",
      "prompt": "Find the root cause of the authentication timeout bug"
    },
    {
      "id": "fix",
      "prompt": "Try to fix the bug. If the fix requires multiple steps or you encounter blockers, add additional prompts to this bugfix.flightpath.json file to break down the work.",
      "allowDynamicExtension": true
    }
  ]
}
```

After executing step 3, Copilot might extend the file to:

```json
{
  "prompts": [
    {
      "id": "analyze",
      "prompt": "Examine the workspace and identify files related to authentication bug"
    },
    {
      "id": "diagnose",
      "prompt": "Find the root cause of the authentication timeout bug"
    },
    {
      "id": "fix",
      "prompt": "Try to fix the bug. If the fix requires multiple steps or you encounter blockers, add additional prompts to this bugfix.flightpath.json file to break down the work."
    },
    {
      "id": "refactor-auth",
      "prompt": "Refactor the authentication module to use async/await instead of callbacks"
    },
    {
      "id": "update-tests",
      "prompt": "Update authentication tests to verify timeout handling"
    },
    {
      "id": "verify-fix",
      "prompt": "Run all tests and verify the authentication bug is resolved"
    }
  ]
}
```

FlightPath detects the file change and continues execution with the new prompts.

## Architecture Decisions

### 1. Instructions vs Tool Calls

**Decision**: Use **instructions-based approach** (no custom tools)

**Rationale**:

- File editing is Copilot's core competency
- Simpler implementation (leverage existing validation)
- Works with all Copilot models
- Can add tools later if error rates are too high

**Instructions will be injected via `<criticalInstruction>` XML tag**

### 1.5. Selective Instruction Injection

**Decision**: Use **per-prompt flag with smart defaults**

**Rationale**:

- Token efficiency: Don't inject instructions on every prompt
- User control: Explicit `allowDynamicExtension` flag per prompt
- Smart defaults: If no flags specified, inject only on last prompt
- Self-documenting: JSON clearly shows which prompts can extend queue

**Injection Logic**:

```typescript
function shouldInjectExtensionInstructions(
  prompt: Prompt,
  index: number,
  allPrompts: Prompt[],
  dynamicExtensionOnLastPrompt: boolean // Global setting
): boolean {
  // Explicit flag takes precedence
  if (prompt.allowDynamicExtension === true) return true;
  if (prompt.allowDynamicExtension === false) return false;

  // Default: inject ONLY on last prompt if no prompts have explicit flag
  // AND the global setting allows it
  const isLastPrompt = index === allPrompts.length - 1;
  const anyExplicitFlag = allPrompts.some(
    (p) => p.allowDynamicExtension !== undefined
  );

  return isLastPrompt && !anyExplicitFlag && dynamicExtensionOnLastPrompt;
}
```

**Examples**:

```json
// Example 1: Targeted extension (explicit flags)
{
  "prompts": [
    { "id": "task-a", "prompt": "Implement feature X" },
    { "id": "task-b", "prompt": "Debug issue Y", "allowDynamicExtension": true },
    { "id": "task-c", "prompt": "Write tests" }
  ]
}
// Only task-b gets injection

// Example 2: Default behavior (no flags, global setting enabled)
{
  "prompts": [
    { "id": "task-a", "prompt": "Do X" },
    { "id": "task-b", "prompt": "Do Y" },
    { "id": "task-c", "prompt": "Do Z" }
  ]
}
// Only task-c (last) gets injection (if dynamicExtensionOnLastPrompt: true)
// No injection if dynamicExtensionOnLastPrompt: false

// Example 3: Disable completely
{
  "prompts": [
    { "id": "task-a", "prompt": "Do X", "allowDynamicExtension": false },
    { "id": "task-b", "prompt": "Do Y", "allowDynamicExtension": false }
  ]
}
// No injection (even on last prompt)
```

### 2. Prompt Identity Tracking

**Decision**: **Hybrid identity system**

```typescript
interface PromptIdentity {
  explicitId?: string; // Optional user/Copilot-provided ID
  contentHash: string; // SHA-256 hash of prompt text
  originalPosition: number; // Position when first loaded
}
```

**Completion Detection Logic**:

```typescript
function isPromptCompleted(prompt: Prompt, completedIds: Set<string>): boolean {
  // Check explicit ID first
  if (prompt.id && completedIds.has(prompt.id)) {
    return true;
  }

  // Fallback to content hash
  const hash = hashPromptContent(prompt.prompt);
  return completedIds.has(hash);
}
```

**Benefits**:

- Optional IDs for human readability
- Automatic hash-based tracking as fallback
- Resilient to ID mistakes by Copilot
- Handles manual file edits gracefully

### 3. File Reload Strategy

**Decision**: **Reload after each prompt completion**

**Reload Trigger Points**:

1. After successful prompt execution
2. After retry exhaustion (maxRetries reached)
3. After end condition validation (success or timeout)

**NOT triggered**:

- During prompt execution
- During retry attempts
- When queue is paused

**FileSystemWatcher**: Not needed initially (reload at safe points only)

### 4. Queue Merging Algorithm

```typescript
async function reloadAndMergeQueue(
  currentQueue: QueuedPrompt[],
  completedIds: Set<string>,
  filePath: string
): Promise<QueuedPrompt[]> {
  // 1. Reload file with validation
  let reloadedPrompts: Prompt[];
  try {
    const parsed = await PromptFileParser.parse(filePath);
    reloadedPrompts = parsed.prompts;
  } catch (error) {
    // Invalid JSON - log error and continue with current queue
    logger.error("Failed to reload queue - invalid JSON", error);
    showErrorNotification(
      "Queue file has invalid JSON. Continuing with current queue."
    );
    return currentQueue;
  }

  // 2. Identify new prompts
  const newPrompts: QueuedPrompt[] = [];

  for (const prompt of reloadedPrompts) {
    if (!isPromptCompleted(prompt, completedIds)) {
      const hash = hashPromptContent(prompt.prompt);
      newPrompts.push({
        ...prompt,
        status: "pending",
        identity: {
          explicitId: prompt.id,
          contentHash: hash,
          originalPosition: reloadedPrompts.indexOf(prompt),
        },
      });
    }
  }

  // 3. Append new prompts to current queue
  return [...currentQueue, ...newPrompts];
}
```

### 5. Safety Guardrails

**Settings**:

```typescript
flightpath.enableDynamicQueue: boolean (default: false)
flightpath.dynamicExtensionOnLastPrompt: boolean (default: true)
flightpath.maxQueueSize: number (default: 100)
flightpath.maxExecutionTime: number (default: 18000) // seconds (5 hours), range: 300-86400
flightpath.unlimitedMode: boolean (default: false) // Pro feature - ignores maxQueueSize AND maxExecutionTime when true
flightpath.notifyOnQueueExtension: boolean (default: true)
```

**Enforcement**:

- Reject queue reload if `newQueueSize > maxQueueSize` (unless `unlimitedMode` is true)
- Track total execution time across all prompts
- Cancel execution if `totalTime > maxExecutionTime` (unless `unlimitedMode` is true)
- Show notification when queue is extended (if enabled)

**Error Handling**:
| Error Type | Action |
|------------|--------|
| Invalid JSON after reload | Log error, notify user, continue with current queue |
| Queue size exceeded | Log warning, notify user, stop adding new prompts |
| Execution time exceeded | Stop execution, notify user with summary |
| Malformed prompt structure | Skip invalid prompt, log warning, continue |
| File read error | Log error, continue with current queue |

## Implementation Details

### Execution Time Tracking

**What counts toward execution time limit:**

- ✅ Time during prompt execution (sending to Copilot, waiting for response)
- ✅ Time running end condition scripts
- ✅ Time during retry attempts
- ❌ Time when queue is paused (subtract paused duration)
- ❌ Time before queue starts

**Implementation:**

```typescript
// Track active execution time (pause-aware)
startTime: number;
pausedTime: number;
totalPausedDuration: number;

function getActiveExecutionTime(): number {
  const elapsed = Date.now() - startTime;
  return elapsed - totalPausedDuration;
}
```

### Feature Disabled Behavior

When `enableDynamicQueue = false`:

1. **Never inject** dynamic queue instructions (regardless of flags)
2. **Skip file reload** after prompt completion (log debug message)
3. **Ignore** `allowDynamicExtension` flags in prompt files (no validation warning)
4. Queue executes statically as originally loaded

### Notification Timing

Notifications are shown **after successful queue merge**:

1. File change detected
2. File reloaded and validated (JSON parse)
3. New prompts identified (not duplicates)
4. New prompts merged into queue ← **Notification shown here**
5. Execution continues

**Notification text**: `"Queue extended: +{count} prompts added ({currentSize}/{maxSize})"`

### File Path Format

All file paths in instructions should be **workspace-relative**:

- ✅ Good: `.flightpath/bugfix.flightpath.json`
- ❌ Bad: `C:\Users\nathan\project\.flightpath\bugfix.flightpath.json`

**Implementation**: Use `vscode.workspace.asRelativePath(filePath)`

### Tracking Dynamically-Added Prompts

Extend `QueuedPrompt` type:

```typescript
export interface QueuedPrompt extends Prompt {
  status: "pending" | "running" | "completed" | "failed" | "retrying";
  identity: PromptIdentity;
  isDynamicallyAdded?: boolean; // True if added after initial load
  addedAtExtension?: number; // Which extension cycle added this (0 = initial, 1+ = dynamic)
  attempts?: number;
  error?: string;
  response?: string;
}
```

Set `isDynamicallyAdded: true` and `addedAtExtension: queueExtensions` during merge.

### Dashboard Message Types

Add to `src/types/DashboardConstants.ts`:

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  QUEUE_EXTENDED: "queue_extended",
  QUEUE_SIZE_LIMIT_REACHED: "queue_size_limit_reached",
  EXECUTION_TIME_LIMIT_REACHED: "execution_time_limit_reached",
  DYNAMIC_QUEUE_ENABLED: "dynamic_queue_enabled",
  DYNAMIC_QUEUE_DISABLED: "dynamic_queue_disabled",
} as const;
```

### User-Facing Messages

**Queue size exceeded:**

```
Queue limit reached ({currentSize}/{maxSize} prompts).
Cannot add more prompts. Consider increasing maxQueueSize in settings.
```

**Execution time exceeded:**

```
Workflow stopped: Maximum execution time reached ({elapsed}s / {maxTime}s).
Completed {completedCount} of {totalCount} prompts.
{remainingCount} prompts remaining in queue.
```

**Queue extended (notification):**

```
FlightPath: Queue extended (+{addedCount} prompts)
Current queue: {currentSize}/{maxSize}
```

### Instruction Template Variables

Complete list of variables to inject:

- `{currentIndex}` - Current prompt index (1-based for display)
- `{totalPrompts}` - Total prompts in current queue
- `{filePath}` - Workspace-relative path to .flightpath.json file
- `{currentSize}` - Current queue size
- `{maxSize}` - maxQueueSize setting value
- `{elapsedSeconds}` - Active execution time in seconds (rounded)
- `{maxTimeSeconds}` - maxExecutionTime setting value (seconds)
- `{remainingTime}` - Time remaining before limit (seconds)

**Updated template:**

```xml
<criticalInstruction>
You are executing prompt {currentIndex} of {totalPrompts} in a FlightPath workflow.

DYNAMIC QUEUE EXTENSION:
If you need additional steps to complete this task, you can extend the workflow:
1. Read the current file: {filePath}
2. Insert new prompts AFTER the current prompt (index {currentIndex}) in the "prompts" array
   - Recommended: Insert immediately after current position for logical flow
   - Alternative: Append to end of array if order doesn't matter
3. Include "id" fields for clarity (e.g., "id": "step-4-refactor-auth")
4. Optionally set "allowDynamicExtension": true on prompts that may need further extension
5. Keep existing prompts intact - DO NOT modify or delete completed prompts
6. Save the file - FlightPath will detect changes and continue

Current queue: {currentSize}/{maxSize} prompts
Execution time: {elapsedSeconds}s / {maxTimeSeconds}s ({remainingTime}s remaining)

IMPORTANT: Only extend the queue if truly necessary. Each prompt adds execution time.
</criticalInstruction>
```

## Implementation Phases

### Phase 1: Core Reload & Merge (3-4 hours)

**Files to Modify**:

- `src/types/FlightPathTypes.ts` - Add identity types
- `src/flightpath/PromptQueue.ts` - Add reload logic
- `src/flightpath/FlightPathManager.ts` - Trigger reloads
- `package.json` - Add new settings
- `schemas/prompt-schema.json` - Add optional `id` and `allowDynamicExtension` fields

**Files to Create**:

- `src/utils/PromptIdentity.ts` - Hash and identity utilities

**Tasks**:

1. Add `flightpath.enableDynamicQueue` setting to package.json
2. Add `flightpath.dynamicExtensionOnLastPrompt` setting to package.json
3. Create `src/utils/PromptIdentity.ts` with hash and identity utilities
4. Extend `QueuedPrompt` type with identity tracking and `isDynamicallyAdded` flag
5. Add `allowDynamicExtension` field to prompt schema
6. Implement `reloadAndMergeQueue()` in PromptQueue with duplicate detection
7. Add reload trigger in FlightPathManager after prompt completion (only if enableDynamicQueue = true)
8. Add basic validation and error handling
9. Add feature-disabled check (skip reload when enableDynamicQueue = false)

**Testing**:

- Manual test with 3-prompt file that adds 2 more prompts
- Test invalid JSON handling
- Test duplicate prompt detection

### Phase 2: Safety & Validation (2-3 hours)

**Files to Modify**:

- `src/flightpath/PromptQueue.ts` - Add safety checks
- `src/flightpath/FlightPathManager.ts` - Track execution time
- `package.json` - Add safety settings

**Tasks**:

1. Add `maxQueueSize`, `maxExecutionTime`, and `unlimitedMode` settings to package.json
2. Implement queue size validation in reloadAndMergeQueue (respect unlimitedMode)
3. Implement execution time tracking with unlimited override support (pause-aware)
4. Add graceful shutdown on limit exceeded with user-facing messages
5. Add telemetry for queue extension events

**Testing**:

- Test maxQueueSize enforcement (verify user-facing notification)
- Test maxExecutionTime cancellation (verify summary message)
- Test unlimitedMode override (both queue size and execution time unlimited)
- Test pause-aware time tracking (paused time excluded)
- Test error recovery scenarios

### Phase 3: UX Enhancement (2-3 hours)

**Files to Modify**:

- `src/ui/DashboardProvider.ts` - Show queue growth
- `src/types/DashboardConstants.ts` - Add new message types
- `media/dashboard.html` - Update UI for dynamic queue indication
- `src/flightpath/FlightPathManager.ts` - Add notifications

**Tasks**:

1. Add QUEUE_EXTENDED, QUEUE_SIZE_LIMIT_REACHED, EXECUTION_TIME_LIMIT_REACHED message types to DashboardConstants.ts
2. Add notification when queue is extended (after successful merge, not during reload)
3. Update dashboard to show "Queue Extended: +3 prompts" events with timestamp
4. Add visual indicator for dynamically-added prompts (use isDynamicallyAdded flag)
5. Show current queue size vs max in dashboard header
6. Add "Dynamic Queue Enabled" badge in dashboard header (when enableDynamicQueue = true)
7. Display execution time progress (elapsed / max or "unlimited")

**Testing**:

- Verify notifications appear
- Verify dashboard updates in real-time
- Test with rapid queue extensions

### Phase 4: Copilot Instructions (1-2 hours)

**Files to Modify**:

- `src/flightpath/base/CopilotIntegration.ts` - Enhanced prompt wrapping
- `.github/copilot-instructions.md` - Document dynamic queue pattern

**Tasks**:

1. Implement selective instruction injection based on `allowDynamicExtension` flag and feature enabled check
2. Update `<criticalInstruction>` template with correct time units and remaining time calculation
3. Use workspace-relative file paths in instructions
4. Add examples of when/how to extend queue
5. Document best practices for prompt IDs and `allowDynamicExtension` usage
6. Add warnings about queue limits and execution time
7. Create example `.flightpath.json` files in manual-test/ demonstrating all patterns

**Instruction Template** (injected only when `shouldInjectExtensionInstructions()` returns true):

```xml
<criticalInstruction>
You are executing prompt {currentIndex} of {totalPrompts} in a FlightPath workflow.

DYNAMIC QUEUE EXTENSION:
If you need additional steps to complete this task, you can extend the workflow:
1. Read the current file: {filePath}
2. Insert new prompts AFTER the current prompt (index {currentIndex}) in the "prompts" array
   - Recommended: Insert immediately after current position for logical flow
   - Alternative: Append to end of array if order doesn't matter
3. Include "id" fields for clarity (e.g., "id": "step-4-refactor-auth")
4. Optionally set "allowDynamicExtension": true on prompts that may need further extension
5. Keep existing prompts intact - DO NOT modify or delete completed prompts
6. Save the file - FlightPath will detect changes and continue

Current queue: {currentSize}/{maxSize} prompts
Execution time: {elapsed}/{maxTime}ms

IMPORTANT: Only extend the queue if truly necessary. Each prompt adds execution time.
</criticalInstruction>
```

**Note**: This instruction is only injected for prompts where:

- `allowDynamicExtension: true` is explicitly set, OR
- It's the last prompt and no other prompts have explicit `allowDynamicExtension` flags

### Phase 5: Documentation & Examples (1-2 hours)

**Files to Create/Modify**:

- `docs/DYNAMIC_QUEUE_USAGE.md` - User guide
- `manual-test/dynamic-queue-example.flightpath.json` - Example workflow
- `README.md` - Add dynamic queue section
- `.github/copilot-instructions.md` - Update architecture notes

**Tasks**:

1. Create comprehensive usage guide
2. Add multiple example workflows
3. Document common patterns (debugging, exploration, feature dev)
4. Add troubleshooting section
5. Update main README with feature highlight

## Schema Changes

### Add Optional ID and allowDynamicExtension Fields

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Optional unique identifier for this prompt. Used for tracking completion across queue reloads. If omitted, a content hash is used automatically.",
      "pattern": "^[a-zA-Z0-9-_]+$",
      "maxLength": 50
    },
    "prompt": {
      "type": "string",
      "description": "The prompt text to send to Copilot"
    },
    "model": {
      "type": "string",
      "enum": [
        "claude-sonnet-4.5",
        "claude-sonnet-4",
        "claude-haiku-4.5",
        "gpt-5"
      ]
    },
    "allowDynamicExtension": {
      "type": "boolean",
      "description": "If true, inject instructions for extending the queue. If false, never inject. If omitted, defaults to true for last prompt only (when no other prompts have explicit flags)."
    },
    "endCondition": {
      "type": "object",
      "properties": {
        "script": { "type": "string" },
        "returns": { "type": "string" },
        "timeout": { "type": "number" }
      }
    }
  },
  "required": ["prompt"]
}
```

## Type Definitions

### New Types

```typescript
// src/types/FlightPathTypes.ts

export interface PromptIdentity {
  explicitId?: string; // User or Copilot-provided ID
  contentHash: string; // SHA-256 hash of prompt text
  originalPosition: number; // Position in original file
}

export interface QueuedPrompt extends Prompt {
  status: "pending" | "running" | "completed" | "failed" | "retrying";
  identity: PromptIdentity;
  isDynamicallyAdded?: boolean; // True if added after initial load
  addedAtExtension?: number; // Which extension cycle added this (0 = initial, 1+ = dynamic)
  attempts?: number;
  error?: string;
  response?: string;
}

export interface QueueState {
  prompts: QueuedPrompt[];
  currentIndex: number;
  completedIds: Set<string>; // Tracks completed IDs and hashes
  totalExecutionTime: number; // Milliseconds
  queueExtensions: number; // How many times queue was extended
  lastReloadTime?: number; // Timestamp of last reload
}

export interface DynamicQueueConfig {
  enabled: boolean;
  dynamicExtensionOnLastPrompt: boolean;
  maxQueueSize: number; // 1-1000 (default: 100)
  maxExecutionTime: number; // In seconds (300-86400, default: 18000)
  unlimitedMode: boolean; // If true, ignore maxQueueSize AND maxExecutionTime
  notifyOnExtension: boolean;
}
```

## Settings Schema

### package.json Configuration Section

```json
{
  "flightpath.enableDynamicQueue": {
    "type": "boolean",
    "default": false,
    "description": "Allow Copilot to extend the workflow by adding prompts to the .flightpath.json file during execution",
    "order": 10
  },
  "flightpath.dynamicExtensionOnLastPrompt": {
    "type": "boolean",
    "default": true,
    "description": "When dynamic queues are enabled, allow extension on the last prompt when no explicit allowDynamicExtension flags are set. Disable this if your last prompt should never extend the queue (e.g., 'commit changes').",
    "order": 11
  },
  "flightpath.maxQueueSize": {
    "type": "number",
    "default": 100,
    "minimum": 1,
    "maximum": 1000,
    "description": "Maximum number of prompts allowed in a dynamic queue (prevents infinite loops). Ignored if unlimitedMode is enabled.",
    "markdownDescription": "Maximum number of prompts allowed in a dynamic queue (prevents infinite loops). Range: **1** to **1000**. Default: **100**. Ignored if `unlimitedMode` is enabled.",
    "order": 12
  },
  "flightpath.maxExecutionTime": {
    "type": "number",
    "default": 18000,
    "minimum": 300,
    "maximum": 86400,
    "description": "Maximum total execution time for a workflow in seconds (5 minutes to 24 hours, default: 5 hours). Ignored if unlimitedMode is enabled.",
    "markdownDescription": "Maximum total execution time for a workflow in seconds. Range: **5 minutes** (300) to **24 hours** (86400). Default: **5 hours** (18000). Ignored if `unlimitedMode` is enabled.",
    "order": 13
  },
  "flightpath.unlimitedMode": {
    "type": "boolean",
    "default": false,
    "description": "Enable unlimited mode: no queue size or execution time limits. When enabled, maxQueueSize and maxExecutionTime are both ignored. May be restricted to paid tier in future.",
    "markdownDescription": "Enable unlimited mode: removes all queue size and execution time limits. When enabled, both `maxQueueSize` and `maxExecutionTime` are ignored. **Note:** This feature may be restricted to paid tier in future releases.",
    "order": 14
  },
  "flightpath.notifyOnQueueExtension": {
    "type": "boolean",
    "default": true,
    "description": "Show notification when Copilot extends the prompt queue",
    "order": 15
  }
}
```

## Utilities

### Content Hashing Function

```typescript
// src/utils/PromptIdentity.ts

import * as crypto from "crypto";

export function hashPromptContent(promptText: string): string {
  // Normalize whitespace to make hashing more robust
  const normalized = promptText.trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function generatePromptIdentity(
  prompt: Prompt,
  position: number
): PromptIdentity {
  return {
    explicitId: prompt.id,
    contentHash: hashPromptContent(prompt.prompt),
    originalPosition: position,
  };
}

export function isPromptCompleted(
  prompt: Prompt | QueuedPrompt,
  completedIds: Set<string>
): boolean {
  // Check explicit ID first
  if (prompt.id && completedIds.has(prompt.id)) {
    return true;
  }

  // Fallback to content hash
  const hash = hashPromptContent(prompt.prompt);
  return completedIds.has(hash);
}

export function shouldInjectExtensionInstructions(
  prompt: Prompt,
  index: number,
  allPrompts: Prompt[],
  dynamicExtensionOnLastPrompt: boolean = true
): boolean {
  // Explicit flag takes precedence
  if (prompt.allowDynamicExtension === true) return true;
  if (prompt.allowDynamicExtension === false) return false;

  // Default: inject ONLY on last prompt if:
  // 1. No prompts have explicit flags, AND
  // 2. Global setting allows extension on last prompt
  const isLastPrompt = index === allPrompts.length - 1;
  const anyExplicitFlag = allPrompts.some(
    (p) => p.allowDynamicExtension !== undefined
  );

  return isLastPrompt && !anyExplicitFlag && dynamicExtensionOnLastPrompt;
}
```

## Testing Strategy

### Manual Test Cases

1. **Basic Queue Extension**
   - File: `manual-test/dynamic-queue-basic.flightpath.json`
   - Start with 2 prompts
   - Prompt 2 adds 1 more prompt
   - Verify execution continues

2. **Multi-Stage Extension**
   - File: `manual-test/dynamic-queue-multi-stage.flightpath.json`
   - Start with 3 prompts
   - Prompt 3 adds 2 prompts
   - Prompt 5 adds 1 more prompt
   - Verify all prompts execute in order

3. **Max Queue Size**
   - File: `manual-test/dynamic-queue-max-size.flightpath.json`
   - Set maxQueueSize to 5
   - Try to add 10 prompts
   - Verify execution stops at 5

4. **Invalid JSON Handling**
   - Start execution
   - Manually corrupt JSON during execution
   - Verify graceful error handling

5. **Duplicate Detection**
   - File: `manual-test/dynamic-queue-duplicates.flightpath.json`
   - Add duplicate prompts
   - Verify they're not re-executed

### Automated Tests

```typescript
// src/test/integration/DynamicQueue.test.ts

describe("Dynamic Queue", () => {
  test("detects new prompts after reload", async () => {
    // Setup initial queue
    // Modify file to add prompts
    // Trigger reload
    // Verify new prompts appended
  });

  test("prevents duplicate execution via content hash", async () => {
    // Add same prompt text twice
    // Verify only executed once
  });

  test("enforces maxQueueSize limit", async () => {
    // Try to exceed limit
    // Verify rejection
  });

  test("tracks execution time and enforces limit", async () => {
    // Mock slow prompts
    // Verify timeout cancellation
  });

  test("handles invalid JSON gracefully", async () => {
    // Corrupt JSON during reload
    // Verify error handling
  });
});
```

## Example Workflows

### 1. Adaptive Debugging

```json
{
  "prompts": [
    {
      "id": "gather-logs",
      "prompt": "Examine error logs and identify the exception stack trace"
    },
    {
      "id": "diagnose",
      "prompt": "Analyze the stack trace and determine the root cause. If multiple potential causes exist, add diagnostic prompts to this file to investigate each one.",
      "allowDynamicExtension": true
    }
  ]
}
```

**Note**: Only the `diagnose` prompt gets dynamic queue instructions injected.

### 2. Exploratory Refactoring

```json
{
  "prompts": [
    {
      "id": "analyze-arch",
      "prompt": "Review the codebase architecture and identify areas that violate SOLID principles"
    },
    {
      "id": "plan-refactor",
      "prompt": "Based on the analysis, add specific refactoring tasks to this .flightpath.json file. Each task should refactor one module or component.",
      "allowDynamicExtension": true
    }
  ]
}
```

**Note**: Only the `plan-refactor` prompt gets dynamic queue instructions injected.

### 3. Iterative Feature Development

```json
{
  "prompts": [
    {
      "id": "scaffold",
      "prompt": "Create the basic feature scaffold with types and interfaces"
    },
    {
      "id": "implement-core",
      "prompt": "Implement core feature logic. After implementation, add prompts to this file for: 1) Adding tests, 2) Adding error handling, 3) Adding documentation",
      "allowDynamicExtension": true,
      "endCondition": {
        "script": "verify_core_implementation.js",
        "returns": "true"
      }
    }
  ]
}
```

**Note**: Only the `implement-core` prompt gets dynamic queue instructions injected.

### 4. Default Behavior (No Explicit Flags)

```json
{
  "prompts": [
    {
      "id": "task-1",
      "prompt": "Analyze the problem space"
    },
    {
      "id": "task-2",
      "prompt": "Implement initial solution"
    },
    {
      "id": "task-3",
      "prompt": "Test and refine. Add more tasks if needed."
    }
  ]
}
```

**Note**: Since no `allowDynamicExtension` flags are specified, only the last prompt (`task-3`) gets dynamic queue instructions injected by default.

## Risks & Mitigations

| Risk                                         | Impact | Mitigation                                         |
| -------------------------------------------- | ------ | -------------------------------------------------- |
| Infinite loop (Copilot keeps adding prompts) | High   | `maxQueueSize` hard limit, execution time limit    |
| Invalid JSON corruption                      | Medium | Robust error handling, continue with current queue |
| Accidental deletion of completed prompts     | Low    | Content hash fallback, warning logs                |
| Performance degradation (frequent file I/O)  | Low    | Reload only between prompts, not during execution  |
| User confusion (queue grows unexpectedly)    | Medium | Notifications, dashboard visibility, clear docs    |
| File write conflicts                         | Low    | Reload at safe points only (between prompts)       |

## Success Metrics

**Phase 1 Completion Criteria**:

- [ ] Can reload file after prompt completion
- [ ] New prompts are appended to queue
- [ ] Completed prompts are not re-executed
- [ ] Invalid JSON is handled gracefully

**Phase 2 Completion Criteria**:

- [ ] maxQueueSize is enforced
- [ ] maxExecutionTime is enforced
- [ ] All safety limits can be configured
- [ ] Error scenarios are handled

**Phase 3 Completion Criteria**:

- [ ] Dashboard shows queue extensions
- [ ] Notifications appear when queue grows
- [ ] Users can see dynamic vs static prompts
- [ ] Real-time queue size is visible

**Overall Success**:

- Works reliably in manual testing (95%+ success rate)
- Handles error cases gracefully (no crashes)
- Clear user feedback (notifications + dashboard)
- Well-documented with examples
- Ready for monetization gating

## Future Enhancements (Post-MVP)

1. **Tool-based API** (if instruction approach proves error-prone)
   - `flightpath.addPrompt(prompt: string, id?: string)`
   - `flightpath.getCurrentQueue()`
   - `flightpath.getQueueStats()`

2. **Queue Branching**
   - Allow conditional paths: "If bug found in module A, execute branch-A prompts, else branch-B"

3. **Prompt Templates**
   - Pre-built dynamic queue patterns for common scenarios

4. **Analytics Dashboard**
   - Track queue growth patterns
   - Identify common extension scenarios
   - Measure autonomous success rates

5. **Rollback Support**
   - Undo last N queue extensions
   - Checkpoint/restore queue state

6. **Collaborative Queues**
   - Multiple Copilot sessions extending same queue
   - Conflict resolution

## Open Questions

1. **Should we support removing prompts from the queue?**
   - Pro: Allows Copilot to optimize/refactor plan
   - Con: Complexity in tracking deletions
   - **Decision**: Not in MVP - append-only is simpler

2. **Should we support modifying existing prompts?**
   - Pro: Allows refinement of upcoming prompts
   - Con: Complexity in detecting changes, potential to modify completed prompts
   - **Decision**: Not in MVP - modifications break content hash

3. **Should we log all queue modifications?**
   - Pro: Debugging, audit trail
   - Con: Log verbosity
   - **Decision**: Yes - log to Output panel (same as CLI output)

4. **Should we limit how many prompts can be added at once?**
   - Pro: Prevents massive queue explosions
   - Con: Arbitrary limit
   - **Decision**: No - maxQueueSize is sufficient

## Timeline Estimate

- **Phase 1**: 3-4 hours (Core reload & merge)
- **Phase 2**: 2-3 hours (Safety & validation)
- **Phase 3**: 2-3 hours (UX enhancement)
- **Phase 4**: 1-2 hours (Copilot instructions)
- **Phase 5**: 1-2 hours (Documentation)

**Total**: 9-14 hours (1-2 days of focused work)

**Target completion**: End of week (given other priorities)

## Next Steps

1. Review and approve this plan
2. Update project instructions with dynamic queue architecture
3. Begin Phase 1 implementation
4. Create manual test cases alongside implementation
5. Iterate based on testing results
