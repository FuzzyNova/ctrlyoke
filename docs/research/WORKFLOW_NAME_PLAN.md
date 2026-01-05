# Workflow Name Implementation Plan

## Overview
Add `workflowName` as an **optional, user-editable display name** for workflows that:
1. Can be set when creating new workflows (via prompt name input or modal)
2. Is stored in both source prompt files and working files
3. Can be edited inline by double-clicking the workflow title in the dashboard
4. Persists through workflow execution and resumption

## Current State Analysis

### Schema (Already Exists - Needs Enhancement)
- `workflowName` currently exists in schema but marked as "working files only"
- Currently derived from filename, not user-editable
- No UI for editing after creation

### TypeScript Types (FlightPathTypes.ts)
```typescript
export interface WorkingFile extends PromptFile {
  originalFile: string;
  workflowName: string; // Currently: Derived from filename (required)
  startedAt: number;
  _runtime?: WorkingFileRuntime;
}
```

### Current Usage
1. **PromptQueue.ts** (line 1045): Sets `workflowName` from filename
2. **QueueOperations.ts** (line 91-99): Extracts from working file path
3. **Dashboard.js** (line 247-251): `getWorkflowName()` extracts from file path

## Proposed Changes

### 1. Schema Updates (prompt-schema.json)

**Goal**: Make `workflowName` available in both source files AND working files

#### Option A: Top-level property (RECOMMENDED)
Add `workflowName` at the top level alongside `prompts`:

```json
{
  "properties": {
    "workflowName": {
      "type": "string",
      "description": "Optional display name for this workflow. If omitted, derived from filename. Can be edited in the dashboard.",
      "maxLength": 100
    },
    "prompts": {
      "type": "array",
      "items": { "$ref": "#/definitions/promptItem" }
    },
    "originalFile": {
      "type": "string",
      "description": "Path to original prompt file (working files only)"
    },
    "startedAt": {
      "type": "number",
      "description": "Timestamp when workflow started (working files only)"
    },
    "_runtime": {
      "$ref": "#/definitions/runtimeMetadata"
    }
  },
  "required": ["prompts"]
}
```

**Rationale**:
- Allows users to set workflow name in source `.flightpath.json` files
- Carries over to working files automatically
- Provides better IntelliSense in VS Code
- Clear separation from runtime-only properties

#### Option B: Keep working-files-only, add to PromptItem
Add `workflowName` to individual prompt items (NOT RECOMMENDED - too granular)

### 2. TypeScript Type Updates

#### FlightPathTypes.ts
```typescript
export interface PromptFile {
  prompt?: string;
  prompts?: PromptItem[];
  workflowName?: string; // NEW: Optional display name
}

export interface WorkingFile extends PromptFile {
  originalFile: string;
  workflowName: string; // Now required in working files (derived from property or filename)
  startedAt: number;
  _runtime?: WorkingFileRuntime;
}
```

#### DashboardConstants.ts
Add new message types for workflow name editing:

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...
  UPDATE_WORKFLOW_NAME: "updateWorkflowName",
  WORKFLOW_NAME_UPDATED: "workflowNameUpdated",
} as const;
```

### 3. Dashboard UI Updates

#### HTML (dashboard.html - line 285)
Make workflow name editable on double-click:

```html
<div id="workflow-status">
  <span
    id="workflow-name"
    class="workflow-name-editable"
    title="Double-click to edit workflow name"
  >
    No workflow loaded
  </span>
  <input
    id="workflow-name-edit"
    class="workflow-name-input-inline"
    style="display: none"
    maxlength="100"
  />
  <span id="status-separator" class="status-separator" style="display: none">-</span>
  <span id="execution-state" class="execution-state-idle" style="display: none">Idle</span>
</div>
```

#### CSS (dashboard.css)
```css
.workflow-name-editable {
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: background-color 0.2s;
}

.workflow-name-editable:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.workflow-name-input-inline {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  padding: 2px 4px;
  border: 1px solid var(--vscode-focusBorder);
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border-radius: 3px;
}
```

#### JavaScript (dashboard.js)

**1. Add elements to DOM references (line 36)**
```javascript
const elements = {
  workflowName: document.getElementById("workflow-name"),
  workflowNameEdit: document.getElementById("workflow-name-edit"),
  // ... existing elements ...
};
```

**2. Add state for workflow name editing**
```javascript
let workflowNameEditState = {
  isEditing: false,
  originalValue: "",
};
```

**3. Add event listeners for inline editing**
```javascript
// Double-click to edit workflow name
elements.workflowName.addEventListener("dblclick", () => {
  if (state.fileName) {
    startEditingWorkflowName();
  }
});

// Save on Enter, cancel on Escape
elements.workflowNameEdit.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    saveWorkflowName();
  } else if (e.key === "Escape") {
    cancelEditingWorkflowName();
  }
});

// Save on blur
elements.workflowNameEdit.addEventListener("blur", () => {
  if (workflowNameEditState.isEditing) {
    saveWorkflowName();
  }
});
```

**4. Add helper functions**
```javascript
function startEditingWorkflowName() {
  workflowNameEditState.isEditing = true;
  workflowNameEditState.originalValue = elements.workflowName.textContent;

  elements.workflowName.style.display = "none";
  elements.workflowNameEdit.style.display = "inline-block";
  elements.workflowNameEdit.value = workflowNameEditState.originalValue;
  elements.workflowNameEdit.focus();
  elements.workflowNameEdit.select();
}

function cancelEditingWorkflowName() {
  workflowNameEditState.isEditing = false;
  elements.workflowNameEdit.style.display = "none";
  elements.workflowName.style.display = "inline";
}

function saveWorkflowName() {
  const newName = elements.workflowNameEdit.value.trim();

  // Validate
  if (!newName) {
    cancelEditingWorkflowName();
    return;
  }

  // Check if changed
  if (newName === workflowNameEditState.originalValue) {
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
```

**5. Update state initialization handler**
```javascript
case MESSAGE_TYPES.STATE_UPDATE:
  state.fileName = message.fileName || null;
  state.prompts = message.prompts || [];
  state.executionState = message.executionState || EXECUTION_STATES.IDLE;
  state.currentStep = message.currentStep || 0;
  state.totalSteps = message.totalSteps || 0;

  // NEW: Store workflow name from working file
  if (message.workflowName) {
    elements.workflowName.textContent = message.workflowName;
  } else {
    elements.workflowName.textContent = getWorkflowName(state.fileName);
  }

  updateWorkflowStatus(state.fileName, state.executionState);
  // ... rest of handler
```

### 4. Backend Integration

#### FlightPathDashboardProvider.ts

**1. Add message handler**
```typescript
private async handleWebviewMessage(message: any): Promise<void> {
  // ... existing handlers ...

  if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_NAME) {
    this.handleUpdateWorkflowName(message);
    return;
  }
}

private async handleUpdateWorkflowName(message: any): Promise<void> {
  if (!this.flightPathManager) {
    Log.error("FlightPathManager not initialized");
    return;
  }

  const { workflowName } = message;

  try {
    await this.flightPathManager.updateWorkflowName(workflowName);
    // Success feedback already handled by state update
  } catch (error) {
    Log.error("Failed to update workflow name:", error);
    vscode.window.showErrorMessage(
      `Failed to update workflow name: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
```

**2. Include workflowName in state updates**
```typescript
private getStateUpdateMessage(): any {
  const state = this.flightPathManager?.getQueueState();
  if (!state) return null;

  return {
    type: MESSAGE_TYPES.STATE_UPDATE,
    fileName: state.workingFilePath || null,
    workflowName: state.workflowName || null, // NEW
    prompts: state.prompts,
    // ... rest of state
  };
}
```

#### FlightPathManager.ts

**1. Add updateWorkflowName method**
```typescript
async updateWorkflowName(workflowName: string): Promise<void> {
  if (!this.promptQueue) {
    throw new Error("No active queue");
  }

  await this.promptQueue.updateWorkflowName(workflowName);
  this.notifyStateChange(); // Trigger dashboard update
}
```

**2. Update executeEphemeralPrompt to use promptName as workflowName**
```typescript
async executeEphemeralPrompt(
  text: string,
  properties: any,
  action: "run" | "append" | "appendNext",
  promptName?: string
): Promise<void> {
  // ... existing code ...

  const promptFile: PromptFile = {
    prompts: [promptItem as PromptItem],
    workflowName: promptName || undefined, // NEW: Set workflowName from promptName
  };

  // ... rest of implementation
}
```

#### PromptQueue.ts

**1. Add workflowName to QueueState**
```typescript
interface QueueState {
  prompts: PromptItem[];
  currentIndex: number;
  results: ExecutionResult[];
  workingFilePath?: string;
  workflowName?: string; // NEW: Store workflow name separately
  originalFilePath?: string;
  startedAt?: number;
}
```

**2. Add updateWorkflowName method**
```typescript
async updateWorkflowName(workflowName: string): Promise<void> {
  if (!this.state.workingFilePath) {
    throw new Error("Cannot update workflow name: no working file");
  }

  // Update in-memory state
  this.state.workflowName = workflowName;

  // Update working file
  await this.saveWorkingFile();
}
```

**3. Update createWorkingFile to include workflowName from source**
```typescript
private async createWorkingFile(
  promptFile: PromptFile,
  originalFilePath?: string
): Promise<string> {
  // ... existing code ...

  const workingFile: WorkingFile = {
    originalFile: originalFilePath,
    workflowName: promptFile.workflowName || // NEW: Use from source file if available
                  (originalFilePath
                    ? path.basename(originalFilePath, path.extname(originalFilePath))
                    : "ephemeral-workflow"),
    startedAt: Date.now(),
    prompts: this.state.prompts,
    _runtime: {
      currentIndex: this.state.currentIndex,
      completedPrompts: this.state.results
        .filter((r) => r.status === "completed")
        .map((r) => r.promptId),
      executionState: this.executionState,
    },
  };

  // ... rest of implementation
}
```

**4. Update loadWorkingFile to extract workflowName**
```typescript
async loadWorkingFile(filePath: string): Promise<void> {
  // ... existing code ...

  const workingFile: WorkingFile = JSON.parse(content);

  this.state = {
    prompts: workingFile.prompts || [],
    currentIndex: runtime?.currentIndex ?? 0,
    results: [],
    workingFilePath: filePath,
    workflowName: workingFile.workflowName, // NEW: Extract from file
    originalFilePath: workingFile.originalFile,
    startedAt: workingFile.startedAt,
  };

  // ... rest of implementation
}
```

#### PromptFileParser.ts

**1. Update parsePromptFile to preserve workflowName**
```typescript
async parsePromptFile(filePath: string): Promise<PromptFile> {
  // ... existing parsing logic ...

  const result: PromptFile = {
    prompts: parsedData.prompts || [parsedData],
    workflowName: parsedData.workflowName, // NEW: Extract if present
  };

  return result;
}
```

### 5. User Flow Examples

#### Flow 1: Create with Prompt Name
1. User opens dashboard
2. User types prompt name "refactor auth"
3. User types prompt text
4. User clicks "Run"
5. Workflow created with:
   - Filename: `refactor-auth-20260105-182500.flightpath.json`
   - workflowName: `"refactor auth"` (stored in JSON)
   - Dashboard title: "refactor auth"

#### Flow 2: Edit Existing Workflow Name
1. User has active workflow "fix tests"
2. User double-clicks workflow title
3. Inline input appears with "fix tests" selected
4. User types "integration tests"
5. User presses Enter
6. Dashboard updates to "integration tests"
7. Working file updated with `workflowName: "integration tests"`
8. Filename stays: `fix-tests-20260105-182500.flightpath.json`

#### Flow 3: Load Workflow with Custom Name
1. User has source file with:
   ```json
   {
     "workflowName": "My Feature Implementation",
     "prompts": [...]
   }
   ```
2. User loads workflow
3. Dashboard shows "My Feature Implementation"
4. Working file inherits workflowName

## Implementation Phases

### Phase 1: Schema & Types (Foundation)
- [ ] Update `prompt-schema.json` to add `workflowName` at top level
- [ ] Regenerate YAML schema
- [ ] Update `FlightPathTypes.ts` interfaces
- [ ] Update `DashboardConstants.ts` with new message types

### Phase 2: Backend Logic
- [ ] Update `PromptFileParser.ts` to extract/preserve `workflowName`
- [ ] Update `PromptQueue.ts`:
  - [ ] Add `workflowName` to QueueState
  - [ ] Add `updateWorkflowName()` method
  - [ ] Update `createWorkingFile()` to use source workflowName
  - [ ] Update `loadWorkingFile()` to extract workflowName
  - [ ] Update `saveWorkingFile()` to persist workflowName
- [ ] Update `FlightPathManager.ts`:
  - [ ] Add `updateWorkflowName()` method
  - [ ] Update `executeEphemeralPrompt()` to set workflowName from promptName
  - [ ] Update `getQueueState()` to include workflowName
- [ ] Update `FlightPathDashboardProvider.ts`:
  - [ ] Add `handleUpdateWorkflowName()` handler
  - [ ] Include workflowName in state updates

### Phase 3: Dashboard UI
- [ ] Update `dashboard.html`:
  - [ ] Add inline edit input element
  - [ ] Add title/cursor hints
- [ ] Update `dashboard.css`:
  - [ ] Style editable workflow name
  - [ ] Style inline input
- [ ] Update `dashboard.js`:
  - [ ] Add workflow name editing state
  - [ ] Add event listeners (dblclick, keydown, blur)
  - [ ] Add helper functions (start/cancel/save edit)
  - [ ] Update state handler to use workflowName from backend
  - [ ] Update `updateWorkflowStatus()` to prefer workflowName over filename

### Phase 4: Testing & Polish
- [ ] Test ephemeral prompt creation with name
- [ ] Test inline editing during execution (should work when paused)
- [ ] Test inline editing when workflow completed
- [ ] Test loading workflow with custom workflowName
- [ ] Test loading workflow without workflowName (falls back to filename)
- [ ] Test workflow name persistence across pause/resume
- [ ] Update user documentation

## Edge Cases & Considerations

1. **Empty workflow name**: Fall back to filename-based name
2. **Very long names**: Truncate in UI with ellipsis, store full name
3. **Special characters**: Allow in workflowName, sanitize for filename
4. **Concurrent edits**: Dashboard has single source of truth (working file)
5. **Editing during execution**: Allow editing when paused or completed
6. **Session resumption**: workflowName persists in working file

## Benefits

1. **User-friendly**: Meaningful names instead of kebab-case filenames
2. **Persistent**: Name follows workflow through execution
3. **Flexible**: Can be set at creation or edited later
4. **Optional**: Falls back gracefully to filename
5. **Searchable**: Session list can display custom names
6. **Professional**: Better UX for complex workflows

## Migration Strategy

- **Backward compatible**: Existing files without `workflowName` work fine
- **No breaking changes**: Optional field, graceful fallbacks
- **Gradual adoption**: Users can add names to existing workflows by editing
