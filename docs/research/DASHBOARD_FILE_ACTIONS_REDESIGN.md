# Dashboard File Actions Redesign

**Last Updated**: December 29, 2024
**Status**: ✅ Approved - Ready for Implementation
**Related**:
- [QUEUE_APPEND_FEATURE.md](../QUEUE_APPEND_FEATURE.md) - Working file system
- [IN_PANEL_PROMPT_EDITOR.md](IN_PANEL_PROMPT_EDITOR.md) - Built-in text editor plans

## Approved Decisions

- **Button layout**: `[Load] [Append] | [New Workflow]` (Load and Append grouped)
- **Append button state**: Always visible, disabled when no queue loaded
- **Deployment timing**: Deploy now (independent of in-panel editor)
- **Command cleanup**: Keep commands for power users (accessible via Command Palette)
- **Header redesign**: Move workflow name next to execution state for cleaner layout

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current State Analysis](#current-state-analysis)
3. [Proposed Changes](#proposed-changes)
4. [Design Rationale](#design-rationale)
5. [User Experience Flows](#user-experience-flows)
6. [Implementation Plan](#implementation-plan)
7. [Migration Considerations](#migration-considerations)
8. [Open Questions](#open-questions)

---

## Problem Statement

The current dashboard file action buttons (Select, Edit, New Prompt, New Workflow) were designed before the working file system was implemented. They now create confusion and don't align with the current architecture.

### Core Issues

1. **Select button is redundant**
   - Does the same thing as **"Load in FlightPath"** context menu
   - Opens a file picker to load prompts
   - No clear advantage over right-click → Load

2. **Edit button is misleading**
   - Opens the original prompt file in VS Code editor
   - Users might expect edits to affect the running queue
   - **Reality**: Edits to original file don't modify the working file
   - Queue runs from `.flightpath/.queue/<workflow>.flightpath.json` (working file)

3. **New Prompt button will become redundant**
   - Currently creates a `.prompt.md` file in `.flightpath/prompts/`
   - Planned in-panel text editor (see IN_PANEL_PROMPT_EDITOR.md) will handle this better
   - In-panel editor allows immediate editing without leaving dashboard

4. **Missing "Append" button**
   - Queue append is a key feature (see QUEUE_APPEND_FEATURE.md)
   - Currently only accessible via context menu (**"Queue with FlightPath"**)
   - No dashboard button for this frequently-used action

---

## Current State Analysis

### Existing Buttons (dashboard.html:18-54)

```html
<div id="file-info">
  <span id="file-name">No file selected</span>
  <div class="file-buttons">
    <!-- Current file actions -->
    <button id="select-file" class="btn-secondary btn-small"
            title="Select a different prompt file">
      Select
    </button>
    <button id="edit-file" class="btn-secondary btn-small"
            title="Open current prompt file in editor" disabled>
      Edit
    </button>

    <span class="button-divider"></span>

    <!-- Creation actions -->
    <button id="new-prompt" class="btn-secondary btn-small"
            title="Create new draft prompt (.prompt.md)">
      New Prompt
    </button>
    <button id="new-workflow" class="btn-secondary btn-small"
            title="Create workflow from template">
      New Workflow
    </button>
  </div>
</div>
```

### Button Functionality Mapping

| Button | Message Type | Command | Behavior |
|--------|--------------|---------|----------|
| **Select** | `SELECT_FILE` | `flightpath.selectPromptFile` | Shows file picker, loads selected prompt file |
| **Edit** | `EDIT_FILE` | `flightpath.editCurrentPromptFile` | Opens original prompt file in VS Code editor |
| **New Prompt** | `NEW_PROMPT` | `flightpath.createDraftPrompt` | Creates `.prompt.md` in `.flightpath/prompts/` |
| **New Workflow** | `NEW_WORKFLOW` | Opens modal | Shows template selection modal |

### Context Menu Commands (for comparison)

| Command | Code | Behavior |
|---------|------|----------|
| **Run with FlightPath** | `flightpath.runFromContext` | Loads and executes file immediately |
| **Load in FlightPath** | `flightpath.loadFromContext` | Loads file without executing |
| **Queue with FlightPath** | `flightpath.queueFromContext` | Appends to end of queue (`position: "end"`) |
| **Queue Next** | `flightpath.queueNextFromContext` | Inserts after current (`position: "next"`) |

### Working File System Context

**Key architectural change** (from QUEUE_APPEND_FEATURE.md):

```
Original File:               Working File:
.flightpath/                .flightpath/.queue/
  workflow.flightpath.json    workflow-2024-12-29T10-30-00.flightpath.json
  (user edits here)           (runtime state, queue modifications)
        ↓                                ↓
   Read-only reference          Source of truth for execution
```

**Implications**:
- **Edit button** opens original file, but queue runs from working file
- **Select button** creates a new working file from selected original file
- **Append operations** modify the working file, not the original

---

## Proposed Changes

### New Header Layout

The header will be completely redesigned to align with the working file architecture:

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Load] [Append] | [New Workflow]    workflow123 - RUNNING    [▶][⏸][⏹]  │
└──────────────────────────────────────────────────────────────────────┘
```

**Key changes**:
- **Buttons on left**: Action buttons (Load, Append, New Workflow) grouped on the left side
- **Workflow status center**: Combined workflow name + execution state in the middle
- **Run controls on right**: Run/Pause/Stop buttons remain on the right

**Rationale**:
- Removes redundant "File:" label (working file vs. original file confusion)
- Workflow name is the conceptual identifier, not the file path
- More horizontal space for full workflow names
- Cleaner visual hierarchy (actions → status → controls)

### Button Definitions

#### 1. **Load** (replaces Select)

**Purpose**: Load a prompt file as the new working queue

**Behavior**:
- Shows file picker with `.flightpath.json`, `.flightpath.yaml`, `.prompt.md` files
- Creates new working file in `.flightpath/.queue/`
- Replaces current queue (if any)
- **Disabled when running/paused** (prevents accidental queue replacement)
- Enabled when idle, completed, or error states

**Icon**: Codicon `$(folder-opened)` or no icon (text only like current buttons)

**Message Type**: `SELECT_FILE` (reuse existing)

**Command**: `flightpath.selectPromptFile` (existing logic is correct)

**State logic**:
```javascript
// Disable Load during active execution
if (state === RUNNING || state === PAUSED) {
  loadBtn.disabled = true;
  loadBtn.title = "Cannot load while workflow is running (stop first)";
} else {
  loadBtn.disabled = false;
  loadBtn.title = "Load a prompt file to start a new workflow";
}
```

#### 2. **Append** (new button)

**Purpose**: Append prompts from a file to the current queue

**Behavior**:
- Shows file picker (same file types as Load)
- Appends prompts to **end of queue** (`position: "end"`)
- **Always uses "end" position** (not "next") - context menu still has both options
- Disabled only when no queue is loaded
- **Stays enabled during execution** (safe to append to running queue)
- Shows notification: "Added 3 prompts to queue"

**Icon**: Codicon `$(add)` or no icon (text only like current buttons)

**Message Type**: `APPEND_FILE` (new)

**Command**: `flightpath.appendFromDashboard` (new command, calls `appendFromFile(path, "end")`)

**State logic**:
```javascript
// Only disabled when no queue exists
const hasQueue = state.fileName !== null;
appendBtn.disabled = !hasQueue;

if (!hasQueue) {
  appendBtn.title = "No workflow loaded (load a file first)";
} else {
  appendBtn.title = "Append prompts from a file to the current queue";
}
```

**Note**: Context menu provides both append options:
- "Queue with FlightPath" → `position: "end"` (same as dashboard button)
- "Queue Next with FlightPath" → `position: "next"` (insert after current)

#### 3. **New Workflow** (keep as-is)

**Purpose**: Create workflow from template

**Behavior**: Opens existing template modal (no changes)

**Icon**: No icon (text only, consistent with other buttons)

**Message Type**: `NEW_WORKFLOW` (existing)

### Removed Buttons

#### **Edit** (removed)

**Reason**: Misleading, edits don't affect running queue

**Alternative**:
- In-panel text editor (see IN_PANEL_PROMPT_EDITOR.md) for editing prompts
- Users can still open original file via Explorer if needed
- Working file is the source of truth, so editing original file is rarely useful

#### **New Prompt** (removed)

**Reason**: Redundant with in-panel editor

**Alternative**:
- In-panel text editor with "Create New Prompt" mode
- Seamless experience without leaving dashboard
- Can immediately queue/run the created prompt

### Visual Layout Comparison

**Before (Current)**:
```
┌────────────────────────────────────────────────────────────────────┐
│  workflow.flightpath.json                                          │
│  [Select] [Edit] | [New Prompt] [New Workflow]       IDLE  [▶][⏸][⏹] │
└────────────────────────────────────────────────────────────────────┘
```

**After (Proposed)**:
```
┌────────────────────────────────────────────────────────────────────┐
│  [Load] [Append] | [New Workflow]    workflow - IDLE    [▶][⏸][⏹]  │
└────────────────────────────────────────────────────────────────────┘
```

**State examples**:

**Idle (no workflow loaded)**:
```
│  [Load] [Append*] | [New Workflow]    No workflow loaded    [▶][⏸*][⏹*]  │
```
*Append/Pause/Stop buttons disabled (grayed out)

**Idle (workflow loaded, not started)**:
```
│  [Load] [Append] | [New Workflow]    bugfix-auth - IDLE    [▶][⏸*][⏹*]  │
```

**Running**:
```
│  [Load*] [Append] | [New Workflow]    bugfix-auth - RUNNING    [▶*][⏸][⏹]  │
```
*Load/Run buttons disabled (grayed out)

**Paused**:
```
│  [Load*] [Append] | [New Workflow]    bugfix-auth - PAUSED    [▶][⏸*][⏹]  │
```
*Load/Pause buttons disabled (grayed out)

**Completed**:
```
│  [Load] [Append] | [New Workflow]    implement-feature - COMPLETED    [▶][⏸*][⏹*]  │
```
*Pause/Stop buttons disabled (grayed out)

### Button State Matrix

| State | Load Button | Append Button | Run Button | Pause Button | Stop Button |
|-------|-------------|---------------|------------|--------------|-------------|
| **No workflow** | Enabled | Disabled | Disabled | Disabled | Disabled |
| **IDLE** | Enabled | Enabled | Enabled | Disabled | Disabled |
| **RUNNING** | Disabled | Enabled | Disabled | Enabled | Enabled |
| **PAUSED** | Disabled | Enabled | Enabled (Resume) | Disabled | Enabled |
| **COMPLETED** | Enabled | Enabled | Enabled (Re-run) | Disabled | Disabled |
| **ERROR** | Enabled | Enabled | Enabled (Retry) | Disabled | Disabled |

**Key insights**:
- **Load disabled during execution** (RUNNING/PAUSED) prevents accidental queue replacement
- **Append always enabled when queue exists** (even during execution) - safe to extend running queue
- **Execution state hidden when no workflow** prevents "No workflow loaded - IDLE" redundancy

---

## Design Rationale

### Why Load instead of Select?

**User mental model alignment**:
- "Load" implies bringing file content into the application
- "Select" is ambiguous (select for what?)
- Matches context menu language (**"Load in FlightPath"**)

**Consistency**:
- Context menu: "Load in FlightPath"
- Dashboard button: "Load"
- Same terminology across UI

### Why Add Append Button?

**Feature discoverability**:
- Queue append is a **core feature** (see QUEUE_APPEND_FEATURE.md)
- Currently hidden in context menu
- Power users need quick access from dashboard

**Workflow efficiency**:
- Common pattern: Load base workflow → Append follow-up tasks
- Reduces right-click → find file → append steps
- Complements Load button (pair of actions)

### Why Remove Edit Button?

**Prevents user confusion**:
- Users expect edits to affect the running queue
- Working file architecture makes this expectation invalid
- Better to remove than to explain the discrepancy

**Alternative exists**:
- In-panel editor allows **actual** prompt editing (modifies working file)
- Users can still open original file via Explorer if needed

**Edge cases**:
- If user wants to edit template/original file, they can use Explorer
- Most users want to edit the **current queue**, not the original file

### Why Remove New Prompt Button?

**Better UX with in-panel editor**:
- In-panel editor: Type → Save (stays in dashboard)
- Current flow: Click → Open file → Type → Save → Switch back to dashboard

**Reduces button clutter**:
- 4 buttons → 3 buttons (cleaner UI)
- Emphasizes core actions (Load, Append, New Workflow)

### Why Keep New Workflow?

**Template system is valuable**:
- Templates with `{placeholder}` variables are powerful
- No overlap with in-panel editor (single prompts vs. structured workflows)
- Workflow creation is distinct from prompt editing

---

## User Experience Flows

### Flow 1: Starting a New Workflow

**Before**:
1. Click **Select**
2. Choose `analyze-code.flightpath.json`
3. Click **▶ Run**

**After**:
1. Click **Load**
2. Choose `analyze-code.flightpath.json`
3. Click **▶ Run**

**Change**: Minimal (button rename only)

### Flow 2: Extending an Active Workflow

**Before**:
1. Workflow running (Step 2 of 3)
2. Right-click `implement-fixes.flightpath.json` in Explorer
3. Select **"Queue with FlightPath"**
4. Queue extends (now Step 2 of 8)

**After (Option A: Dashboard button)**:
1. Workflow running (Step 2 of 3)
2. Click **Append** in dashboard
3. Choose `implement-fixes.flightpath.json`
4. Queue extends (now Step 2 of 8)

**After (Option B: Context menu still works)**:
1. Same as before (context menu unchanged)

**Change**: Adds dashboard-based workflow (context menu still available)

### Flow 3: Creating a Quick Prompt

**Before**:
1. Click **New Prompt**
2. VS Code opens new `.prompt.md` file
3. Type prompt text
4. Save file
5. Right-click file → **"Run with FlightPath"**

**After (with in-panel editor)**:
1. *(In-panel editor button - not part of this proposal)*
2. Type prompt text in dashboard panel
3. Click **Save & Run**
4. Prompt executes immediately

**Change**: Streamlined, no file system interaction needed

### Flow 4: Creating a Workflow from Template

**Before**:
1. Click **New Workflow**
2. Select template
3. Fill variables
4. Enter filename
5. Click **Create & Run**

**After**:
1. Click **New Workflow**
2. *(Same as before)*

**Change**: None (no changes to this flow)

### Flow 5: Editing a Prompt (Current Confusion)

**Before** (current, confusing behavior):
1. Load `workflow.flightpath.json`
2. Click **▶ Run** (creates working file)
3. Click **Edit** (opens original file)
4. Modify prompt text
5. Save original file
6. **Result**: Queue doesn't change! (working file unchanged)

**After** (with in-panel editor):
1. Load `workflow.flightpath.json`
2. Click **▶ Run** (creates working file)
3. Click **Edit** icon on prompt item (in-panel editor)
4. Modify prompt text
5. Click **Save**
6. **Result**: Queue updates! (working file modified)

**Change**: Correct behavior, no user confusion

---

## Implementation Plan

### Code Examples

#### HTML Structure (dashboard.html)

**Before**:
```html
<div id="header">
  <div id="file-info">
    <span id="file-name">No file selected</span>
    <div class="file-buttons">
      <button id="select-file" class="btn-secondary btn-small"
              title="Select a different prompt file">
        Select
      </button>
      <button id="edit-file" class="btn-secondary btn-small"
              title="Open current prompt file in editor" disabled>
        Edit
      </button>
      <span class="button-divider"></span>
      <button id="new-prompt" class="btn-secondary btn-small"
              title="Create new draft prompt (.prompt.md)">
        New Prompt
      </button>
      <button id="new-workflow" class="btn-secondary btn-small"
              title="Create workflow from template">
        New Workflow
      </button>
    </div>
  </div>
  <div id="execution-state" class="execution-state-idle">Idle</div>
  <div id="controls">
    <button id="btn-run" class="btn-primary" title="Run">▶</button>
    <button id="btn-pause" class="btn-secondary" title="Pause" disabled>⏸</button>
    <button id="btn-stop" class="btn-secondary" title="Stop" disabled>⏹</button>
  </div>
</div>
```

**After**:
```html
<div id="header">
  <div id="action-buttons">
    <button id="load-file" class="btn-secondary btn-small"
            title="Load a prompt file to start a new workflow">
      Load
    </button>
    <button id="append-file" class="btn-secondary btn-small"
            title="Append prompts from a file to the current queue" disabled>
      Append
    </button>
    <span class="button-divider"></span>
    <button id="new-workflow" class="btn-secondary btn-small"
            title="Create workflow from template">
      New Workflow
    </button>
  </div>

  <div id="workflow-status">
    <span id="workflow-name">No workflow loaded</span>
    <span id="status-separator" class="status-separator" style="display: none;"> - </span>
    <span id="execution-state" class="execution-state-idle" style="display: none;">Idle</span>
  </div>

  <div id="controls">
    <button id="btn-run" class="btn-primary" title="Run">▶</button>
    <button id="btn-pause" class="btn-secondary" title="Pause" disabled>⏸</button>
    <button id="btn-stop" class="btn-secondary" title="Stop" disabled>⏹</button>
  </div>
</div>
```

#### CSS Changes (dashboard.css)

**Update `#header` layout**:
```css
#header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--border-color);
  gap: var(--spacing-md);
}

#action-buttons {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0; /* Don't shrink buttons */
}

#workflow-status {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex: 1; /* Take remaining space */
  justify-content: center;
  min-width: 0; /* Allow text overflow */
}

#workflow-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--vscode-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px; /* Limit width for very long names */
}

.status-separator {
  color: var(--vscode-descriptionForeground);
  opacity: 0.6;
}

#execution-state {
  font-size: 12px;
  white-space: nowrap; /* Don't wrap state text */
}

#controls {
  display: flex;
  gap: var(--spacing-sm);
  flex-shrink: 0; /* Don't shrink control buttons */
}
```

#### JavaScript Changes (dashboard.js)

**Update elements object**:
```javascript
const elements = {
  // OLD: fileName: document.getElementById("file-name"),
  // OLD: selectFileBtn: document.getElementById("select-file"),
  // OLD: editFileBtn: document.getElementById("edit-file"),
  // OLD: newPromptBtn: document.getElementById("new-prompt"),

  // NEW:
  workflowName: document.getElementById("workflow-name"),
  statusSeparator: document.getElementById("status-separator"),
  executionState: document.getElementById("execution-state"),
  loadFileBtn: document.getElementById("load-file"),
  appendFileBtn: document.getElementById("append-file"),
  newWorkflowBtn: document.getElementById("new-workflow"),

  runBtn: document.getElementById("btn-run"),
  pauseBtn: document.getElementById("btn-pause"),
  stopBtn: document.getElementById("btn-stop"),
  // ... rest unchanged
};
```

**Update state handlers**:
```javascript
// Helper: Extract workflow name from file path
function getWorkflowName(filePath) {
  if (!filePath) return "No workflow loaded";
  const fileName = filePath.split(/[/\\]/).pop(); // Get last segment
  return fileName.replace(/\.(flightpath\.(json|yaml|yml)|prompt\.md)$/, ""); // Remove extension
}

// Update workflow name and state display
function updateWorkflowStatus(filePath, executionState) {
  if (!filePath) {
    // No workflow loaded - hide state separator and execution state
    elements.workflowName.textContent = "No workflow loaded";
    elements.statusSeparator.style.display = "none";
    elements.executionState.style.display = "none";
  } else {
    // Workflow loaded - show name, separator, and state
    elements.workflowName.textContent = getWorkflowName(filePath);
    elements.statusSeparator.style.display = "inline";
    elements.executionState.style.display = "inline";
    elements.executionState.textContent = executionState;
  }
}

// Update Load button state (disable when running/paused)
function updateLoadButtonState() {
  if (state.executionState === EXECUTION_STATES.RUNNING ||
      state.executionState === EXECUTION_STATES.PAUSED) {
    elements.loadFileBtn.disabled = true;
    elements.loadFileBtn.title = "Cannot load while workflow is running (stop first)";
  } else {
    elements.loadFileBtn.disabled = false;
    elements.loadFileBtn.title = "Load a prompt file to start a new workflow";
  }
}

// Update Append button state (disable when no queue)
function updateAppendButtonState() {
  const hasQueue = state.fileName !== null;
  elements.appendFileBtn.disabled = !hasQueue;

  if (!hasQueue) {
    elements.appendFileBtn.title = "No workflow loaded (load a file first)";
  } else {
    elements.appendFileBtn.title = "Append prompts from a file to the current queue";
  }
}

// Call in state handlers
function handleFileLoaded(message) {
  state.fileName = message.fileName;
  state.executionState = EXECUTION_STATES.IDLE; // File loaded but not running yet
  updateWorkflowStatus(message.fileName, state.executionState);
  updateLoadButtonState();
  updateAppendButtonState();
  // ... existing code
}

function handleExecutionStarted(message) {
  state.fileName = message.fileName;
  state.executionState = EXECUTION_STATES.RUNNING;
  updateWorkflowStatus(message.fileName, state.executionState);
  updateLoadButtonState(); // Disable Load during execution
  updateAppendButtonState();
  // ... existing code
}

function handleExecutionPaused() {
  state.executionState = EXECUTION_STATES.PAUSED;
  updateWorkflowStatus(state.fileName, state.executionState);
  updateLoadButtonState(); // Keep Load disabled when paused
  // ... existing code
}

function handleExecutionResumed() {
  state.executionState = EXECUTION_STATES.RUNNING;
  updateWorkflowStatus(state.fileName, state.executionState);
  updateLoadButtonState();
  // ... existing code
}

function handleExecutionCompleted() {
  state.executionState = EXECUTION_STATES.COMPLETED;
  updateWorkflowStatus(state.fileName, state.executionState);
  updateLoadButtonState(); // Re-enable Load after completion
  updateAppendButtonState(); // Keep Append enabled
  // ... existing code
}

function handleExecutionStopped() {
  state.executionState = EXECUTION_STATES.STOPPED;
  updateWorkflowStatus(state.fileName, state.executionState);
  updateLoadButtonState(); // Re-enable Load after stop
  // ... existing code
}
```

**Event listeners**:
```javascript
// OLD: elements.selectFileBtn.addEventListener(...)
// NEW:
elements.loadFileBtn.addEventListener("click", () => {
  vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE }); // Reuse existing command
});

elements.appendFileBtn.addEventListener("click", () => {
  vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
});

// Keep existing:
elements.newWorkflowBtn.addEventListener("click", () => {
  vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
});
```

---

### Phase 1: Remove Buttons (Low Risk)

**Goal**: Simplify UI, remove confusing buttons

**Changes**:
1. Remove **Edit** button from `dashboard.html`
2. Remove **New Prompt** button from `dashboard.html`
3. Remove event handlers in `dashboard.js`
4. Remove `EDIT_FILE` and `NEW_PROMPT` from message map (or mark deprecated)

**Testing**:
- Verify dashboard loads without errors
- Verify no broken references to removed elements

**Migration**: None needed (removing features, not changing behavior)

### Phase 2: Rename Select → Load (Low Risk)

**Goal**: Align terminology with context menu

**Changes**:
1. Update button text: `Select` → `Load`
2. Update tooltip: "Select a different prompt file" → "Load a prompt file"
3. Update button ID: `select-file` → `load-file` (or keep for backward compat)
4. Update element reference in `dashboard.js`

**Testing**:
- Verify Load button triggers file picker
- Verify file loads correctly
- Verify tooltip shows correct text

**Migration**: None needed (cosmetic change)

### Phase 3: Add Append Button (Medium Risk)

**Goal**: Expose append functionality in dashboard

**Changes**:

**A. Backend (extension.ts)**:
```typescript
// New command: Append From Dashboard
const appendFromDashboardCommand = vscode.commands.registerCommand(
  "flightpath.appendFromDashboard",
  async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }

    // Show file picker (same logic as selectPromptFile)
    const promptFiles = await vscode.workspace.findFiles(
      "**/*.{flightpath.json,flightpath.yaml,flightpath.yml,prompt.md}",
      "**/node_modules/**"
    );

    const items = promptFiles.map(file => ({
      label: path.basename(file.fsPath),
      description: path.dirname(file.fsPath),
      uri: file
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a prompt file to append to queue"
    });

    if (selected) {
      await flightPathManager.appendFromFile(selected.uri.fsPath, "end");
    }
  }
);

// Register command
context.subscriptions.push(appendFromDashboardCommand);
```

**B. Message Type (DashboardConstants.ts)**:
```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  APPEND_FILE: "appendFile",
} as const;
```

**C. Dashboard Provider (FlightPathDashboardProvider.ts)**:
```typescript
private readonly messageCommandMap = new Map<string, string>([
  // ... existing mappings ...
  [MESSAGE_TYPES.APPEND_FILE, "flightpath.appendFromDashboard"],
]);
```

**D. Dashboard HTML (dashboard.html)**:
```html
<button
  id="append-file"
  class="btn-secondary btn-small"
  title="Append prompts from a file to the current queue"
  disabled
>
  Append
</button>
```

**E. Dashboard JS (dashboard.js)**:
```javascript
// Add to elements object
elements.appendFileBtn = document.getElementById("append-file");

// Add event listener
elements.appendFileBtn.addEventListener("click", () => {
  vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
});

// Update button state based on queue status
function updateAppendButtonState() {
  const hasQueue = state.fileName !== null;
  elements.appendFileBtn.disabled = !hasQueue;
}

// Call in relevant state update handlers
function handleExecutionStarted(message) {
  // ... existing code ...
  updateAppendButtonState();
}

function handleFileLoaded(message) {
  // ... existing code ...
  updateAppendButtonState();
}
```

**Testing**:
- Load a workflow, verify Append button becomes enabled
- Click Append, verify file picker appears
- Select file, verify prompts append to queue
- Verify dashboard shows updated prompt count
- Verify Append button disabled when no queue loaded

**Migration**: None needed (new feature)

### Phase 4: Update Documentation

**Goal**: Reflect UI changes in all docs

**Changes**:
1. Update screenshots in README.md (if any)
2. Update QUEUE_APPEND_FEATURE.md references to dashboard buttons
3. Update IN_PANEL_PROMPT_EDITOR.md (note removal of New Prompt button)
4. Update any tutorial content

### Phase 5: Polish (Optional)

**Goal**: Enhance UX with visual feedback

**Enhancements**:
- Add icons to buttons (📂 Load, ➕ Append, ✨ New Workflow)
- Add loading spinner when file picker is open
- Add success toast: "Loaded 5 prompts from workflow.flightpath.json"
- Add success toast: "Appended 3 prompts to queue"
- Add keyboard shortcuts (Ctrl+L for Load, Ctrl+A for Append)

---

## Migration Considerations

### Breaking Changes

**None** - This is a UI-only change with no API/file format changes.

### User Impact

**Low** - Removed buttons have better alternatives:
- **Edit** → In-panel editor (planned)
- **New Prompt** → In-panel editor (planned)

**Positive** - New Append button improves discoverability

### Rollback Plan

If users complain about missing buttons:
1. Revert HTML changes (restore Edit/New Prompt buttons)
2. Revert JS event handlers
3. Keep Append button (improvement regardless)

### Deprecation Timeline

Since extension is **pre-release** (not yet v1.0):
- **No deprecation period needed**
- Can make breaking UI changes freely
- Document changes in CHANGELOG.md

---

## Resolved Decisions

All key design questions have been approved:

### ✅ Decision 1: Append Button Position

**Approved**: `[Load] [Append] | [New Workflow]` (Load and Append grouped)

**Rationale**: Load and Append are semantically paired - both work with existing files (read vs. merge)

### ✅ Decision 2: Append Button State

**Approved**: Always show button, disable when no queue loaded

**Rationale**: Consistent with Run/Pause/Stop buttons, users learn the button exists

### ✅ Decision 3: Header Layout

**Approved**: `[Buttons] → [Workflow Name - State] → [Controls]`

**Rationale**:
- Removes confusing "File:" label (working file ≠ original file)
- Workflow name is the conceptual identifier
- More space for full workflow names
- Cleaner visual hierarchy

### ✅ Decision 4: Deployment Timing

**Approved**: Deploy now (independent of in-panel editor)

**Rationale**: Changes provide immediate value and are independent of future features

### ✅ Decision 5: Command Cleanup

**Approved**: Keep commands for power users (accessible via Command Palette)

**Rationale**: Power users can still access via Ctrl+Shift+P, removes UI clutter only

## Future Enhancements (Deferred)

These enhancements were considered but deferred as "not needed for MVP, can add later if requested":

### Load Button Multi-Select

Allow loading multiple files at once (merged into one queue).

**Use case**: Combine 3 modular workflows into one queue at startup

**Status**: Deferred - Can add later if users request it

### Append Next Button

Add second append button with `position: "next"` (insert after current prompt).

**Status**: Deferred - Context menu already has "Queue Next", dashboard doesn't need both buttons

### Working File Path Tooltip

Show working file path on hover over workflow name.

**Example tooltip**: `.flightpath/.queue/workflow-2024-12-29T10-30-00.flightpath.json`

**Status**: Nice to have - Can add during Phase 5 (Polish)

---

## Success Metrics

### Adoption Metrics

- **Append button usage**: Track `MESSAGE_TYPES.APPEND_FILE` invocations
- **Load button usage**: Track `MESSAGE_TYPES.SELECT_FILE` invocations
- **Context menu usage**: Track `flightpath.queueFromContext` calls

**Goal**: Append button used at least 30% as often as Load button

### User Confusion Metrics

- **Edit command usage**: Track `flightpath.editCurrentPromptFile` calls (should decrease)
- **Support issues**: Monitor GitHub issues about "edits not taking effect"

**Goal**: Zero issues about edit button confusion after removal

### Migration Metrics

- **Rollback requests**: Track user requests to restore Edit/New Prompt buttons

**Goal**: Less than 5% of users request rollback

---

## Implementation Checklist

### Phase 1: Remove Buttons
- [ ] Remove Edit button HTML
- [ ] Remove New Prompt button HTML
- [ ] Remove Edit button event listener
- [ ] Remove New Prompt button event listener
- [ ] Remove `editFileBtn` from elements object
- [ ] Remove `newPromptBtn` from elements object
- [ ] Test dashboard loads without errors

### Phase 2: Redesign Header Layout
- [ ] **HTML Structure Changes** (dashboard.html):
  - [ ] Remove `#file-info` div wrapper
  - [ ] Create new `#action-buttons` div for Load/Append/New Workflow
  - [ ] Create new `#workflow-status` div for workflow name + execution state
  - [ ] Move execution state into `#workflow-status`
  - [ ] Update header flexbox layout (left → center → right)
- [ ] **JavaScript Changes** (dashboard.js):
  - [ ] Add `workflowName` element reference
  - [ ] Update `elements.fileName` → `elements.workflowName`
  - [ ] Update all state handlers to set workflow name (extract from file path)
  - [ ] Add separator logic between workflow name and state
  - [ ] Handle "No workflow loaded" when `state.fileName === null`
- [ ] **CSS Changes** (dashboard.css):
  - [ ] Update `#header` flexbox layout (space-between → three sections)
  - [ ] Add `#action-buttons` styles (grouped buttons on left)
  - [ ] Add `#workflow-status` styles (center alignment, text overflow handling)
  - [ ] Add `.status-separator` styles (dash between name and state)
  - [ ] Ensure responsive behavior (text truncation for long workflow names)
- [ ] **Test**:
  - [ ] Verify header layout matches design (buttons left, status center, controls right)
  - [ ] Test with short workflow names ("test")
  - [ ] Test with long workflow names ("implement-authentication-feature-with-tests")
  - [ ] Test "No workflow loaded" state display
  - [ ] Test all execution states (IDLE, RUNNING, PAUSED, COMPLETED, ERROR)

### Phase 3: Rename Select → Load & Add Append Button
- [ ] Update "Select" button text to "Load"
- [ ] Update button tooltip
- [ ] Update button ID: `select-file` → `load-file` (or keep for compat)
- [ ] Update element reference in JS

### Phase 4: Add Append Button Backend
- [ ] Add `APPEND_FILE` to DashboardConstants.ts
- [ ] Add `flightpath.appendFromDashboard` command to extension.ts
- [ ] Add command to message map in FlightPathDashboardProvider.ts
- [ ] Test command registration

### Phase 5: Add Append Button UI
- [ ] Add Append button HTML in `#action-buttons` div
- [ ] Add `appendFileBtn` to elements object
- [ ] Add event listener for Append button
- [ ] Add `updateAppendButtonState()` function
- [ ] Call `updateAppendButtonState()` on relevant events:
  - [ ] `handleExecutionStarted()`
  - [ ] `handleFileLoaded()`
  - [ ] `handleExecutionCompleted()`
  - [ ] `handleExecutionStopped()`
- [ ] Test Append button enabled/disabled correctly
- [ ] Test Append button triggers file picker
- [ ] Test appended prompts appear in queue
- [ ] Test button state transitions (idle → loaded → running → completed)

### Phase 6: Documentation
- [ ] Update README.md (if dashboard screenshots exist)
- [ ] Update QUEUE_APPEND_FEATURE.md (reference new Append button)
- [ ] Update CHANGELOG.md (document UI changes)
- [ ] Add/update dashboard screenshot

### Phase 7: Polish (Optional)

**Note**: Start with text-only buttons (consistent with current Select/Edit/New Prompt buttons). Add icons only if visual enhancement is needed.

#### Option A: No Icons (Recommended for MVP)
Keep buttons text-only like current implementation:
```html
<button id="load-file">Load</button>
<button id="append-file">Append</button>
<button id="new-workflow">New Workflow</button>
```

#### Option B: Add Codicons (Optional Enhancement)

If adding icons, use VS Code codicons (NOT emojis):

**1. Import codicon CSS in dashboard.html `<head>`:**
```html
<link rel="stylesheet" href="${codiconUri}">
```

**2. Add codicon spans to buttons:**
```html
<button id="load-file" class="btn-secondary btn-small">
  <span class="codicon codicon-folder-opened"></span>
  Load
</button>
<button id="append-file" class="btn-secondary btn-small">
  <span class="codicon codicon-add"></span>
  Append
</button>
<button id="new-workflow" class="btn-secondary btn-small">
  <span class="codicon codicon-new-file"></span>
  New Workflow
</button>
```

**3. Update FlightPathDashboardProvider.ts to pass codicon URI:**
```typescript
const codiconUri = webview.asWebviewUri(
  vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
);
```

**Suggested codicons**:
- Load: `codicon-folder-opened` (file picker visual)
- Append: `codicon-add` (adding to queue)
- New Workflow: `codicon-new-file` (creating new)

**Alternative codicons**:
- Load: `codicon-file`, `codicon-cloud-download`
- Append: `codicon-diff-added`, `codicon-arrow-down`

**Tasks**:
- [ ] Add codicon CSS import to dashboard.html
- [ ] Add codicon spans to button HTML
- [ ] Add codiconUri to template variables
- [ ] Test icons match VS Code theme (light/dark)

**Other polish tasks**:
- [ ] Add success toasts
- [ ] Add keyboard shortcuts
- [ ] Add loading states

---

## Future Enhancements

### Enhancement 1: Quick Append Recent Files

**Feature**: Append dropdown with recently used files

```
[Load] [Append ▼] | [New Workflow]
         ↓
    ┌─────────────────────────┐
    │ Recent Files            │
    ├─────────────────────────┤
    │ implement-fixes.flig... │
    │ write-tests.flightpa... │
    │ deploy.flightpath.json  │
    ├─────────────────────────┤
    │ Browse...               │
    └─────────────────────────┘
```

**Benefit**: Faster workflow iteration

### Enhancement 2: Drag-and-Drop File Loading

**Feature**: Drag `.flightpath.json` files onto dashboard to load/append

**Behavior**:
- Drop on upper area → Load (replace queue)
- Drop on prompts list → Append to queue

**Benefit**: Visual workflow management

### Enhancement 3: Multi-File Load

**Feature**: Allow loading multiple files at once (merged into one queue)

**UI**: Checkbox in file picker for multi-select

**Benefit**: Combine modular workflows

### Enhancement 4: Smart Append Position

**Feature**: Dropdown to choose append position

```
[Append ▼]
    ↓
┌──────────────┐
│ At End       │ (default)
│ After Current│
│ At Start     │
└──────────────┘
```

**Benefit**: Fine-grained queue control

---

## Related Work

- **IN_PANEL_PROMPT_EDITOR.md**: Planned text editor feature (replaces New Prompt button)
- **QUEUE_APPEND_FEATURE.md**: Working file architecture (context for button changes)
- **FlightPathDashboardProvider.ts**: Backend message handling
- **dashboard.html**: UI structure
- **dashboard.js**: Frontend logic

---

## Approval Checklist

**✅ All items approved by user:**
- [x] User confirms button layout preference (Load, Append, New Workflow)
- [x] User confirms removal of Edit/New Prompt buttons
- [x] User confirms header redesign (workflow name + state in center)
- [x] User approves phase-by-phase rollout plan
- [x] User approves deployment timing (deploy now, independent of in-panel editor)

---

## Changelog

### December 29, 2024 - Approved for Implementation (v3)
- **Icon strategy update**:
  - Removed emoji suggestions (📂, ➕, ✨)
  - Recommend text-only buttons for MVP (consistent with current UI)
  - Added optional codicon enhancement guide for Phase 7
  - Codicons properly match VS Code theme colors (light/dark)

### December 29, 2024 - Approved for Implementation (v2)
- **Added two critical UX fixes**:
  - Hide execution state when no workflow loaded (prevents "No workflow loaded - IDLE" redundancy)
  - Disable Load button during execution (RUNNING/PAUSED states)
- **Finalized button behavior**:
  - Load button: Disabled during execution, enabled otherwise
  - Append button: Always uses `position: "end"`, stays enabled during execution
- Added complete button state matrix for all execution states
- Updated code examples with `updateWorkflowStatus()` and button state handlers

### December 29, 2024 - Approved for Implementation (v1)
- **All design decisions approved by user**
- Added complete header layout redesign (buttons → status → controls)
- Resolved all 7 open questions
- Added detailed code examples for HTML/CSS/JS changes
- Updated implementation checklist with header redesign tasks
- Status changed from 📋 Planning to ✅ Approved

### December 29, 2024 - Initial Draft
- Analyzed current button functionality
- Proposed Load/Append/New Workflow layout
- Documented rationale and implementation plan
- Identified 7 open questions for user decision
