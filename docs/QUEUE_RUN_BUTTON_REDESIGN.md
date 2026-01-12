# Queue and Run Button Redesign

**Status:** ✅ Implemented  
**Date:** 2026-01-10  
**Goal:** Differentiate Queue/Run buttons and add "New Workflow" branching feature

## Problem Statement

Current issues with Queue/Run buttons in prompt editor:

1. **Naming inconsistency**: Button IDs are from legacy implementation (`btn-editor-add`, `btn-editor-send`) don't match labels (Queue, Run)
2. **Running state confusion**: When workflow is running, both Queue and Run do the same thing (append to end and continue)
3. **No branching capability**: Users can't easily create a new workflow from the editor when one already exists (They can still use the )
4. **Completed state bug**: Queue button was auto-resuming completed workflows (FIXED in previous session)

## UX Mental Model

### Core Principles

- **Run** = "Send prompt and ensure workflow runs"
- **Queue** = "Add to queue, respect current state"
- Both use current workflow by default (creating new one if none exists)

### Button Behavior Matrix

| State                  | Queue Button                      | Run Button                      | New Workflow Checkbox |
| ---------------------- | --------------------------------- | ------------------------------- | --------------------- |
| **No workflow**        | Create new (idle)                 | Create new (run immediately)    | Hidden                |
| **Idle**               | Append to end (stay idle)         | Append to end + start execution | Enabled               |
| **Running**            | Append to end (keep running)      | Append **next** (after current) | Disabled              |
| **Paused**             | Append to end (stay paused)       | Append to end + resume          | Enabled               |
| **Stopped**            | Append to end (stay stopped)      | Append to end + resume          | Enabled               |
| **Completed**          | Append to end (set to STOPPED) ✅ | Append to end + resume          | Enabled               |
| **Workflow empty/new** | Append to end                     | Append to end + start           | Disabled + unchecked  |

## Solution Design

### 1. Differentiate Queue/Run When Running

**Problem:** Currently both append to end when running (redundant)

**Solution:** Give them different insertion positions

```
Running state:
- Queue → Append to END of queue (normal priority)
- Run → Append NEXT after current prompt (high priority)

Example:
Current queue: [Prompt 1 (running)] → [Prompt 2] → [Prompt 3] → [Prompt 4]

User types "Fix bug in auth.ts" and clicks:
- Queue → Added as Prompt 5 (end): [...Prompt 4] → [Fix bug]
- Run → Added as Prompt 2 (next): [Prompt 1] → [Fix bug] → [Prompt 2] → ...
```

**Rationale:**

- Users can course-correct without stopping ("I need this done next!")
- Queue maintains "eventual execution" semantics
- Run maintains "execute ASAP" semantics

**Button Text:**

- Queue button: Always displays "Queue" (behavior is consistent)
- Run button:
  - Not running: "Run" (start/resume execution)
  - Running: "Run Next" (insert with high priority)
- Dynamic text change reinforces behavioral difference

### 2. "New Workflow" Checkbox

**UI Placement:**

```
[Properties]    [0 tokens]    [☐ New Workflow]  [Queue]  [Run]
```

**Visibility Logic:**

- **Hidden**: When no workflow loaded (we'd create new anyway)
- **Visible**: When workflow exists
- **Disabled**: When running OR workflow is empty/new
- **Enabled**: When workflow exists, has content, and not running

**Behavior:**

- **Unchecked** (default): Append to current workflow
- **Checked**: Create new workflow first, then add prompt
  - Queue: Create new workflow (idle, prompt queued)
  - Run: Create new workflow (run immediately)

**Setting:**

- **REMOVED** - Setting was unnecessary complexity
- Checkbox always defaults to unchecked (simple, predictable behavior)
- Checkbox is a one-time action flag, not a persistent preference
- After creating new workflow, checkbox auto-unchecks

**Tooltip Behavior:**

- **Enabled**: "Create new workflow instead of appending to current one"
- **Disabled (running)**: "Can't create new workflow while running"
- **Disabled (new/empty)**: "No workflow loaded yet"

**Example Flows:**

```
Scenario 1: User wants to branch off from running workflow
1. Workflow is running
2. Checkbox is disabled (can't branch mid-execution)
3. User clicks Stop/Pause
4. Checkbox becomes enabled
5. User checks "New Workflow"
6. User clicks Queue → New workflow created (idle)

Scenario 2: User wants to quickly iterate on completed workflow
1. Workflow completed successfully
2. Checkbox enabled (workflow exists, not running)
3. User types new prompt
4. User clicks Run (checkbox unchecked) → Appends and resumes
```

### 3. ID Renames (Consistency)

**HTML/JS Changes:**

- `btn-editor-add` → `btn-editor-queue`
- `btn-editor-send` → `btn-editor-run`

**Rationale:** Button IDs should match their labels and semantic meaning

### 4. Completed Queue Fix (Already Implemented ✅)

**Problem:** Queue button was auto-resuming completed workflows

**Solution:**

- `PromptQueue.appendPrompts()`: When state is `COMPLETED`, set to `STOPPED` instead of `RUNNING`
- Sets `this.state.stopped = true` so Resume button works
- User must manually click Resume to continue

**Code locations:**

- `src/flightpath/PromptQueue.ts` (lines 973-989)
- `src/flightpath/FlightPathManager.ts` (lines 1291-1299)

## Implementation Checklist

### Phase 1: ID Renames

- [x] Rename `btn-editor-add` → `btn-editor-queue` in HTML
- [x] Update all references in dashboard.js
- [x] Rename `btn-editor-send` → `btn-editor-run` in HTML
- [x] Update all references in dashboard.js
- [x] Test: Verify buttons still work

### Phase 2: Queue/Run Differentiation

- [x] Add `position` parameter to `ACTION_TYPES` in DashboardConstants.ts
  ```typescript
  export const ACTION_TYPES = {
    QUEUE: "queue", // Append to end
    QUEUE_NEXT: "queueNext", // Append after current (new)
    RUN: "run", // Append + ensure runs
    RUN_NEXT: "runNext", // Append next + ensure runs (new)
  } as const;
  ```
- [x] Update dashboard.js `executePrompt()` to send position based on state:

  ```javascript
  function executePrompt(action) {
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;

    let finalAction = action;
    if (isRunning && action === ACTION_TYPES.RUN) {
      finalAction = ACTION_TYPES.RUN_NEXT; // Insert next when running
    }
    // Queue always appends to end (no change needed)

    vscode.postMessage({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      action: finalAction,
      // ... rest of message
    });
  }
  ```

- [x] Update `FlightPathManager.executeEphemeralPrompt()` to handle positions:
  - `QUEUE`: Always `position: "end"`
  - `QUEUE_NEXT`: Always `position: "next"`
  - `RUN`: `position: "end"` (except when running)
  - `RUN_NEXT`: `position: "next"` + ensure execution
- [x] Update button text and tooltips dynamically:
  - **Queue button** (always):
    - Text: "Queue"
    - Tooltip: "Add prompt to end of queue"
  - **Run button** (not running):
    - Text: "Run"
    - Tooltip: "Add prompt and start execution"
  - **Run button** (running):
    - Text: "Run Next"
    - Tooltip: "Add prompt next in queue (high priority)"
- [x] Implement dynamic button text in dashboard.js (see `editor-manager.js` `updateEditorButtons()`):

  ```javascript
  function updateEditorButtons() {
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const runButton = document.getElementById("btn-editor-run");

    if (isRunning) {
      runButton.textContent = "Run Next";
      runButton.title = "Add prompt next in queue (high priority)";
    } else {
      runButton.textContent = "Run";
      runButton.title = "Add prompt and start execution";
    }

    // Queue button stays constant
    const queueButton = document.getElementById("btn-editor-queue");
    queueButton.textContent = "Queue";
    queueButton.title = "Add prompt to end of queue";
  }
  ```

- [x] Call `updateEditorButtons()` on state changes (STATE_UPDATE message)
- [x] Test: Verify button text changes when workflow starts/stops
- [x] Test: Verify position behavior in all states

### Phase 3: New Workflow Checkbox

- [x] Add checkbox to HTML (dashboard.html): ✅
- [x] Add CSS styling for checkbox (dashboard.css): ✅
- [x] Implement visibility/enabled logic with tooltips: ✅
  - Hidden when no workflow
  - Disabled with tooltip when running or new/empty
  - Enabled with descriptive tooltip otherwise
- [x] Call `updateNewWorkflowCheckbox()` on state changes: ✅
- [x] Update `executePrompt()` to read checkbox: ✅
- [x] Update `FlightPathManager.executeEphemeralPrompt()` - `forceNewWorkflow` parameter implemented at line 1245
- [x] Update `FlightPathDashboardProvider.handleExecutePrompt()` - passes `forceNewWorkflow` at line 856-864
- [x] Test: All checkbox states and behaviors

### Phase 4: Integration Testing

- [x] Test: Queue button on completed workflow (stays STOPPED)
- [x] Test: Run button on completed workflow (resumes)
- [x] Test: Queue appends to end when running
- [x] Test: Run appends next when running
- [x] Test: New Workflow checkbox hidden when no workflow
- [x] Test: New Workflow checkbox disabled when running
- [x] Test: New Workflow checkbox creates new workflow
- [x] Test: Setting persists across reloads
- [x] Test: All edge cases (paused, stopped, empty queue, etc.)

## Edge Cases

### 1. Checkbox checked during running

**Solution:** Checkbox is disabled when running (can't check it)

### 2. User checks checkbox, then starts execution from header Run button

**Behavior:** Checkbox only affects editor Queue/Run buttons, not header buttons

### 3. Queue Next position with only 1 prompt

**Behavior:** "next" = index 1, "end" = index 1 (same result, no issue)
/Run Next when running 3. ✅ Button text dynamically reflects behavior (Run → Run Next when running) 4. ✅ Users can branch to new workflow without manual file creation 5. ✅ Checkbox state is intuitive and discoverable
6

## Success Metrics

1. ✅ No duplicate/redundant button behavior in any state
2. ✅ Clear differentiation between Queue (end) and Run (next) when running
3. ✅ Users can branch to new workflow without manual file creation
4. ✅ Checkbox state is intuitive and discoverable
5. ✅ All button IDs match their semantic meaning

## Future Enhancements

- **Keyboard shortcuts**: Cmd/Ctrl+Enter for Run, Cmd/Ctrl+Shift+Enter for Queue
- **Visual feedback**: Show insertion position preview when hovering Run (next)
- **Batch operations**: Select multiple prompts and move to new workflow
- **Template-based branching**: "New workflow from template" in checkbox dropdown

## References

- Original Queue/Run mental model discussion (this session)
- Completed queue fix: `PromptQueue.ts` lines 973-989
- Dashboard constants: `src/types/DashboardConstants.ts`
- FlightPath manager: `src/flightpath/FlightPathManager.ts`
- Dashboard UI: `src/ui/webview/dashboard.html`, `dashboard.js`
