# Queue and Run Button Redesign

**Status:** Planning  
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

- `flightpath.createNewWorkflowFromEditor` (boolean, default: false)
- Persists user's preference for checkbox default state
- Checkbox state syncs with setting on load
- Checkbox change updates setting

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

- [ ] Rename `btn-editor-add` → `btn-editor-queue` in HTML
- [ ] Update all references in dashboard.js
- [ ] Rename `btn-editor-send` → `btn-editor-run` in HTML
- [ ] Update all references in dashboard.js
- [ ] Test: Verify buttons still work

### Phase 2: Queue/Run Differentiation

- [ ] Add `position` parameter to `ACTION_TYPES` in DashboardConstants.ts
  ```typescript
  export const ACTION_TYPES = {
    QUEUE: "queue", // Append to end
    QUEUE_NEXT: "queueNext", // Append after current (new)
    RUN: "run", // Append + ensure runs
    RUN_NEXT: "runNext", // Append next + ensure runs (new)
  } as const;
  ```
- [ ] Update dashboard.js `executePrompt()` to send position based on state:
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
- [ ] Update `FlightPathManager.executeEphemeralPrompt()` to handle positions:
  - `QUEUE`: Always `position: "end"`
  - `QUEUE_NEXT`: Always `position: "next"`
  - `RUN`: `position: "end"` (except when running)
  - `RUN_NEXT`: `position: "next"` + ensure execution
- [ ] Update button text and tooltips dynamically:
  - **Queue button** (always):
    - Text: "Queue"
    - Tooltip: "Add prompt to end of queue"
  - **Run button** (not running):
    - Text: "Run"
    - Tooltip: "Add prompt and start execution"
  - **Run button** (running):
    - Text: "Run Next"
    - Tooltip: "Add prompt next in queue (high priority)"
- [ ] Implement dynamic button text in dashboard.js:
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
- [ ] Call `updateEditorButtons()` on state changes (STATE_UPDATE message)
- [ ] Test: Verify button text changes when workflow starts/stops
- [ ] Test: Verify position behavior in all states

### Phase 3: New Workflow Checkbox

- [ ] Add setting to package.json:
  ```json
  "flightpath.createNewWorkflowFromEditor": {
    "type": "boolean",
    "default": false,
    "description": "Default state for 'New Workflow' checkbox in prompt editor"
  }
  ```
- [ ] Add checkbox to HTML (dashboard.html):
  ```html
  <div class="editor-actions">
    <label id="new-workflow-toggle" class="new-workflow-toggle" hidden>
      <input type="checkbox" id="new-workflow-checkbox" />
      <span>New Workflow</span>
    </label>
    <button id="btn-editor-queue">...</button>
    <button id="btn-editor-run">...</button>
  </div>
  ```
- [ ] Add CSS styling for checkbox (dashboard.css):

  ```css
  .new-workflow-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    margin-right: 8px;
  }

  .new-workflow-toggle[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  ```

- [ ] Add checkbox state to dashboard.js:
  ```javascript
  let newWorkflowCheckbox = {
    element: document.getElementById("new-workflow-checkbox"),
    toggle: document.getElementById("new-workflow-toggle"),
    defaultChecked: false, // from settings
  };
  ```
- [ ] Implement visibility/enabled logic:
  ```javascript
  function updateNewWorkflowCheckbox() {
    const hasWorkflow = state.prompts.length > 0;
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isNew = !editorState.hasActiveQueue || state.prompts.length === 0;

    if (!hasWorkflow) {
      // Hidden when no workflow
      newWorkflowCheckbox.toggle.hidden = true;
    } else if (isRunning || isNew) {
      // Visible but disabled
      newWorkflowCheckbox.toggle.hidden = false;
      newWorkflowCheckbox.element.disabled = true;
      newWorkflowCheckbox.element.checked = false;
    } else {
      // Enabled
      newWorkflowCheckbox.toggle.hidden = false;
      newWorkflowCheckbox.element.disabled = false;
    }
  }
  ```
- [ ] Call `updateNewWorkflowCheckbox()` on state changes
- [ ] Update `executePrompt()` to read checkbox:
  ```javascript
  function executePrompt(action) {
    const forceNewWorkflow = newWorkflowCheckbox.element.checked;

    vscode.postMessage({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      action,
      forceNewWorkflow, // NEW parameter
      // ...
    });
  }
  ```
- [ ] Load setting on INIT:
  ```javascript
  function handleInit(message) {
    newWorkflowCheckbox.defaultChecked =
      message.settings.createNewWorkflowFromEditor;
    newWorkflowCheckbox.element.checked = newWorkflowCheckbox.defaultChecked;
  }
  ```
- [ ] Save setting on checkbox change:
  ```javascript
  newWorkflowCheckbox.element.addEventListener("change", () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_SETTING,
      setting: "createNewWorkflowFromEditor",
      value: newWorkflowCheckbox.element.checked,
    });
  });
  ```
- [ ] Update `FlightPathManager.executeEphemeralPrompt()`:
  ```typescript
  async executeEphemeralPrompt(
    text: string,
    properties: any,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow: boolean = false // NEW parameter
  ): Promise<void> {
    // If forceNewWorkflow is true, always create new workflow
    // regardless of current state

    if (forceNewWorkflow) {
      // Clear current workflow
      this.clearWorkflow();
      // Then proceed with normal logic (will create new)
    }

    // ... rest of existing logic
  }
  ```
- [ ] Update `FlightPathDashboardProvider.handleExecutePrompt()`:
  ```typescript
  private async handleExecutePrompt(message: any): Promise<void> {
    const { text, properties, action, promptName, forceNewWorkflow } = message;

    await this.flightPathManager.executeEphemeralPrompt(
      text,
      properties,
      action,
      promptName,
      forceNewWorkflow // Pass through
    );
  }
  ```
- [ ] Test: All checkbox states and behaviors

### Phase 4: Integration Testing

- [ ] Test: Queue button on completed workflow (stays STOPPED)
- [ ] Test: Run button on completed workflow (resumes)
- [ ] Test: Queue appends to end when running
- [ ] Test: Run appends next when running
- [ ] Test: New Workflow checkbox hidden when no workflow
- [ ] Test: New Workflow checkbox disabled when running
- [ ] Test: New Workflow checkbox creates new workflow
- [ ] Test: Setting persists across reloads
- [ ] Test: All edge cases (paused, stopped, empty queue, etc.)

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
