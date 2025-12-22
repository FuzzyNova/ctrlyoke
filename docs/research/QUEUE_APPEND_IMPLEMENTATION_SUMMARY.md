# Queue Append Feature - Implementation Summary

**Date**: December 21, 2025  
**Status**: Ready for Implementation  
**Related**: [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md), [FLIGHTPATH_MCP_IMPLEMENTATION.md](FLIGHTPATH_MCP_IMPLEMENTATION.md)

## MVP Scope

**Goal**: Enable users to queue additional prompts/workflows without clearing the dashboard or losing output.

**User Interface**:

- Context menu: "Queue with FlightPath" (right-click on `.prompt.md`, `.flightpath.yaml`, `.flightpath.json`)
- Editor title bar: Queue icon button (next to existing "Run" button)
- Notification: "Queued {count} prompts to active workflow"

**No Dashboard Changes**: Appended prompts appear as regular queue items with updated counters (e.g., "Step 4/8")

**No New Settings**: Reuses existing Dynamic Queue settings (`maxQueueSize`, `maxExecutionTime`, `unlimitedMode`)

---

## Implementation Checklist

### 1. package.json Changes

#### Add Command

```json
{
  "command": "flightpath.queueFromContext",
  "title": "Queue with FlightPath",
  "category": "FlightPath",
  "icon": "$(add)"
}
```

#### Add Context Menus

**Explorer Context Menu**:

```json
{
  "command": "flightpath.queueFromContext",
  "when": "resourceFilename =~ /\\.(flightpath\\.(yaml|yml|json)|prompt\\.md)$/ && resourceScheme == file",
  "group": "flightpath@3"
}
```

**Editor Title Bar** (icon button):

```json
{
  "command": "flightpath.queueFromContext",
  "when": "resourceFilename =~ /\\.(flightpath\\.(yaml|yml|json)|prompt\\.md)$/ && resourceScheme == file",
  "group": "navigation@2"
}
```

**Editor Title Context Menu**:

```json
{
  "command": "flightpath.queueFromContext",
  "when": "resourceFilename =~ /\\.(flightpath\\.(yaml|yml|json)|prompt\\.md)$/ && resourceScheme == file",
  "group": "flightpath@3"
}
```

---

### 2. Code Changes

#### A. PromptQueue.ts

**Add Method**:

```typescript
/**
 * Append prompts to the current queue without clearing state
 * @param prompts - Prompts to append
 * @throws Error if queue is in invalid state for appending
 */
public appendPrompts(prompts: PromptItem[]): void {
  if (!this.canAppend()) {
    throw new Error("Cannot append: Queue is in cancelled or error state");
  }

  // Append to queue
  this.state.prompts.push(...prompts);

  // Extend results array
  prompts.forEach((prompt) => {
    this.state.results.push({
      prompt: prompt.prompt,
      response: "",
      status: "pending",
    });
  });

  // If queue completed/idle, restart execution
  if (this.isCompleted()) {
    this.resume();
  }

  this.emitStateChange();
}

/**
 * Check if queue can accept appended prompts
 * @returns true if queue state allows appending
 */
public canAppend(): boolean {
  const invalidStates: ExecutionState[] = ["cancelling", "error"];
  return !invalidStates.includes(this.state.executionState);
}

/**
 * Check if queue has completed all prompts
 * @returns true if all prompts completed
 */
public isCompleted(): boolean {
  return this.state.executionState === "completed" ||
         this.state.executionState === "idle";
}
```

#### B. FlightPathManager.ts

**Add Method**:

```typescript
/**
 * Append prompts from a file to the current queue
 * @param filePath - Path to prompt file (.prompt.md, .flightpath.yaml, .flightpath.json)
 */
public async appendFromFile(filePath: string): Promise<void> {
  try {
    // 1. Parse file (reuse existing parser)
    const parsed = await this.promptParser.parseFile(filePath);

    // 2. Validate queue state
    if (!this.queue.canAppend()) {
      vscode.window.showErrorMessage(
        "Cannot queue prompts: Workflow must be cleared first"
      );
      return;
    }

    // 3. Check queue size limit
    const config = vscode.workspace.getConfiguration("flightpath");
    const maxQueueSize = config.get<number>("maxQueueSize", 100);
    const unlimitedMode = config.get<boolean>("unlimitedMode", false);
    const currentSize = this.queue.getState().prompts.length;
    const newSize = currentSize + parsed.prompts.length;

    if (!unlimitedMode && newSize > maxQueueSize) {
      vscode.window.showWarningMessage(
        `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
        `Enable unlimitedMode or increase maxQueueSize to proceed.`
      );
      return;
    }

    // 4. Append prompts
    this.queue.appendPrompts(parsed.prompts);

    // 5. Show notification
    vscode.window.showInformationMessage(
      `Queued ${parsed.prompts.length} prompts to active workflow`
    );

  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to queue prompts: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
```

#### C. extension.ts

**Register Command**:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.queueFromContext",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage("No file selected");
        return;
      }
      await manager.appendFromFile(uri.fsPath);
    }
  )
);
```

---

### 3. Dashboard Changes

**Add Message Type** (DashboardConstants.ts):

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  PROMPTS_APPENDED: "promptsAppended",
} as const;
```

**No UI Changes Required**: Existing dashboard automatically handles new prompts via `QUEUE_STATE_UPDATED` message.

---

## MCP Compatibility

**Backend Design**: `PromptQueue.appendPrompts()` is the shared implementation for both:

1. **User-driven** (this feature): Context menu → `flightpath.queueFromContext` → `FlightPathManager.appendFromFile()` → `PromptQueue.appendPrompts()`

2. **MCP-driven** (future): AI agent → MCP tool `flightpath_append_queue` → `PromptQueue.appendPrompts()`

**Working Files**: When MCP is implemented, it will read/write `.flightpath/.queue/<workflow>.queue.json` files. The user-driven feature operates directly on the in-memory queue - no file I/O needed.

---

## Testing Checklist

### Manual Testing

**Test 1: Append to Running Queue**

1. Run a multi-step workflow
2. While running, right-click another prompt file
3. Select "Queue with FlightPath"
4. Verify: New prompts appear in queue, execution continues

**Test 2: Append to Completed Queue**

1. Run a workflow to completion
2. Right-click another prompt file
3. Select "Queue with FlightPath"
4. Verify: New prompts execute automatically

**Test 3: Append to Paused Queue**

1. Run a workflow, then pause
2. Queue another prompt file
3. Verify: Prompts queued but paused, resume continues all

**Test 4: Append to Cancelled/Error State**

1. Cancel or error a workflow
2. Try to queue another prompt
3. Verify: Error message shown, append blocked

**Test 5: Queue Size Limit**

1. Set `maxQueueSize: 5`
2. Run workflow with 3 prompts
3. Try to queue 5 more prompts
4. Verify: Warning shown, append blocked

**Test 6: Editor Title Button**

1. Open a `.flightpath.yaml` file
2. Verify "Queue" button visible next to "Run" button
3. Click button while workflow running
4. Verify: Prompts appended

### Automated Testing

**Unit Tests** (PromptQueue.test.ts):

- `appendPrompts()` adds to queue correctly
- `canAppend()` returns false for cancelled/error states
- `isCompleted()` returns true for completed/idle states
- Queue size limits enforced
- Auto-resume on append to completed queue

**Integration Tests** (FlightPathManager.test.ts):

- `appendFromFile()` parses and appends correctly
- Error handling for invalid files
- Notification shown on success
- State validation before append

---

## Future Enhancements

**Visual Segmentation** (post-MVP):

- Show headers for each append operation: "Queued: follow-up.prompt.md (2 prompts)"
- Visual separator lines between segments
- Timestamp for each append

**Additional Commands** (post-MVP):

- `flightpath.queuePrompt` - Input box for single text prompt
- `flightpath.queueWithPicker` - File picker for selecting workflow

**MCP Integration** (future):

- Implement `flightpath_append_queue` MCP tool
- Working file support for `.flightpath/.queue/<workflow>.queue.json`
- AI agents can extend workflows programmatically

---

## Documentation Updates

Update these files after implementation:

1. **README.md** - Add "Queue with FlightPath" to features list
2. **QUICK_START.md** - Add queueing example
3. **CHANGELOG.md** - Document new feature
4. **.github/copilot-instructions.md** - Add append queue architecture notes
