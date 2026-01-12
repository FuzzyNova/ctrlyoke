# Load Button Split Dropdown Redesign

**Last Updated**: January 12, 2026
**Status**: ✅ Implemented
**Related**:

- [DASHBOARD_FILE_ACTIONS_REDESIGN.md](DASHBOARD_FILE_ACTIONS_REDESIGN.md) - Previously approved button layout
- [IN_PANEL_PROMPT_EDITOR.md](IN_PANEL_PROMPT_EDITOR.md) - Built-in text editor plans

## Implementation Summary

The split dropdown button has been fully implemented in the dashboard:

- **HTML**: [dashboard.html](../src/ui/webview/dashboard.html#L21-L82) - Split button with dropdown menu
- **CSS**: [dashboard.css](../src/ui/webview/dashboard.css#L1119-L1210) - Split button styling
- **JS**: [workflow-manager.js](../src/ui/webview/workflow-manager.js#L330-L420) - Dropdown toggle and keyboard navigation

## Problem Statement

The current dashboard header has multiple buttons for loading workflows, which takes up significant horizontal space and creates visual clutter:

```
[Load] [Queue File...] | [New Workflow]
```

This can be consolidated into a single split dropdown button similar to VS Code's source control commit button style `[Button]|[⌄]`, where:

- The main button performs the default action (New Workflow)
- The dropdown provides alternative loading methods

## Current State Analysis

### Existing Buttons (dashboard.html:18-50)

From the attachment provided:

```html
<div id="action-buttons">
  <button
    id="load-file"
    class="btn-secondary btn-small"
    title="Load a prompt file to start a new workflow"
  >
    Load
  </button>
  <button
    id="append-file"
    class="btn-secondary btn-small"
    title="Queue prompts from a file"
    disabled
  >
    Queue File...
  </button>
  <span class="button-divider"></span>
  <button
    id="new-workflow"
    class="btn-secondary btn-small"
    title="Create workflow from template"
  >
    New Workflow
  </button>
  <button
    id="from-template"
    class="btn-secondary btn-small"
    title="Create workflow from template"
  >
    From Template...
  </button>
</div>
```

**Note**: The code shows 4 buttons (Load, Queue File, New Workflow, From Template), though the problem statement mentions different button names. We'll design for consolidating all workflow loading/creation actions.

### Button Functionality Mapping

| Button               | Current Behavior                      | Message Type     |
| -------------------- | ------------------------------------- | ---------------- |
| **Load**             | Opens file picker, loads workflow     | `SELECT_FILE`    |
| **Queue File...**    | Opens file picker, appends to queue   | `APPEND_FILE`    |
| **New Workflow**     | Clears current workflow, starts blank | `CLEAR_WORKFLOW` |
| **From Template...** | Opens template modal                  | `NEW_WORKFLOW`   |

## Proposed Design: Split Dropdown Button

### Visual Design

```
┌────────────────────────────────────────────────────────────┐
│  [New Workflow |▼]    workflow-name - RUNNING    [▶][⏸][⏹]  │
└────────────────────────────────────────────────────────────┘
                ↓ (on dropdown click)
    ┌──────────────────────────────┐
    │ New Workflow                 │  ← Default action (main button)
    ├──────────────────────────────┤
    │ From Template...             │
    │ Load from File...            │
    │ Queue from File...           │
    └──────────────────────────────┘
```

### Split Button Structure

The split button consists of two clickable areas:

1. **Main Button** (left): Performs the default action (New Workflow)
   - Takes up ~80% of the button width
   - Has its own hover/active state
   - Always performs "New Workflow" action (clears queue)

2. **Dropdown Trigger** (right): Shows the dropdown menu
   - Takes up ~20% of the button width (just the `|▼` part)
   - Has its own hover/active state
   - Shows menu with all workflow loading options

### Button States

#### State 1: No Workflow Loaded (IDLE)

```
[New Workflow |▼]
```

- Main button: Enabled (creates new blank workflow)
- Dropdown options:
  - ✓ New Workflow (redundant with main, but consistent)
  - ✓ From Template...
  - ✓ Load from File...
  - ✗ Queue from File... (disabled - no queue to append to)

#### State 2: Workflow Loaded (IDLE)

```
[New Workflow |▼]
```

- Main button: Enabled (shows confirmation: "Clear current workflow?")
- Dropdown options:
  - ✓ New Workflow (with confirmation)
  - ✓ From Template...
  - ✓ Load from File... (shows confirmation: "Replace current workflow?")
  - ✓ Queue from File... (enabled - can append to loaded queue)

#### State 3: Running/Paused

```
[New Workflow* |▼]
```

- Main button: **Disabled** (can't clear during execution)
- Dropdown trigger: **Enabled** (can still queue)
- Dropdown options:
  - ✗ New Workflow (disabled)
  - ✗ From Template... (disabled)
  - ✗ Load from File... (disabled - prevents accidental queue replacement)
  - ✓ Queue from File... (enabled - safe to append to running queue)

#### State 4: Completed/Error

```
[New Workflow |▼]
```

- Main button: Enabled
- All dropdown options: Enabled

## Design Rationale

### Why Split Dropdown vs. Separate Buttons?

**Pros**:

- ✅ **Saves horizontal space**: 4 buttons → 1 split button
- ✅ **Clearer hierarchy**: "New Workflow" is the primary action, others are alternatives
- ✅ **Familiar pattern**: Matches VS Code's commit button UX
- ✅ **Reduces visual clutter**: Cleaner header layout
- ✅ **Scalable**: Can add more options (e.g., "Open Recent", "Import from URL") without adding buttons

**Cons**:

- ❌ **Discoverability**: Less obvious that other loading methods exist
- ❌ **Extra click**: Requires dropdown click for non-default actions
- ❌ **Implementation complexity**: Custom dropdown logic needed

**Mitigation**:

- Add tooltip to dropdown trigger: "Show more workflow options"
- Use keyboard shortcuts for power users (Ctrl+Shift+L for Load, etc.)
- Show dropdown on first use (onboarding hint)

### Why "New Workflow" as Default Action?

**Rationale**:

1. **Most common action**: Creating a new workflow is likely the most frequent operation
2. **Clear intent**: "New Workflow" clearly states what happens (clear queue, start fresh)
3. **Safe default**: Less destructive than "Load" (which might replace running queue if we didn't disable it)
4. **Consistent with header position**: Leftmost button = start new work

**Alternative**: Could use "Load from File..." as default if file loading is more common than blank workflows. This should be determined by user feedback/analytics.

### Dropdown Option Order

**Proposed order** (top to bottom):

1. **New Workflow** (default action, shown for consistency)
2. **From Template...** (structured workflow creation)
3. **Load from File...** (load existing workflow)
4. **Queue from File...** (append to current queue)

**Rationale**:

- Creation actions first (New, Template)
- Loading actions second (Load, Queue)
- Most → least destructive (New clears queue, Queue preserves it)

## Implementation Plan

### Phase 1: HTML/CSS Structure

#### HTML: Split Button Component

```html
<div id="action-buttons">
  <!-- Split dropdown button -->
  <div class="split-button">
    <!-- Main button (left side) -->
    <button
      id="btn-new-workflow-main"
      class="split-button-main btn-secondary btn-small"
      title="Clear current workflow and start blank"
    >
      New Workflow
    </button>

    <!-- Dropdown trigger (right side) -->
    <button
      id="btn-workflow-dropdown"
      class="split-button-dropdown btn-secondary btn-small"
      title="Show more workflow options"
      aria-label="Show workflow loading options"
      aria-haspopup="true"
      aria-expanded="false"
    >
      <i class="codicon codicon-chevron-down"></i>
    </button>

    <!-- Dropdown menu (hidden by default) -->
    <div id="workflow-dropdown-menu" class="dropdown-menu" role="menu" hidden>
      <button class="dropdown-item" data-action="new-workflow" role="menuitem">
        New Workflow
      </button>
      <button class="dropdown-item" data-action="from-template" role="menuitem">
        From Template...
      </button>
      <div class="dropdown-divider"></div>
      <button class="dropdown-item" data-action="load-file" role="menuitem">
        Load from File...
      </button>
      <button
        class="dropdown-item"
        data-action="queue-file"
        role="menuitem"
        disabled
      >
        Queue from File...
      </button>
    </div>
  </div>
</div>
```

#### CSS: Split Button Styling

```css
/* Split button container */
.split-button {
  display: inline-flex;
  position: relative;
  border-radius: var(--vscode-button-border-radius, 2px);
  overflow: hidden;
}

/* Main button (left side) */
.split-button-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
  padding: 4px 8px 4px 12px;
  flex: 1;
}

/* Dropdown trigger (right side) */
.split-button-dropdown {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.1));
  padding: 4px 6px;
  min-width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Hover states */
.split-button-main:hover {
  background-color: var(--vscode-button-hoverBackground);
}

.split-button-dropdown:hover {
  background-color: var(--vscode-button-hoverBackground);
}

/* Active/pressed states */
.split-button-main:active {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

.split-button-dropdown:active,
.split-button-dropdown[aria-expanded="true"] {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

/* Disabled state */
.split-button-main:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.split-button-dropdown:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dropdown menu */
.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background-color: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  z-index: 1000;
  padding: 4px 0;
}

.dropdown-menu[hidden] {
  display: none;
}

/* Dropdown item */
.dropdown-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--vscode-dropdown-foreground);
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.dropdown-item:hover:not(:disabled) {
  background-color: var(--vscode-list-hoverBackground);
  color: var(--vscode-list-hoverForeground);
}

.dropdown-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dropdown divider */
.dropdown-divider {
  height: 1px;
  background-color: var(--vscode-dropdown-border);
  margin: 4px 0;
}
```

### Phase 2: JavaScript Behavior (dashboard.js)

#### Elements Object Updates

```javascript
const elements = {
  // ... existing elements ...

  // Split button elements
  btnNewWorkflowMain: document.getElementById("btn-new-workflow-main"),
  btnWorkflowDropdown: document.getElementById("btn-workflow-dropdown"),
  workflowDropdownMenu: document.getElementById("workflow-dropdown-menu"),

  // Old elements to remove:
  // loadFileBtn: document.getElementById("load-file"),
  // appendFileBtn: document.getElementById("append-file"),
  // newWorkflowBtn: document.getElementById("new-workflow"),
  // fromTemplateBtn: document.getElementById("from-template"),
};
```

#### Dropdown Toggle Logic

```javascript
/**
 * Toggle the workflow dropdown menu
 */
function toggleWorkflowDropdown() {
  const isOpen = !elements.workflowDropdownMenu.hidden;

  if (isOpen) {
    closeWorkflowDropdown();
  } else {
    openWorkflowDropdown();
  }
}

/**
 * Open the workflow dropdown menu
 */
function openWorkflowDropdown() {
  elements.workflowDropdownMenu.hidden = false;
  elements.btnWorkflowDropdown.setAttribute("aria-expanded", "true");

  // Update dropdown item states based on current workflow state
  updateWorkflowDropdownItems();

  // Close dropdown when clicking outside
  document.addEventListener("click", handleDropdownClickOutside);
}

/**
 * Close the workflow dropdown menu
 */
function closeWorkflowDropdown() {
  elements.workflowDropdownMenu.hidden = true;
  elements.btnWorkflowDropdown.setAttribute("aria-expanded", "false");

  // Remove click-outside listener
  document.removeEventListener("click", handleDropdownClickOutside);
}

/**
 * Handle clicks outside the dropdown to close it
 */
function handleDropdownClickOutside(e) {
  const dropdown = elements.workflowDropdownMenu;
  const trigger = elements.btnWorkflowDropdown;

  // Close if click is outside dropdown and trigger button
  if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
    closeWorkflowDropdown();
  }
}

/**
 * Update dropdown menu item states based on current workflow state
 */
function updateWorkflowDropdownItems() {
  const hasQueue = state.fileName !== null;
  const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
  const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
  const isExecuting = isRunning || isPaused;

  // Get dropdown items by data-action attribute
  const items = {
    newWorkflow: elements.workflowDropdownMenu.querySelector(
      '[data-action="new-workflow"]'
    ),
    fromTemplate: elements.workflowDropdownMenu.querySelector(
      '[data-action="from-template"]'
    ),
    loadFile: elements.workflowDropdownMenu.querySelector(
      '[data-action="load-file"]'
    ),
    queueFile: elements.workflowDropdownMenu.querySelector(
      '[data-action="queue-file"]'
    ),
  };

  // Disable destructive actions during execution
  items.newWorkflow.disabled = isExecuting;
  items.fromTemplate.disabled = isExecuting;
  items.loadFile.disabled = isExecuting;

  // Queue file only enabled when queue exists
  items.queueFile.disabled = !hasQueue;
}

/**
 * Update main button state based on workflow state
 */
function updateNewWorkflowButtonState() {
  const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
  const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
  const isExecuting = isRunning || isPaused;

  // Disable main button during execution
  elements.btnNewWorkflowMain.disabled = isExecuting;

  if (isExecuting) {
    elements.btnNewWorkflowMain.title =
      "Cannot clear workflow while running (stop first)";
  } else {
    elements.btnNewWorkflowMain.title =
      "Clear current workflow and start blank";
  }

  // Dropdown trigger always enabled (can still queue during execution)
  elements.btnWorkflowDropdown.disabled = false;
}
```

#### Event Listeners

```javascript
// Main button click (New Workflow action)
elements.btnNewWorkflowMain.addEventListener("click", () => {
  handleNewWorkflowAction();
});

// Dropdown trigger click
elements.btnWorkflowDropdown.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent click-outside handler from firing immediately
  toggleWorkflowDropdown();
});

// Dropdown menu item clicks
elements.workflowDropdownMenu.addEventListener("click", (e) => {
  const item = e.target.closest(".dropdown-item");
  if (!item || item.disabled) return;

  const action = item.dataset.action;
  handleDropdownAction(action);
  closeWorkflowDropdown();
});

// Keyboard navigation for dropdown
elements.workflowDropdownMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeWorkflowDropdown();
    elements.btnWorkflowDropdown.focus();
  }

  // Arrow key navigation between items
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    navigateDropdownItems(e.key === "ArrowDown" ? 1 : -1);
  }

  // Enter or Space to activate item
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const focusedItem = document.activeElement;
    if (
      focusedItem.classList.contains("dropdown-item") &&
      !focusedItem.disabled
    ) {
      focusedItem.click();
    }
  }
});

/**
 * Navigate dropdown items with keyboard
 */
function navigateDropdownItems(direction) {
  const items = Array.from(
    elements.workflowDropdownMenu.querySelectorAll(
      ".dropdown-item:not(:disabled)"
    )
  );
  const currentIndex = items.indexOf(document.activeElement);

  let nextIndex = currentIndex + direction;

  // Wrap around
  if (nextIndex < 0) nextIndex = items.length - 1;
  if (nextIndex >= items.length) nextIndex = 0;

  items[nextIndex]?.focus();
}
```

#### Action Handlers

```javascript
/**
 * Handle "New Workflow" main button click
 */
function handleNewWorkflowAction() {
  const hasQueue = state.fileName !== null;

  if (hasQueue) {
    // Show confirmation modal if queue exists
    showConfirmModal(
      "Clear Workflow?",
      "This will clear the current workflow. Continue?",
      () => {
        vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
      }
    );
  } else {
    // No queue, just clear (no-op basically, but sends message)
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }
}

/**
 * Handle dropdown menu item clicks
 */
function handleDropdownAction(action) {
  switch (action) {
    case "new-workflow":
      handleNewWorkflowAction();
      break;

    case "from-template":
      vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
      break;

    case "load-file":
      handleLoadFileAction();
      break;

    case "queue-file":
      vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
      break;

    default:
      console.warn("Unknown dropdown action:", action);
  }
}

/**
 * Handle "Load from File..." action with confirmation if queue exists
 */
function handleLoadFileAction() {
  const hasQueue = state.fileName !== null;
  const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
  const isPaused = state.executionState === EXECUTION_STATES.PAUSED;

  if (hasQueue && (isRunning || isPaused)) {
    // This shouldn't happen (button should be disabled), but extra safety
    vscode.window.showErrorMessage(
      "Cannot load file while workflow is running"
    );
    return;
  }

  if (hasQueue) {
    // Show confirmation modal if queue exists
    showConfirmModal(
      "Replace Workflow?",
      "This will replace the current workflow. Continue?",
      () => {
        vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
      }
    );
  } else {
    // No queue, just load
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }
}
```

#### State Update Integration

```javascript
// Update button states in state handlers
function handleFileSelected(fileName, prompts) {
  // ... existing code ...
  updateNewWorkflowButtonState();
}

function handleExecutionStarted(fileName, totalSteps) {
  // ... existing code ...
  updateNewWorkflowButtonState();
}

function handleExecutionStateChanged(executionState) {
  // ... existing code ...
  updateNewWorkflowButtonState();
}
```

### Phase 3: Message Type Updates

#### DashboardConstants.ts

No new message types needed - reusing existing:

- `CLEAR_WORKFLOW` (New Workflow action)
- `NEW_WORKFLOW` (From Template action)
- `SELECT_FILE` (Load from File action)
- `APPEND_FILE` (Queue from File action)

### Phase 4: Accessibility & Polish

#### Keyboard Shortcuts

Add keyboard shortcuts for power users:

```javascript
// Register keyboard shortcuts for workflow actions
document.addEventListener("keydown", (e) => {
  // Ctrl+Shift+N: New Workflow
  if (e.ctrlKey && e.shiftKey && e.key === "N") {
    e.preventDefault();
    handleNewWorkflowAction();
  }

  // Ctrl+Shift+T: From Template
  if (e.ctrlKey && e.shiftKey && e.key === "T") {
    e.preventDefault();
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  }

  // Ctrl+Shift+L: Load from File
  if (e.ctrlKey && e.shiftKey && e.key === "L") {
    e.preventDefault();
    handleLoadFileAction();
  }

  // Ctrl+Shift+Q: Queue from File
  if (e.ctrlKey && e.shiftKey && e.key === "Q") {
    e.preventDefault();
    if (state.fileName !== null) {
      vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
    }
  }
});
```

#### Screen Reader Support

```html
<!-- Add aria-labels and descriptions -->
<button
  id="btn-new-workflow-main"
  class="split-button-main btn-secondary btn-small"
  title="Clear current workflow and start blank"
  aria-label="New Workflow"
>
  New Workflow
</button>

<button
  id="btn-workflow-dropdown"
  class="split-button-dropdown btn-secondary btn-small"
  title="Show more workflow options"
  aria-label="Show workflow loading options"
  aria-haspopup="menu"
  aria-expanded="false"
  aria-controls="workflow-dropdown-menu"
>
  <i class="codicon codicon-chevron-down" aria-hidden="true"></i>
</button>

<div
  id="workflow-dropdown-menu"
  class="dropdown-menu"
  role="menu"
  aria-label="Workflow options"
  hidden
>
  <!-- Menu items with role="menuitem" -->
</div>
```

#### Focus Management

```javascript
/**
 * Open dropdown and focus first item
 */
function openWorkflowDropdown() {
  elements.workflowDropdownMenu.hidden = false;
  elements.btnWorkflowDropdown.setAttribute("aria-expanded", "true");

  updateWorkflowDropdownItems();

  // Focus first enabled item
  const firstItem = elements.workflowDropdownMenu.querySelector(
    ".dropdown-item:not(:disabled)"
  );
  firstItem?.focus();

  document.addEventListener("click", handleDropdownClickOutside);
}
```

## User Experience Flows

### Flow 1: Create New Blank Workflow (Main Button)

**Before** (with separate buttons):

1. Click **New Workflow** button
2. Workflow cleared, ready for editor input

**After** (with split button):

1. Click main part of **[New Workflow |▼]** button
2. If queue exists: Confirmation modal → Click "OK"
3. Workflow cleared, ready for editor input

**Change**: +1 click if queue exists (safety confirmation)

### Flow 2: Create Workflow from Template (Dropdown)

**Before**:

1. Click **From Template...** button
2. Template modal opens

**After**:

1. Click dropdown trigger **[|▼]**
2. Click **From Template...** in menu
3. Template modal opens

**Change**: +1 click (dropdown activation)

### Flow 3: Load Workflow from File (Dropdown)

**Before**:

1. Click **Load** button
2. File picker opens
3. Select file → Workflow loads

**After**:

1. Click dropdown trigger **[|▼]**
2. Click **Load from File...** in menu
3. If queue exists: Confirmation modal → Click "OK"
4. File picker opens
5. Select file → Workflow loads

**Change**: +1 click (dropdown), +1 click if queue exists (confirmation)

### Flow 4: Queue Workflow from File (Dropdown)

**Before**:

1. Click **Queue File...** button
2. File picker opens
3. Select file → Prompts appended

**After**:

1. Click dropdown trigger **[|▼]**
2. Click **Queue from File...** in menu
3. File picker opens
4. Select file → Prompts appended

**Change**: +1 click (dropdown activation)

### Flow 5: Keyboard Power User (New)

**New capability**:

1. Press **Ctrl+Shift+N** → New Workflow
2. Press **Ctrl+Shift+T** → From Template
3. Press **Ctrl+Shift+L** → Load from File
4. Press **Ctrl+Shift+Q** → Queue from File

**Benefit**: Zero clicks, faster for repeated actions

## Testing Checklist

### Visual Testing

- [ ] Split button renders correctly in light theme
- [ ] Split button renders correctly in dark theme
- [ ] Dropdown menu aligns properly below button
- [ ] Dropdown menu has correct z-index (above other content)
- [ ] Hover states work for both button parts independently
- [ ] Active/pressed states work correctly
- [ ] Disabled states render with correct opacity
- [ ] Long workflow names don't break dropdown positioning

### Interaction Testing

- [ ] Main button click triggers New Workflow action
- [ ] Dropdown trigger click opens menu
- [ ] Clicking outside dropdown closes it
- [ ] Clicking dropdown item closes menu and triggers action
- [ ] Dropdown items disable correctly based on state
- [ ] Confirmation modals appear when replacing/clearing queue
- [ ] Keyboard shortcuts work (Ctrl+Shift+N/T/L/Q)

### State Testing

| State         | Main Button | Dropdown Trigger | Dropdown Items                              |
| ------------- | ----------- | ---------------- | ------------------------------------------- |
| No workflow   | Enabled     | Enabled          | New/Template/Load: enabled, Queue: disabled |
| IDLE (loaded) | Enabled     | Enabled          | All enabled                                 |
| RUNNING       | Disabled    | Enabled          | New/Template/Load: disabled, Queue: enabled |
| PAUSED        | Disabled    | Enabled          | New/Template/Load: disabled, Queue: enabled |
| COMPLETED     | Enabled     | Enabled          | All enabled                                 |
| ERROR         | Enabled     | Enabled          | All enabled                                 |

### Accessibility Testing

- [ ] Dropdown trigger has `aria-haspopup="menu"`
- [ ] Dropdown trigger updates `aria-expanded` on toggle
- [ ] Dropdown menu has `role="menu"`
- [ ] Dropdown items have `role="menuitem"`
- [ ] Keyboard navigation works (Arrow keys, Enter, Escape)
- [ ] Focus management works (first item focused on open, focus returns to trigger on close)
- [ ] Screen reader announces dropdown state changes
- [ ] All interactive elements have accessible labels

### Edge Cases

- [ ] Dropdown closes when window loses focus
- [ ] Dropdown repositions if near viewport edge
- [ ] Multiple rapid clicks don't cause issues
- [ ] Dropdown works with zoomed UI (125%, 150%)
- [ ] Dropdown works with different font sizes
- [ ] Animation is smooth (no jank)

## Migration & Rollout

### Breaking Changes

**None** - All existing message types are reused, no backend changes needed.

### User Impact

**Low to Medium**:

- **Positive**: Cleaner UI, less clutter, familiar pattern (VS Code commit button)
- **Negative**: +1 click for non-default actions (Template, Load, Queue)
- **Mitigation**: Keyboard shortcuts for power users, tooltip hints

### Rollback Plan

If users strongly prefer separate buttons:

1. Revert HTML to individual buttons
2. Revert CSS/JS changes
3. Keep dropdown styling for potential future use

### Gradual Rollout Option

**Phase 1**: Add split button, keep old buttons (both visible)

- Let users try new pattern
- Gather feedback via in-app survey

**Phase 2**: Remove old buttons if feedback is positive

- Show migration notice: "We've moved these actions to the dropdown"
- Add "Don't show again" checkbox

## Open Questions

### Q1: Should "New Workflow" be the default action?

**Options**:

1. **New Workflow** (current proposal) - Most common action, clear intent
2. **Load from File** - Alternative if users load more than create blank workflows
3. **From Template** - Alternative if template-based workflow is primary use case

**Decision**: Pending user feedback / analytics data

### Q2: Should we show confirmation modals?

**Current proposal**: Show confirmation when:

- Clearing queue via "New Workflow" (if queue exists)
- Replacing queue via "Load from File" (if queue exists)

**Alternatives**:

- Never show confirmation (faster but more dangerous)
- Always show confirmation (safer but annoying for new workflows)
- Add "Don't ask again" checkbox

**Decision**: ✅ **IMPLEMENTED - No confirmations** (zero friction approach). All workflow loading/creation actions execute immediately without confirmation dialogs.

### Q3: Should dropdown stay open after misclick?

**Current proposal**: Dropdown closes after any item click (including disabled items)

**Alternative**: Keep dropdown open if user clicks disabled item (allows them to see why it's disabled)

**Decision**: Close on any click (simpler logic, matches VS Code behavior)

### Q4: Should we add icons to dropdown items?

**Options**:

1. **Text only** (current proposal) - Clean, simple
2. **Icons + text** - More visual, easier to scan
   - New Workflow: `codicon-new-file`
   - From Template: `codicon-library`
   - Load from File: `codicon-folder-opened`
   - Queue from File: `codicon-add`

**Decision**: Start with text only, add icons if users request better visual distinction

### Q5: Should keyboard shortcuts be configurable?

**Current proposal**: Hardcoded shortcuts (Ctrl+Shift+N/T/L/Q)

**Alternative**: Allow customization via VS Code keybindings.json

**Decision**: Hardcode for MVP, add customization if users request specific shortcuts

## Alternative Designs Considered

### Alternative 1: Tabbed Interface

```
┌────────────────────────────────────────┐
│ [New] [Load] [Template]   workflow...  │
│   ▔▔▔                                  │
└────────────────────────────────────────┘
```

**Pros**: All options visible, no dropdown
**Cons**: Takes up more horizontal space, not as clean

### Alternative 2: Single Button with Rotating Text

```
[New Workflow ⌄]  (default)
[Load Workflow ⌄] (after using Load once)
[Queue Workflow ⌄] (after using Queue once)
```

**Pros**: Remembers last action, adaptive
**Cons**: Confusing, unpredictable behavior

### Alternative 3: Icon-Only Dropdown

```
[📁 ⌄]
```

**Pros**: Extremely compact
**Cons**: Not discoverable, unclear what it does

### Alternative 4: Context Menu on Right-Click

```
[New Workflow] ← Left-click: New Workflow
               ← Right-click: Dropdown menu
```

**Pros**: No visual change, power user feature
**Cons**: Not discoverable, right-click is non-obvious

**Selected**: Split dropdown (proposed design) balances discoverability, space efficiency, and familiarity.

## Success Metrics

### Adoption Metrics

- **Split button usage**: Track main button clicks vs. dropdown clicks
  - Goal: 70% main button, 30% dropdown (validates "New Workflow" as default)

- **Keyboard shortcut usage**: Track Ctrl+Shift+N/T/L/Q invocations
  - Goal: 10% of power users adopt shortcuts within 1 month

### User Satisfaction Metrics

- **Confusion rate**: Monitor support issues about "Where did Load button go?"
  - Goal: <5% of users ask (dropdown is discoverable enough)

- **Click efficiency**: Compare total clicks before/after for common workflows
  - Goal: Neutral or positive (keyboard shortcuts offset extra dropdown clicks)

### Technical Metrics

- **Performance**: Measure dropdown open/close latency
  - Goal: <16ms (60fps), no jank

- **Accessibility**: Test with screen readers (NVDA, JAWS, VoiceOver)
  - Goal: 100% pass rate on accessibility audits

## Related Work

### VS Code Examples

**Source Control Commit Button**:

```
[Commit |▼]
    ↓
  ┌──────────────────────┐
  │ Commit               │
  │ Commit & Push        │
  │ Commit & Sync        │
  │ Commit Staged        │
  └──────────────────────┘
```

**Reference**: `src/vs/workbench/contrib/scm/browser/scmViewPaneContainer.ts`

**Terminal New Terminal Button**:

```
[New Terminal |▼]
    ↓
  ┌──────────────────────┐
  │ New Terminal         │
  │ New External Terminal│
  │ Split Terminal       │
  └──────────────────────┘
```

**Reference**: `src/vs/workbench/contrib/terminal/browser/terminalView.ts`

### Internal References

- **dashboard.html**: HTML structure (lines 18-50)
- **dashboard.js**: JavaScript logic, state management
- **dashboard.css**: Styling for buttons
- **DASHBOARD_FILE_ACTIONS_REDESIGN.md**: Previous button layout decisions

## Implementation Checklist

### Phase 1: HTML Structure

- [ ] Remove individual buttons (Load, Queue File, New Workflow, From Template)
- [ ] Add split button container with `split-button` class
- [ ] Add main button (`split-button-main`)
- [ ] Add dropdown trigger (`split-button-dropdown`) with chevron icon
- [ ] Add dropdown menu container with `dropdown-menu` class
- [ ] Add dropdown menu items with `data-action` attributes
- [ ] Add `role` and `aria-*` attributes for accessibility

### Phase 2: CSS Styling

- [ ] Add `.split-button` container styles (flexbox layout)
- [ ] Add `.split-button-main` styles (border-radius, padding)
- [ ] Add `.split-button-dropdown` styles (border, icon centering)
- [ ] Add hover states for both button parts
- [ ] Add active/pressed states
- [ ] Add disabled states
- [ ] Add `.dropdown-menu` styles (positioning, shadow, theme colors)
- [ ] Add `.dropdown-item` styles (hover, disabled, focus)
- [ ] Add `.dropdown-divider` styles
- [ ] Test in light and dark themes

### Phase 3: JavaScript Behavior

- [ ] Update elements object (remove old buttons, add split button elements)
- [ ] Add `toggleWorkflowDropdown()` function
- [ ] Add `openWorkflowDropdown()` function
- [ ] Add `closeWorkflowDropdown()` function
- [ ] Add `handleDropdownClickOutside()` function
- [ ] Add `updateWorkflowDropdownItems()` function (state-based enable/disable)
- [ ] Add `updateNewWorkflowButtonState()` function (main button state)
- [ ] Add event listener for main button click
- [ ] Add event listener for dropdown trigger click
- [ ] Add event listener for dropdown item clicks
- [ ] Add keyboard navigation (Arrow keys, Enter, Escape)
- [ ] Add `handleNewWorkflowAction()` function (with confirmation)
- [ ] Add `handleLoadFileAction()` function (with confirmation)
- [ ] Add `handleDropdownAction()` dispatcher
- [ ] Update state handlers to call `updateNewWorkflowButtonState()`

### Phase 4: Keyboard Shortcuts

- [ ] Add global keydown listener for Ctrl+Shift+N (New Workflow)
- [ ] Add global keydown listener for Ctrl+Shift+T (From Template)
- [ ] Add global keydown listener for Ctrl+Shift+L (Load from File)
- [ ] Add global keydown listener for Ctrl+Shift+Q (Queue from File)
- [ ] Test shortcuts don't conflict with VS Code defaults

### Phase 5: Accessibility

- [ ] Verify `aria-haspopup="menu"` on dropdown trigger
- [ ] Verify `aria-expanded` updates on toggle
- [ ] Verify `role="menu"` on dropdown container
- [ ] Verify `role="menuitem"` on dropdown items
- [ ] Verify focus management (first item on open, return to trigger on close)
- [ ] Test with screen readers (Windows Narrator, NVDA, macOS VoiceOver)
- [ ] Test keyboard-only navigation (Tab, Arrow keys, Enter, Escape)

### Phase 6: Testing

- [ ] Test all dropdown items trigger correct actions
- [ ] Test dropdown closes on click outside
- [ ] Test dropdown items disable correctly per state
- [ ] Test confirmation modals appear when needed
- [ ] Test button states during execution (RUNNING, PAUSED, etc.)
- [ ] Test edge case: rapid clicking
- [ ] Test edge case: dropdown near viewport edge
- [ ] Test with zoomed UI (125%, 150%)
- [ ] Test with different font sizes

### Phase 7: Documentation

- [ ] Update DASHBOARD_FILE_ACTIONS_REDESIGN.md (mark as superseded)
- [ ] Add screenshots of new split button to README
- [ ] Update CHANGELOG.md with UI change notes
- [ ] Document keyboard shortcuts in user guide

### Phase 8: Polish (Optional)

- [ ] Add icons to dropdown items (if Q4 is "yes")
- [ ] Add tooltips to dropdown items
- [ ] Add subtle open/close animation
- [ ] Add dropdown item hover animation
- [ ] Add "first use" tooltip hint ("Tip: Click ▼ for more options")

## Changelog

### January 11, 2026 - Implementation Complete ✅

- **Fully implemented split dropdown button** replacing four separate header buttons
- **HTML Changes**: New split button structure with main action + dropdown trigger
- **CSS Changes**:
  - Split button styling with proper hover/active/disabled states
  - Dropdown menu with VS Code theme colors and proper z-index (9999)
  - Fixed dropdown divider using `border-top` for visibility
  - Fixed overflow handling to allow dropdown to appear above all content
- **JavaScript Changes**:
  - Dropdown toggle/open/close logic with click-outside detection
  - Dynamic dropdown item state management based on execution state
  - Keyboard navigation (Arrow keys, Enter, Escape)
  - Keyboard shortcuts (Ctrl+Shift+N/T/L/Q)
  - Consolidated button state logic into `updateNewWorkflowButtonState()`
- **UX Decision**: **Zero friction approach** - removed all confirmation dialogs for immediate workflow loading/creation
- **Accessibility**: Full ARIA attributes, keyboard navigation, focus management
- **Files modified**:
  - `src/ui/webview/dashboard.html` (split button structure)
  - `src/ui/webview/dashboard.css` (split button + dropdown styling)
  - `src/ui/webview/dashboard.js` (dropdown logic, event handlers, keyboard shortcuts)

### January 11, 2026 - Initial Draft

- Analyzed current dashboard button layout from dashboard.html:18-50
- Proposed split dropdown button design (inspired by VS Code commit button)
- Documented visual design, states, and behavior
- Created comprehensive implementation plan (HTML/CSS/JS)
- Added keyboard shortcuts for power users (Ctrl+Shift+N/T/L/Q)
- Documented accessibility requirements (ARIA, keyboard navigation)
- Identified 5 open questions for user decision
- Created testing checklist and success metrics
