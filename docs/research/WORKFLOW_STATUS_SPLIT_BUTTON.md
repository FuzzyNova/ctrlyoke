# Workflow Status Split Button & Recent Workflows

**Last Updated**: January 11, 2026
**Status**: 📋 Planning
**Related**:

- [LOAD_BUTTON_SPLIT_DROPDOWN.md](LOAD_BUTTON_SPLIT_DROPDOWN.md) - Split dropdown pattern reference
- [WORKFLOW_NAME_PLAN.md](WORKFLOW_NAME_PLAN.md) - workflowName property implementation

## Problem Statement

The current workflow status area shows the workflow name and execution state as plain text:

```
workflow-name - RUNNING
```

This design has limitations:

1. **No discoverability**: Users don't know they can switch between recent workflows
2. **No editability**: Workflow name can't be changed after creation
3. **Missing context**: Recent workflow history is hidden in file system
4. **Inefficient workflow switching**: Requires using "Load from File" action and navigating to `.flightpath/.queue`

## Proposed Design: Workflow Status Split Button

Transform the workflow status area into an interactive split button that:

1. **Main button**: Click to edit workflow name inline (save to `workflowName` in working file)
2. **Dropdown trigger**: Click to show recent workflows from `.flightpath/.queue` directory
3. **Dropdown items**: Show workflow name and current state (`[name - state]`)
4. **Selection**: Click a workflow to restore/resume it

### Visual Design

**Current State (Static Text):**

```
┌────────────────────────────────────────────────────────┐
│  [New Workflow |▼]    workflow-name - RUNNING    [▶][⏸][⏹]  │
└────────────────────────────────────────────────────────┘
```

**Proposed State (Interactive Split Button):**

```
┌────────────────────────────────────────────────────────┐
│  [New Workflow |▼]    [workflow-name - RUNNING |▼]    [▶][⏸][⏹]  │
└────────────────────────────────────────────────────────┘
                              ↓ (on main button click)
                  ┌─────────────────────────────┐
                  │  workflow-name [edit mode]  │ ← Inline text input
                  └─────────────────────────────┘

                              ↓ (on dropdown trigger click)
            ┌────────────────────────────────────┐
            │ feature-implementation - RUNNING   │ ← Current workflow (highlighted)
            ├────────────────────────────────────┤
            │ bug-fixes - PAUSED                 │
            │ refactor-tests - COMPLETED         │
            │ api-migration - ERROR              │
            │ docs-update - IDLE                 │
            └────────────────────────────────────┘
```

### Split Button Structure

The workflow status split button consists of:

1. **Main Button** (left, ~85% width):
   - **Display mode**: Shows `workflowName - executionState`
   - **Edit mode**: Becomes text input when clicked
   - **Behavior**:
     - Click → Enter edit mode (text input replaces span)
     - Type new name → Press Enter or click away to save
     - Escape → Cancel edit and revert
     - Saves to `workflowName` property in working file

2. **Dropdown Trigger** (right, ~15% width):
   - Shows chevron-down icon
   - Click → Opens recent workflows dropdown
   - Shows badge with count of recent workflows (e.g., "▼ 5")

3. **Dropdown Menu**:
   - Lists all working files from `.flightpath/.queue`
   - Sorted by most recent first (descending `startedAt`)
   - Each item shows: `workflowName - executionState`
   - Current workflow is highlighted
   - Click to load/resume workflow

## Current State Analysis

### HTML Structure (dashboard.html:86-101)

```html
<div id="workflow-status">
  <span id="workflow-name">New Workflow</span>
  <span id="status-separator" class="status-separator" style="display: none">
    -
  </span>
  <span id="execution-state" class="execution-state-idle" style="display: none"
    >Idle</span
  >
</div>
```

**Current behavior**: Static text display, no interaction

### JavaScript State (dashboard.js:247-260)

```javascript
function getWorkflowName(fileName) {
  if (!fileName) return "No workflow loaded";

  const match = fileName.match(/([^/\\]+)\.flightpath\.json$/);
  if (match) {
    return match[1]
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return path.basename(fileName, ".json");
}
```

**Current behavior**: Derives display name from filename (kebab-case → Title Case)

### Backend State (PromptQueue.ts)

- **Working files**: Stored in `.flightpath/.queue`
- **Filename pattern**: `{workflow-name}-{timestamp}.flightpath.json`
- **Structure**: Contains `workflowName`, `originalFile`, `startedAt`, `_runtime`, `prompts`

## Proposed Implementation

### Phase 1: HTML Structure

#### Updated workflow-status div

```html
<div id="workflow-status">
  <!-- Split button container -->
  <div class="workflow-split-button" style="display: none">
    <!-- Main button (workflow name + state) -->
    <button
      id="btn-workflow-main"
      class="workflow-button-main btn-tertiary"
      title="Click to edit workflow name"
      aria-label="Workflow name and status"
    >
      <span id="workflow-display">
        <span id="workflow-name">New Workflow</span>
        <span id="status-separator" class="status-separator">-</span>
        <span id="execution-state" class="execution-state-idle">Idle</span>
      </span>
    </button>

    <!-- Dropdown trigger (recent workflows) -->
    <button
      id="btn-workflow-dropdown"
      class="workflow-button-dropdown btn-tertiary"
      title="Show recent workflows"
      aria-label="Show recent workflows"
      aria-haspopup="menu"
      aria-expanded="false"
      aria-controls="workflow-recent-menu"
      disabled
    >
      <i class="codicon codicon-chevron-down"></i>
      <span id="workflow-count-badge" class="workflow-count-badge" hidden
        >0</span
      >
    </button>

    <!-- Dropdown menu (recent workflows) -->
    <div
      id="workflow-recent-menu"
      class="workflow-dropdown-menu"
      role="menu"
      aria-label="Recent workflows"
      hidden
    >
      <div class="workflow-menu-header">Recent Workflows</div>
      <div id="workflow-menu-items" class="workflow-menu-items">
        <!-- Populated dynamically -->
      </div>
      <div class="workflow-menu-footer">
        <button class="workflow-menu-action" data-action="clear-history">
          Clear History
        </button>
      </div>
    </div>
  </div>

  <!-- Inline edit input (hidden by default) -->
  <input
    id="workflow-name-edit"
    class="workflow-name-edit-input"
    type="text"
    maxlength="100"
    placeholder="Workflow name"
    style="display: none"
    aria-label="Edit workflow name"
  />

  <!-- Fallback for no workflow loaded -->
  <span id="workflow-empty-state" class="workflow-empty-state">
    No workflow loaded
  </span>
</div>
```

### Phase 2: CSS Styling

```css
/* === Workflow Status Split Button === */

#workflow-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: center;
}

/* Split button container */
.workflow-split-button {
  display: inline-flex;
  position: relative;
  border-radius: var(--vscode-button-border-radius, 2px);
  overflow: visible; /* Allow dropdown to overflow */
  max-width: 500px; /* Prevent excessive width */
}

/* Main button (workflow name + state) */
.workflow-button-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
  padding: 4px 12px;
  flex: 1;
  min-width: 150px;
  max-width: 400px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s;
}

.workflow-button-main:hover {
  background-color: var(--vscode-button-hoverBackground);
}

/* Dropdown trigger */
.workflow-button-dropdown {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.1));
  padding: 4px 8px;
  min-width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  position: relative;
}

.workflow-button-dropdown:hover:not(:disabled) {
  background-color: var(--vscode-button-hoverBackground);
}

.workflow-button-dropdown[aria-expanded="true"] {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

.workflow-button-dropdown:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Workflow count badge */
.workflow-count-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--vscode-badge-foreground);
  background-color: var(--vscode-badge-background);
  border-radius: 10px;
  padding: 2px 5px;
  min-width: 16px;
  text-align: center;
}

/* === Dropdown Menu === */

.workflow-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 300px;
  max-width: 500px;
  max-height: 400px;
  background-color: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  z-index: 9999;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.workflow-dropdown-menu[hidden] {
  display: none;
}

/* Menu header */
.workflow-menu-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--vscode-dropdown-border);
  background-color: var(--vscode-editor-background);
}

/* Menu items container (scrollable) */
.workflow-menu-items {
  overflow-y: auto;
  max-height: 320px;
  padding: 4px 0;
}

/* Workflow menu item */
.workflow-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: none;
  background: none;
  color: var(--vscode-dropdown-foreground);
  text-align: left;
  cursor: pointer;
  font-size: 13px;
  width: 100%;
  gap: 8px;
}

.workflow-menu-item:hover {
  background-color: var(--vscode-list-hoverBackground);
  color: var(--vscode-list-hoverForeground);
}

.workflow-menu-item.current {
  background-color: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  font-weight: 600;
}

/* Workflow name in menu item */
.workflow-menu-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Workflow state badge in menu item */
.workflow-menu-item-state {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  flex-shrink: 0;
}

/* State colors (match execution-state classes) */
.workflow-menu-item-state.state-idle {
  background-color: var(--vscode-inputValidation-infoBackground);
  color: var(--vscode-inputValidation-infoForeground);
}

.workflow-menu-item-state.state-running {
  background-color: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-inputValidation-warningForeground);
}

.workflow-menu-item-state.state-paused {
  background-color: var(--vscode-editorWarning-background);
  color: var(--vscode-editorWarning-foreground);
}

.workflow-menu-item-state.state-completed {
  background-color: var(--vscode-inputValidation-infoBackground);
  color: var(--vscode-inputValidation-infoForeground);
}

.workflow-menu-item-state.state-error {
  background-color: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
}

/* Menu footer */
.workflow-menu-footer {
  padding: 4px;
  border-top: 1px solid var(--vscode-dropdown-border);
  background-color: var(--vscode-editor-background);
}

.workflow-menu-action {
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--vscode-textLink-foreground);
  text-align: center;
  cursor: pointer;
  font-size: 12px;
  border-radius: 2px;
}

.workflow-menu-action:hover {
  background-color: var(--vscode-list-hoverBackground);
}

/* Empty state */
.workflow-menu-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
}

/* === Inline Edit Input === */

.workflow-name-edit-input {
  font-family: var(--vscode-font-family);
  font-size: 14px;
  font-weight: 600;
  padding: 4px 8px;
  border: 1px solid var(--vscode-focusBorder);
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border-radius: 3px;
  outline: none;
  min-width: 200px;
  max-width: 400px;
}

.workflow-name-edit-input:focus {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

/* === Empty State === */

.workflow-empty-state {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  font-size: 14px;
}

/* === Status Separator === */

.status-separator {
  margin: 0 6px;
  color: var(--vscode-descriptionForeground);
}

/* === Execution State Styling === */

#execution-state {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 3px;
}

.execution-state-idle {
  color: var(--vscode-descriptionForeground);
}

.execution-state-running {
  background-color: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-inputValidation-warningForeground);
}

.execution-state-paused {
  background-color: var(--vscode-editorWarning-background);
  color: var(--vscode-editorWarning-foreground);
}

.execution-state-completed {
  background-color: var(--vscode-inputValidation-infoBackground);
  color: var(--vscode-inputValidation-infoForeground);
}

.execution-state-error {
  background-color: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
}

.execution-state-cancelled {
  background-color: var(--vscode-editorWarning-background);
  color: var(--vscode-editorWarning-foreground);
}
```

### Phase 3: JavaScript Behavior

#### 1. State Management

```javascript
// Workflow status state
const workflowStatusState = {
  isEditing: false,
  originalName: "",
  recentWorkflows: [], // { filePath, workflowName, executionState, startedAt }
  currentFilePath: null,
};
```

#### 2. DOM Elements

```javascript
const elements = {
  // ... existing elements ...

  // Workflow status split button
  workflowSplitButton: document.querySelector(".workflow-split-button"),
  workflowEmptyState: document.getElementById("workflow-empty-state"),
  btnWorkflowMain: document.getElementById("btn-workflow-main"),
  btnWorkflowDropdown: document.getElementById("btn-workflow-dropdown"),
  workflowRecentMenu: document.getElementById("workflow-recent-menu"),
  workflowMenuItems: document.getElementById("workflow-menu-items"),
  workflowCountBadge: document.getElementById("workflow-count-badge"),

  // Workflow name display
  workflowDisplay: document.getElementById("workflow-display"),
  workflowName: document.getElementById("workflow-name"),
  statusSeparator: document.getElementById("status-separator"),
  executionState: document.getElementById("execution-state"),

  // Inline edit
  workflowNameEdit: document.getElementById("workflow-name-edit"),
};
```

#### 3. Event Listeners

```javascript
// === Main Button (Edit Workflow Name) ===

elements.btnWorkflowMain.addEventListener("click", () => {
  startEditingWorkflowName();
});

// === Dropdown Trigger (Recent Workflows) ===

elements.btnWorkflowDropdown.addEventListener("click", async (e) => {
  e.stopPropagation();

  // Prevent opening if disabled (workflow is running)
  if (elements.btnWorkflowDropdown.disabled) {
    return;
  }

  await toggleRecentWorkflowsDropdown();
});

// === Inline Edit Input ===

elements.workflowNameEdit.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    saveWorkflowName();
  } else if (e.key === "Escape") {
    cancelEditingWorkflowName();
  }
});

elements.workflowNameEdit.addEventListener("blur", () => {
  if (workflowStatusState.isEditing) {
    saveWorkflowName();
  }
});

// === Dropdown Menu Item Clicks ===

elements.workflowMenuItems.addEventListener("click", (e) => {
  const item = e.target.closest(".workflow-menu-item");
  if (!item) return;

  const filePath = item.dataset.filePath;
  if (filePath) {
    loadWorkflowFromHistory(filePath);
    closeRecentWorkflowsDropdown();
  }
});

// === Click Outside to Close Dropdown ===

function handleWorkflowDropdownClickOutside(e) {
  const dropdown = elements.workflowRecentMenu;
  const trigger = elements.btnWorkflowDropdown;

  if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
    closeRecentWorkflowsDropdown();
  }
}
```

#### 4. Core Functions

```javascript
/**
 * Toggle recent workflows dropdown
 */
async function toggleRecentWorkflowsDropdown() {
  const isOpen = !elements.workflowRecentMenu.hidden;

  if (isOpen) {
    closeRecentWorkflowsDropdown();
  } else {
    await openRecentWorkflowsDropdown();
  }
}

/**
 * Open recent workflows dropdown
 */
async function openRecentWorkflowsDropdown() {
  // Request recent workflows from backend
  vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });

  // Show dropdown (will be populated when backend responds)
  elements.workflowRecentMenu.hidden = false;
  elements.btnWorkflowDropdown.setAttribute("aria-expanded", "true");

  // Add click-outside listener
  setTimeout(() => {
    document.addEventListener("click", handleWorkflowDropdownClickOutside);
  }, 0);
}

/**
 * Close recent workflows dropdown
 */
function closeRecentWorkflowsDropdown() {
  elements.workflowRecentMenu.hidden = true;
  elements.btnWorkflowDropdown.setAttribute("aria-expanded", "false");

  // Remove click-outside listener
  document.removeEventListener("click", handleWorkflowDropdownClickOutside);
}

/**
 * Populate recent workflows dropdown
 */
function populateRecentWorkflows(workflows) {
  workflowStatusState.recentWorkflows = workflows;

  // Update badge count
  if (workflows.length > 0) {
    elements.workflowCountBadge.textContent = workflows.length.toString();
    elements.workflowCountBadge.hidden = false;
  } else {
    elements.workflowCountBadge.hidden = true;
  }

  // Clear existing items
  elements.workflowMenuItems.innerHTML = "";

  if (workflows.length === 0) {
    elements.workflowMenuItems.innerHTML = `
      <div class="workflow-menu-empty">
        No recent workflows
      </div>
    `;
    return;
  }

  // Add workflow items (sorted by most recent)
  workflows.forEach((workflow) => {
    const isCurrent = workflow.filePath === workflowStatusState.currentFilePath;
    const stateClass = `state-${workflow.executionState.toLowerCase()}`;

    const item = document.createElement("button");
    item.className = `workflow-menu-item ${isCurrent ? "current" : ""}`;
    item.dataset.filePath = workflow.filePath;
    item.title = workflow.filePath;
    item.innerHTML = `
      <span class="workflow-menu-item-name">${escapeHtml(
        workflow.workflowName
      )}</span>
      <span class="workflow-menu-item-state ${stateClass}">
        ${workflow.executionState}
      </span>
    `;

    elements.workflowMenuItems.appendChild(item);
  });
}

/**
 * Load workflow from history
 */
function loadWorkflowFromHistory(filePath) {
  vscode.postMessage({
    type: MESSAGE_TYPES.LOAD_WORKFLOW,
    filePath: filePath,
  });
}

/**
 * Start editing workflow name
 */
function startEditingWorkflowName() {
  if (!state.fileName) return;

  workflowStatusState.isEditing = true;
  workflowStatusState.originalName = elements.workflowName.textContent;

  // Hide split button, show input
  elements.workflowSplitButton.style.display = "none";
  elements.workflowNameEdit.style.display = "inline-block";
  elements.workflowNameEdit.value = workflowStatusState.originalName;
  elements.workflowNameEdit.focus();
  elements.workflowNameEdit.select();
}

/**
 * Cancel editing workflow name
 */
function cancelEditingWorkflowName() {
  workflowStatusState.isEditing = false;

  // Hide input, show split button
  elements.workflowNameEdit.style.display = "none";
  elements.workflowSplitButton.style.display = "inline-flex";
}

/**
 * Save workflow name
 */
function saveWorkflowName() {
  const newName = elements.workflowNameEdit.value.trim();

  // Validate
  if (!newName) {
    cancelEditingWorkflowName();
    return;
  }

  // Check if changed
  if (newName === workflowStatusState.originalName) {
    cancelEditingWorkflowName();
    return;
  }

  // Send to backend
  vscode.postMessage({
    type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME,
    workflowName: newName,
  });

  // Update UI optimistically
  elements.workflowName.textContent = newName;
  cancelEditingWorkflowName();
}

/**
 * Update workflow status display
 */
function updateWorkflowStatus(fileName, executionState, workflowName) {
  workflowStatusState.currentFilePath = fileName;

  if (!fileName) {
    // No workflow loaded
    elements.workflowSplitButton.style.display = "none";
    elements.workflowEmptyState.style.display = "inline";
    elements.statusSeparator.style.display = "none";
    elements.btnWorkflowDropdown.disabled = true;
    return;
  }

  // Workflow loaded
  elements.workflowEmptyState.style.display = "none";
  elements.workflowSplitButton.style.display = "inline-flex";

  // Update workflow name
  const displayName = workflowName || getWorkflowName(fileName);
  elements.workflowName.textContent = displayName;

  // Update execution state
  if (executionState && executionState !== EXECUTION_STATES.IDLE) {
    elements.statusSeparator.style.display = "inline";
    elements.executionState.style.display = "inline";
    elements.executionState.textContent = executionState;
    elements.executionState.className = `execution-state-${executionState.toLowerCase()}`;
  } else {
    elements.statusSeparator.style.display = "none";
    elements.executionState.style.display = "none";
  }

  // Disable dropdown trigger when workflow is RUNNING
  // (matches "New Workflow" button behavior - prevent interrupting active workflow)
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  elements.btnWorkflowDropdown.disabled = isRunning;

  if (isRunning) {
    elements.btnWorkflowDropdown.title =
      "Cannot switch workflows while running";
  } else {
    elements.btnWorkflowDropdown.title = "Show recent workflowse";
    elements.executionState.style.display = "none";
  }
}
```

#### 5. Message Handlers

```javascript
window.addEventListener("message", (event) => {
  const message = event.data;

  switch (message.type) {
    case MESSAGE_TYPES.STATE_UPDATE:
      // ... existing state update logic ...
      updateWorkflowStatus(
        message.fileName,
        message.executionState,
        message.workflowName
      );
      break;

    case MESSAGE_TYPES.RECENT_WORKFLOWS:
      populateRecentWorkflows(message.workflows);
      break;

    case MESSAGE_TYPES.WORKFLOW_NAME_UPDATED:
      // Backend confirmed name update
      elements.workflowName.textContent = message.workflowName;
      break;

    // ... other message handlers ...
  }
});
```

### Phase 4: Backend Integration

#### DashboardConstants.ts

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  UPDATE_WORKFLOW_NAME: "updateWorkflowName",
  WORKFLOW_NAME_UPDATED: "workflowNameUpdated",
  GET_RECENT_WORKFLOWS: "getRecentWorkflows",
  RECENT_WORKFLOWS: "recentWorkflows",
  LOAD_WORKFLOW: "loadWorkflow",
  CLEAR_WORKFLOW_HISTORY: "clearWorkflowHistory",
} as const;
```

#### FlightPathDashboardProvider.ts

```typescript
private async handleWebviewMessage(message: any): Promise<void> {
  // ... existing handlers ...

  if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_NAME) {
    await this.handleUpdateWorkflowName(message);
    return;
  }

  if (message.type === MESSAGE_TYPES.GET_RECENT_WORKFLOWS) {
    await this.handleGetRecentWorkflows();
    return;
  }

  if (message.type === MESSAGE_TYPES.LOAD_WORKFLOW) {
    await this.handleLoadWorkflow(message);
    return;
  }

  if (message.type === MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY) {
    await this.handleClearWorkflowHistory();
    return;
  }
}

/**
 * Update workflow name
 */
private async handleUpdateWorkflowName(message: any): Promise<void> {
  const { workflowName } = message;

  try {
    await this.flightPathManager?.updateWorkflowName(workflowName);

    // Confirm update
    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.WORKFLOW_NAME_UPDATED,
      workflowName,
    });
  } catch (error) {
    Log.error("Failed to update workflow name:", error);
    vscode.window.showErrorMessage(
      `Failed to update workflow name: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get recent workflows from .flightpath/.queue
 */
private async handleGetRecentWorkflows(): Promise<void> {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.webviewView?.webview.postMessage({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
      return;
    }

    const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");

    // Check if queue directory exists
    if (!fs.existsSync(queueDir)) {
      this.webviewView?.webview.postMessage({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
      return;
    }

    // Read all .flightpath.json files
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".flightpath.json"));

    // Parse each file and extract metadata
    const workflows = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(queueDir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf8");
          const workingFile = JSON.parse(content);

          return {
            filePath,
            workflowName: workingFile.workflowName || file.replace(".flightpath.json", ""),
            executionState: workingFile._runtime?.executionState || "IDLE",
            startedAt: workingFile.startedAt || 0,
          };
        } catch (error) {
          Log.warn(`Failed to parse workflow file ${file}:`, error);
          return null;
        }
      })
    );

    // Filter out nulls and sort by most recent
    const validWorkflows = workflows
      .filter((w) => w !== null)
      .sort((a, b) => b!.startedAt - a!.startedAt);

    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.RECENT_WORKFLOWS,
      workflows: validWorkflows,
    });
  } catch (error) {
    Log.error("Failed to get recent workflows:", error);
    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.RECENT_WORKFLOWS,
      workflows: [],
    });
  }
}

/**
 * Load workflow from file path
 */
private async handleLoadWorkflow(message: any): Promise<void> {
  const { filePath } = message;

  try {
    await this.flightPathManager?.loadWorkingFile(filePath);
  } catch (error) {
    Log.error("Failed to load workflow:", error);
    vscode.window.showErrorMessage(
      `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Clear workflow history
 */
private async handleClearWorkflowHistory(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Delete all workflow history files from .flightpath/.queue?",
    { modal: true },
    "Delete All"
  );

  if (confirm !== "Delete All") return;

  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");

    if (fs.existsSync(queueDir)) {
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".flightpath.json"));
      for (const file of files) {
        fs.unlinkSync(path.join(queueDir, file));
      }
    }

    vscode.window.showInformationMessage("Workflow history cleared");

    // Refresh recent workflows
    await this.handleGetRecentWorkflows();
  } catch (error) {
    Log.error("Failed to clear workflow history:", error);
    vscode.window.showErrorMessage(
      `Failed to clear history: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Include workflowName in state updates
 */
private getStateUpdateMessage(): any {
  const state = this.flightPathManager?.getQueueState();
  if (!state) return null;

  return {
    type: MESSAGE_TYPES.STATE_UPDATE,
    fileName: state.workingFilePath || null,
    workflowName: state.workflowName || null, // Include workflow name
    prompts: state.prompts,
    executionState: state.executionState,
    // ... rest of state
  };
}
```

#### FlightPathManager.ts

```typescript
/**
 * Update workflow name
 */
async updateWorkflowName(workflowName: string): Promise<void> {
  if (!this.promptQueue) {
    throw new Error("No active queue");
  }

  await this.promptQueue.updateWorkflowName(workflowName);
  this.notifyStateChange(); // Trigger dashboard update
}

/**
 * Load working file from path
 */
async loadWorkingFile(filePath: string): Promise<void> {
  if (!this.promptQueue) {
    throw new Error("Queue not initialized");
  }

  await this.promptQueue.loadWorkingFile(filePath);
  this.notifyStateChange();
}
```

#### PromptQueue.ts

```typescript
/**
 * Update workflow name in working file
 */
async updateWorkflowName(workflowName: string): Promise<void> {
  if (!this.state.workingFilePath) {
    throw new Error("Cannot update workflow name: no working file");
  }

  // Update in-memory state
  this.state.workflowName = workflowName;

  // Update working file
  await this.saveWorkingFile();
}

/**
 * Get queue state (include workflowName)
 */
getQueueState(): QueueState {
  return {
    prompts: this.state.prompts,
    currentIndex: this.state.currentIndex,
    results: this.state.results,
    workingFilePath: this.state.workingFilePath,
    workflowName: this.state.workflowName, // Include workflow name
    originalFilePath: this.state.originalFilePath,
    startedAt: this.state.startedAt,
  };
}
```

## User Experience Flows

### Flow 1: Edit Current Workflow Name

1. User has active workflow "feature-implementation - RUNNING"
2. User clicks main button (workflow name area)
3. Split button hides, inline text input appears with "feature-implementation" selected
4. User types "user-auth-feature"
5. User presses Enter (or clicks away)
6. Input hides, split button reappears wiPAUSED" (or COMPLETED/ERROR/IDLE)
7. User clicks dropdown trigger (chevron icon)
8. Dropdown opens showing:
   - **bug-fixes - PAUSED** (current, highlighted)
   - refactor-tests - COMPLETED
   - api-migration - ERROR
   - docs-update - IDLE
9. User clicks "refactor-tests - COMPLETED"
10. Dropdown closes
11. Dashboard loads `refactor-tests` workflow
12. Main button updates to "refactor-tests - COMPLETED"
13. Prompts list updates to show refactor-tests prompts

**Note**: If workflow is RUNNING, the dropdown trigger is disabled to prevent interrupting execution.

- docs-update - IDLE

4. User clicks "refactor-tests - COMPLETED"
5. Dropdown closes
6. Dashboard loads `refactor-tests` workflow
7. Main button updates to "refactor-tests - COMPLETED"
8. Prompts list updates to show refactor-tests prompts

### Flow 3: Browse Recent Workflows (No Selection)

1. User clicks dropdown trigger
2. Dropdown shows 5 recent workflows
3. User hovers over items (see preview in tooltip)
4. User clicks outside dropdown to close
5. Current workflow unchanged

### Flow 4: Clear Workflow History

1. User clicks dropdown trigger
2. User scrolls to bottom of dropdown
3. User clicks "Clear History" button
4. Confirmation modal appears: "Delete all workflow history files from .flightpath/.queue?"
5. User clicks "Delete All"
6. All working files deleted
7. Dropdown updates to show "No recent workflows"
8. Current workflow unaffected (still in memory)

## Benefits

1. **Discoverability**: Recent workflows visible via dropdown
2. **Efficiency**: Quick switching without file picker navigation
3. **Context awareness**: State badges show workflow status at a glance
4. **Editability**: Inline name editing for better organization
5. **Consistency**: Matches split button pattern from "New Workflow" button
6. **Visual feedback**: Current workflow highlighted in dropdown
7. **History management**: Clear history action for cleanup

## Edge Cases & Considerations

1. **No workflows**: Dropdown shows "No recent workflows" message
2. **Very long workflow names**: Truncate in UI with ellipsis, show full name in tooltip
3. **Many workflows**: Dropdown scrolls, max height 400px
4. **Editing during execution**: Allow editing workflow name when paused or running (non-destructive)
5. **Switching during execution**: **DISABLE** dropdown trigger when execution state is RUNNING to prevent interrupting active workflow
6. **Concurrent workflows**: Only one active at a time (current workflow highlighted) - parallel execution not yet supported
7. **File system errors**: Graceful error handling if working file deleted externally
8. **Badge count**: Only show if > 0 wo (when NOT running)

- [ ] Dropdown trigger is disabled when execution state is RUNNING
- [ ] Dropdown trigger shows tooltip explaining why disabled when running
- [ ] Clicking workflow item loads that workflow
- [ ] Clicking outside dropdown closes it
- [ ] Pressing Enter saves workflow name
- [ ] Pressing Escape cancels edit
- [ ] Blur on input saves workflow name
- [ ] Badge count updates correctly
- [ ] Cannot open dropdown when workflow is running
- [ ] Can open dropdown when workflow is paused, completed, or in error state
- [ ] Split button renders correctly in light/dark themes
- [ ] Dropdown menu aligns properly below button
- [ ] Workflow items display name and state correctly
- [ ] Current workflow highlighted with distinct background
- [ ] State badges use correct colors per execution state
- [ ] Inline edit input matches VS Code input styling
- [ ] Long workflow names truncate with ellipsis
- [ ] Dropdown scrolls when > 10 items

### Interaction Testing

- [ ] Main button click enters edit mode
- [ ] Dropdown trigger click opens menu
- [ ] Clicking workflow item loads that workflow
- [ ] Clicking outside dropdown closes it
- [ ] Pressing Enter saves workflow name
- [ ] Pressing Escape cancels edit
- [ ] RUNNING state: Dropdown trigger disabled
- [ ] PAUSED state: Dropdown trigger enabled
- [ ] COMPLETED state: Dropdown trigger enabled
- [ ] ERROR state: Dropdown trigger enabled
- [ ] IDLE state: Dropdown trigger enabled
- [ ] Disabled state: Shows 50% opacity and "not-allowed" cursor
- [ ] Blur on input saves workflow name
- [ ] Badge count updates correctly

### State Testing

- [ ] No workflow: Shows empty state
- [ ] Workflow loaded: Shows split button
- [ ] Name editing: Hides split button, shows input
- [ ] Dropdown open: Aria-expanded="true"
- [ ] Recent workflows: Sorted by most recent first
- [ ] Current workflow: Highlighted in dropdown

### Backend Integration Testing

- [ ] UPDATE_WORKFLOW_NAME updates working file
- [ ] GET_RECENT_WORKFLOWS scans .flightpath/.queue
- [ ] LOAD_WORKFLOW loads selected workflow
- [ ] State updates include workflowName
- [ ] Working file persists workflowName

## Implementation Phases

### Phase 1: HTML/CSS Structure

- [ ] Add disabled check in dropdown trigger click handler
- [ ] Implement startEditingWorkflowName()
- [ ] Implement cancelEditingWorkflowName()
- [ ] Implement saveWorkflowName()
- [ ] Implement toggleRecentWorkflowsDropdown()
- [ ] Implement populateRecentWorkflows()
- [ ] Implement loadWorkflowFromHistory()
- [ ] Update updateWorkflowStatus() to use workflowName
- [ ] Update updateWorkflowStatus() to disable dropdown when RUNNING
- [ ] Update updateWorkflowStatus() to update tooltip based on disabled stat

### Phase 2: JavaScript Behavior

- [ ] Add workflowStatusState management
- [ ] Add DOM element references
- [ ] Add event listeners (click, blur, keydown)
- [ ] Implement startEditingWorkflowName()
- [ ] Implement cancelEditingWorkflowName()
- [ ] Implement saveWorkflowName()
- [ ] Implement toggleRecentWorkflowsDropdown()
- [ ] Implement populateRecentWorkflows()
- [ ] Implement loadWorkflowFromHistory()
- [ ] Update updateWorkflowStatus() to use workflowName

### Phase 3: Backend Integration

- [ ] Add MESSAGE_TYPES to DashboardConstants.ts
- [ ] Add handleUpdateWorkflowName() in FlightPathDashboardProvider
- [ ] Add handleGetRecentWorkflows() in FlightPathDashboardProvider
- [ ] Add handleLoadWorkflow() in FlightPathDashboardProvider
- [ ] Add handleClearWorkflowHistory() in FlightPathDashboardProvider
- [ ] Add updateWorkflowName() in FlightPathManager
- [ ] Add loadWorkingFile() in FlightPathManager
- [ ] Add updateWorkflowName() in PromptQueue
- [ ] Include workflowName in getQueueState()

### Phase 4: Testing & Polish

- [ ] Test inline editing in all execution states
- [ ] Test dropdown with 0, 1, 5, 20 workflows
- [ ] Test loading workflows with different states
- [ ] Test editing workflow name persistence
- [ ] Test clear history action
- [ ] Test keyboard navigation (Tab, Enter, Escape)
- [ ] Test accessibility (screen readers)
- [ ] Update user documentation

## Open Questions

### Q1: Should recent workflows list include original files?

**Options**:

1. **Working files only** (proposed) - Only show `.flightpath/.queue` files
2. **Both** - Show working files + original source files from workspace

**Decision**: Working files only (simpler, matches session history UX)

### Q2: How many recent workflows to show?

**Options**:

1. **Unlimited** (proposed) - Show all, use scrolling
2. **Top 10** - Limit to most recent 10
3. **Configurable** - Add setting for max count

**Decision**: Unlimited with scrolling (users can manually clear if needed)

### Q3: Should dropdown show file timestamps?

**Options**:

1. **No timestamps** (proposed) - Clean, name + state only
2. **Relative timestamps** - "2 hours ago", "Yesterday"
3. **Absolute timestamps** - "Jan 11, 2026 2:30 PM"

**Decision**: No timestamps initially, add if users request it

### Q4: Should editing be restricted during execution?

**Options**:

1. **Allow always** (proposed) - Name editing is non-destructive
2. **Block during running** - Disable button when state=RUNNING
3. **Prompt for confirmation** - "Workflow is running, edit anyway?"

**Decision**: Allow always (renaming doesn't affect execution)

### Q5: Should workflow switching be allowed during execution?

**Options**:

1. **Allow always** - User can switch away from running workflow
2. **Block during running** (proposed) - Disable dropdown trigger when state=RUNNING
3. **Prompt for confirmation** - "Stop current workflow and switch?"

**Decision**: Block during running

- **Rationale**: Switching workflows would interrupt the currently executing workflow, potentially leaving it in an inconsistent state
- **Consistency**: Matches "New Workflow" button behavior (also disabled when running)
- **Future**: When parallel workflow support is added, this restriction can be removed
- **UX**: Dropdown trigger shows disabled state with tooltip explaining why
- **Distinction**: Editing workflow name (main button) remains enabled since it's non-destructive

## Alternative Designs Considered

### Alternative 1: Dropdown-Only Button

```
[workflow-name - RUNNING ▼]
```

**Pros**: Single button, simpler
**Cons**: No visual distinction between edit and switch actions

### Alternative 2: Separate Edit Icon

```
[workflow-name - RUNNING] [✏️] [▼]
```

**Pros**: Clearer action separation
**Cons**: Takes more horizontal space, three buttons

### Alternative 3: Context Menu on Right-Click

```
[workflow-name - RUNNING] ← Right-click for menu
```

**Pros**: No dropdown trigger needed
**Cons**: Not discoverable, right-click not obvious

**Selected**: Split button (proposed design) balances discoverability and space efficiency

## Success Metrics

### Adoption Metrics

- Track split button main clicks (edit name)
- Track dropdown trigger clicks (recent workflows)
- Track workflow switches via dropdown
- Goal: 30% of users use dropdown for workflow switching

### User Satisfaction Metrics

- Monitor feedback on workflow switching UX
- Track time saved vs. "Load from File" approach
- Goal: Positive feedback, reduced file picker usage

### Technical Metrics

- Measure dropdown rendering performance
- Measure recent workflows query time
- Goal: <50ms to open dropdown, <100ms to load workflows

## Related Work

### VS Code Examples

**Git Branches Dropdown**:

```
[main ▼]
  ↓
┌─────────────────┐
│ ✓ main          │
│   feature-auth  │
│   bugfix-123    │
└─────────────────┘
```

**Reference**: Similar pattern for switching between states

**Editor Tab Context Menu**:

- Right-click tab → "Close Others", "Close All", etc.
- **Reference**: Context actions on current item

### Internal References

- **LOAD_BUTTON_SPLIT_DROPDOWN.md**: Split dropdown pattern
- **WORKFLOW_NAME_PLAN.md**: workflowName property implementation
- **dashboard.html:86-101**: Current workflow-status div
- **dashboard.js:247-260**: getWorkflowName() function

## Changelog

### January 11, 2026 - Initial Draft

- Analyzed current workflow-status structure
- Proposed split button design (edit name + recent workflows)
- Documented HTML/CSS/JS implementation plan
- Added backend integration requirements
- Created comprehensive testing checklist
- Identified 4 open questions for decision
