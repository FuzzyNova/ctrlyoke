# In-Panel Prompt Editor Design

## Overview

This document describes the design and implementation plan for adding an in-panel text editor to the FlightPath dashboard. This feature will allow users to create and edit prompts directly within the custom webview panel, eliminating the need to switch to the VS Code text editor for basic prompt editing tasks.

## Goals

1. **Seamless editing experience**: Allow users to edit prompts without leaving the dashboard
2. **Create new prompts**: Support creating draft prompts (`.prompt.md`) directly in the panel
3. **Inline editing**: Enable editing of individual prompts within workflows
4. **Preserve workflow context**: Maintain visibility of the full workflow while editing
5. **Quick iterations**: Reduce friction for iterative prompt development

## Non-Goals

- Full-featured code editor with syntax highlighting (Monaco Editor integration)
- Multi-file editing capabilities
- Advanced editing features (find/replace, code folding, etc.)
- Replacing the VS Code editor entirely

## User Interface Design

### A. Editor Modes

The editor will support two primary modes:

#### 1. **Inline Edit Mode** (For existing prompts in workflows)

```
┌─────────────────────────────────────────────────────────┐
│ Prompts                                        [1 of 3] │
├─────────────────────────────────────────────────────────┤
│ ✅ 1. Analyze the codebase structure              [Edit]│
│                                                          │
│ ▶️  2. Implement feature based on analysis        [Edit]│
│     ┌──────────────────────────────────────────────┐   │
│     │ Editing Prompt 2:                      [✓][✗]│   │
│     ├──────────────────────────────────────────────┤   │
│     │ ┌──────────────────────────────────────────┐ │   │
│     │ │ Implement feature based on analysis   │ │ │   │
│     │ │                                        │ │ │   │
│     │ │ Use the insights from prompt 1 to    │ │ │   │
│     │ │ create a new feature for user auth   │ │ │   │
│     │ │                                        │ │ │   │
│     │ └──────────────────────────────────────────┘ │   │
│     │ Model: [claude-sonnet-4.5 ▼]                │   │
│     └──────────────────────────────────────────────┘   │
│                                                          │
│ ⏸️  3. Write tests for the new feature            [Edit]│
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Expand inline when "Edit" is clicked
- Show textarea with current prompt content
- Model selector (if workflow allows per-prompt models)
- Save/Cancel buttons (✓ / ✗)
- Collapse back to compact view on save/cancel

#### 2. **New Prompt Mode** (For creating draft prompts)

```
┌─────────────────────────────────────────────────────────┐
│ File: [No file selected]                                │
│ [Select] [Edit] | [New Prompt ▼] [New Workflow]         │
├─────────────────────────────────────────────────────────┤
│ Create New Prompt                                  [✓][✗]│
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Write your prompt here...                         │ │ │
│ │                                                     │ │ │
│ │                                                     │ │ │
│ │                                                     │ │ │
│ │                                                     │ │ │
│ │                                                     │ │ │
│ └─────────────────────────────────────────────────────┘ │
│ Filename: [my-prompt                ] .prompt.md         │
│ Save to: .flightpath/prompts/                            │
└─────────────────────────────────────────────────────────┘
```

**Features:**
- Full-panel editor overlay (similar to modal)
- Filename input with auto-suggestion
- Save location preview
- Create & Load button to immediately use the prompt
- Validation for filename conflicts

### B. UI Components

#### 1. **Prompt Item Enhancement**

Current prompt item structure needs an "Edit" button:

```html
<div class="prompt-item status-pending">
  <div class="prompt-header">
    <span class="prompt-icon">⏸️</span>
    <span class="prompt-text">1. Analyze codebase...</span>
    <button class="btn-edit" title="Edit this prompt">Edit</button>
  </div>
</div>
```

#### 2. **Inline Editor Component**

```html
<div class="inline-editor">
  <div class="editor-header">
    <span>Editing Prompt 2:</span>
    <div class="editor-actions">
      <button class="btn-save" title="Save changes">✓</button>
      <button class="btn-cancel" title="Cancel">✗</button>
    </div>
  </div>
  <div class="editor-body">
    <textarea
      class="prompt-editor-textarea"
      rows="6"
      placeholder="Enter prompt text...">
    </textarea>
    <div class="editor-options">
      <label>Model:</label>
      <select class="model-select">
        <option value="">Default</option>
        <option value="claude-sonnet-4.5">Claude Sonnet 4.5</option>
        <!-- Dynamically populated -->
      </select>
    </div>
  </div>
</div>
```

#### 3. **New Prompt Editor Component**

```html
<div class="new-prompt-editor" hidden>
  <div class="editor-overlay"></div>
  <div class="editor-panel">
    <div class="editor-header">
      <h3>Create New Prompt</h3>
      <div class="editor-actions">
        <button class="btn-save">✓ Save</button>
        <button class="btn-save-load">✓ Save & Load</button>
        <button class="btn-cancel">✗ Cancel</button>
      </div>
    </div>
    <div class="editor-body">
      <textarea
        class="prompt-editor-textarea"
        rows="15"
        placeholder="Write your prompt here...">
      </textarea>
      <div class="editor-metadata">
        <div class="filename-input-group">
          <label>Filename:</label>
          <input type="text" id="new-prompt-filename" placeholder="my-prompt">
          <span class="filename-extension">.prompt.md</span>
        </div>
        <p class="save-path-preview"></p>
        <p class="error-message" hidden></p>
      </div>
    </div>
  </div>
</div>
```

### C. Interaction Flow

#### Inline Editing Flow

1. User clicks "Edit" button on a prompt item
2. Prompt item expands to show inline editor
3. Textarea pre-filled with current prompt text
4. User edits text
5. User clicks Save (✓):
   - Validate changes
   - Update in-memory prompt
   - Update file on disk (if workflow file)
   - Collapse editor
   - Show success indicator
6. User clicks Cancel (✗):
   - Discard changes
   - Collapse editor

#### New Prompt Creation Flow

1. User clicks "New Prompt" dropdown
2. Options: "Draft Prompt (.prompt.md)" or "Workflow (.flightpath.json)"
3. For "Draft Prompt":
   - Show full-panel editor overlay
   - User enters prompt text
   - User enters filename
   - User clicks "Save" or "Save & Load"
   - Create file in `.flightpath/prompts/`
   - If "Save & Load", immediately load it into dashboard
4. For "Workflow":
   - Use existing "New Workflow" modal (already implemented)

### D. Visual Design

#### CSS Classes

```css
/* Inline Editor */
.inline-editor {
  background: var(--bg-primary);
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 4px;
  padding: var(--spacing-md);
  margin-top: var(--spacing-sm);
  animation: expandIn 0.2s ease-out;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-sm);
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-secondary);
}

.editor-actions {
  display: flex;
  gap: var(--spacing-xs);
}

.prompt-editor-textarea {
  width: 100%;
  min-height: 100px;
  padding: var(--spacing-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  resize: vertical;
  box-sizing: border-box;
}

.prompt-editor-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

/* New Prompt Editor (Full Panel) */
.new-prompt-editor {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.new-prompt-editor[hidden] {
  display: none;
}

.editor-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
}

.editor-panel {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  width: 90%;
  max-width: 700px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  animation: modalFadeIn 0.15s ease-out;
}

.editor-metadata {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

/* Edit button on prompt items */
.btn-edit {
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}

.prompt-item:hover .btn-edit {
  opacity: 1;
}

.btn-edit:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

@keyframes expandIn {
  from {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
  to {
    opacity: 1;
    max-height: 500px;
  }
}
```

## Data Handling

### A. State Management

Add new state properties to `dashboard.js`:

```javascript
let state = {
  fileName: null,
  prompts: [],
  executionState: EXECUTION_STATES.IDLE,
  currentStep: 0,
  totalSteps: 0,
  cliOutputs: {},
  retryStates: {},
  statusMessages: {},

  // NEW: Editor state
  editingPromptIndex: null,  // Index of prompt being edited, or null
  editingPromptOriginal: null, // Original prompt for cancel/revert
  newPromptEditorOpen: false,
};
```

### B. Message Types

Add new message types to `DashboardConstants.ts`:

```typescript
export const MESSAGE_TYPES = {
  // ... existing messages ...

  // Prompt editing messages
  EDIT_PROMPT: "editPrompt",           // Webview -> Extension
  SAVE_PROMPT_EDIT: "savePromptEdit",  // Webview -> Extension
  CREATE_DRAFT_PROMPT: "createDraftPrompt", // Webview -> Extension
  PROMPT_UPDATED: "promptUpdated",     // Extension -> Webview
  PROMPT_CREATED: "promptCreated",     // Extension -> Webview
} as const;
```

### C. File Operations

#### 1. **Editing Existing Prompts**

When editing prompts in a workflow (`.flightpath.json`):

```typescript
// In FlightPathDashboardProvider.ts

private async handleSavePromptEdit(message: {
  promptIndex: number;
  newText: string;
  model?: string;
}): Promise<void> {
  try {
    // Get current workflow file
    const currentFile = this.flightPathManager.getCurrentPromptFile();
    if (!currentFile) {
      throw new Error("No file loaded");
    }

    // Read current file content
    const fileUri = vscode.Uri.file(currentFile.filePath);
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    const fileData = JSON.parse(new TextDecoder().decode(fileContent));

    // Update the specific prompt
    if (fileData.prompts && fileData.prompts[message.promptIndex]) {
      fileData.prompts[message.promptIndex].prompt = message.newText;

      if (message.model !== undefined) {
        if (message.model === "") {
          delete fileData.prompts[message.promptIndex].model;
        } else {
          fileData.prompts[message.promptIndex].model = message.model;
        }
      }
    } else if (fileData.prompt && message.promptIndex === 0) {
      fileData.prompt = message.newText;
      if (message.model !== undefined) {
        if (message.model === "") {
          delete fileData.model;
        } else {
          fileData.model = message.model;
        }
      }
    }

    // Write back to file
    const updatedContent = JSON.stringify(fileData, null, 2);
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(updatedContent)
    );

    // Reload the file to update dashboard
    await this.flightPathManager.loadPromptFile(currentFile.filePath);

    // Send success message
    this.postMessage({
      type: MESSAGE_TYPES.PROMPT_UPDATED,
      success: true,
      promptIndex: message.promptIndex,
    });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.postMessage({
      type: MESSAGE_TYPES.PROMPT_UPDATED,
      success: false,
      error: errorMsg,
    });
  }
}
```

#### 2. **Creating Draft Prompts**

When creating new `.prompt.md` files:

```typescript
// In FlightPathDashboardProvider.ts

private async handleCreateDraftPrompt(message: {
  content: string;
  filename: string;
  loadAfter: boolean;
}): Promise<void> {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder open");
    }

    // Ensure filename has .prompt.md extension
    let filename = message.filename.trim();
    if (!filename.endsWith(".prompt.md")) {
      filename += ".prompt.md";
    }

    // Create path in .flightpath/prompts/
    const promptsDir = vscode.Uri.joinPath(
      workspaceFolder.uri,
      ".flightpath",
      "prompts"
    );

    // Ensure directory exists
    await vscode.workspace.fs.createDirectory(promptsDir);

    // Create file path
    const filePath = vscode.Uri.joinPath(promptsDir, filename);

    // Check if file already exists
    try {
      await vscode.workspace.fs.stat(filePath);
      throw new Error(`File already exists: ${filename}`);
    } catch (error) {
      // File doesn't exist, proceed
    }

    // Write content
    const contentBytes = new TextEncoder().encode(message.content);
    await vscode.workspace.fs.writeFile(filePath, contentBytes);

    // Send success message
    this.postMessage({
      type: MESSAGE_TYPES.PROMPT_CREATED,
      success: true,
      filePath: filePath.fsPath,
    });

    // Optionally load the file
    if (message.loadAfter && this.flightPathManager) {
      await this.flightPathManager.loadPromptFile(filePath.fsPath);
    }

    // Open in editor (non-preview)
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.postMessage({
      type: MESSAGE_TYPES.PROMPT_CREATED,
      success: false,
      error: errorMsg,
    });
  }
}
```

### D. Validation

#### 1. **Prompt Content Validation**

- Check for empty content
- Warn if prompt is very short (< 10 characters)
- Preserve existing model/endCondition if not explicitly changed

#### 2. **Filename Validation**

Reuse validation from workflow modal:

```javascript
function validatePromptFilename(filename) {
  if (!filename.trim()) {
    return { valid: false, error: "Filename is required" };
  }

  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (invalidChars.test(filename)) {
    return { valid: false, error: "Invalid characters in filename" };
  }

  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  if (reserved.test(filename)) {
    return { valid: false, error: "Reserved filename" };
  }

  return { valid: true };
}
```

## Integration with Existing Systems

### A. Dashboard Provider Updates

**File:** `src/ui/FlightPathDashboardProvider.ts`

1. Add new message handlers:
   ```typescript
   private handleWebviewMessage(message: any): void {
     // ... existing handlers ...

     if (message.type === MESSAGE_TYPES.EDIT_PROMPT) {
       // No server action needed, webview handles UI
       return;
     }

     if (message.type === MESSAGE_TYPES.SAVE_PROMPT_EDIT) {
       this.handleSavePromptEdit(message);
       return;
     }

     if (message.type === MESSAGE_TYPES.CREATE_DRAFT_PROMPT) {
       this.handleCreateDraftPrompt(message);
       return;
     }

     // ... existing code ...
   }
   ```

2. Add new handler methods (see Data Handling section)

### B. Dashboard HTML Updates

**File:** `src/ui/webview/dashboard.html`

1. Add editor container elements:
   ```html
   <!-- After main-content div, before modal -->
   <div id="new-prompt-editor" class="new-prompt-editor" hidden>
     <div class="editor-overlay"></div>
     <div class="editor-panel">
       <!-- Editor UI as defined in UI Components section -->
     </div>
   </div>
   ```

### C. Dashboard JavaScript Updates

**File:** `src/ui/webview/dashboard.js`

1. Add editor state management
2. Add event handlers for edit buttons
3. Add save/cancel logic
4. Add message handlers for server responses
5. Update `renderPromptsList()` to include edit buttons

**Example implementation:**

```javascript
// Add to elements object
const elements = {
  // ... existing elements ...

  // New prompt editor elements
  newPromptEditor: document.getElementById("new-prompt-editor"),
  newPromptTextarea: document.querySelector(".new-prompt-editor textarea"),
  newPromptFilename: document.getElementById("new-prompt-filename"),
  // ... etc
};

// Handle edit button click
function handleEditPrompt(promptIndex) {
  state.editingPromptIndex = promptIndex;
  state.editingPromptOriginal = { ...state.prompts[promptIndex] };
  renderPromptsList(); // Re-render with inline editor
}

// Handle save inline edit
function handleSaveInlineEdit(promptIndex) {
  const editorEl = document.querySelector(
    `[data-prompt-index="${promptIndex}"] .inline-editor`
  );
  const textarea = editorEl.querySelector("textarea");
  const modelSelect = editorEl.querySelector(".model-select");

  vscode.postMessage({
    type: MESSAGE_TYPES.SAVE_PROMPT_EDIT,
    promptIndex,
    newText: textarea.value,
    model: modelSelect.value,
  });
}

// Handle cancel inline edit
function handleCancelInlineEdit(promptIndex) {
  state.editingPromptIndex = null;
  state.editingPromptOriginal = null;
  renderPromptsList(); // Re-render without editor
}

// Handle new prompt editor
function openNewPromptEditor() {
  state.newPromptEditorOpen = true;
  elements.newPromptEditor.hidden = false;
  elements.newPromptTextarea.focus();
}

function closeNewPromptEditor() {
  state.newPromptEditorOpen = false;
  elements.newPromptEditor.hidden = true;
  elements.newPromptTextarea.value = "";
  elements.newPromptFilename.value = "";
}

function handleCreateDraftPrompt(loadAfter) {
  const content = elements.newPromptTextarea.value.trim();
  const filename = elements.newPromptFilename.value.trim();

  const validation = validatePromptFilename(filename);
  if (!validation.valid) {
    showError(validation.error);
    return;
  }

  if (!content) {
    showError("Prompt content is required");
    return;
  }

  vscode.postMessage({
    type: MESSAGE_TYPES.CREATE_DRAFT_PROMPT,
    content,
    filename,
    loadAfter,
  });
}

// Update renderPromptsList to include edit buttons
function renderPromptsList() {
  if (state.prompts.length === 0) {
    elements.promptsList.innerHTML =
      '<p class="empty-state">No prompts loaded</p>';
    return;
  }

  elements.promptsList.innerHTML = state.prompts.map((prompt, index) => {
    const icon = getStatusIcon(prompt.status);
    const statusClass = `prompt-item status-${prompt.status}`;
    const isEditing = state.editingPromptIndex === index;

    // Base prompt header
    let html = `
      <div class="${statusClass}" data-prompt-index="${index}">
        <div class="prompt-header">
          <span class="prompt-icon">${icon}</span>
          <span class="prompt-text">${index + 1}. ${truncate(prompt.text, 60)}</span>
          <button class="btn-edit" onclick="handleEditPrompt(${index})">Edit</button>
        </div>
    `;

    // Add inline editor if this prompt is being edited
    if (isEditing) {
      html += renderInlineEditor(index, prompt);
    }

    // Add details (retry state, duration, etc.)
    html += renderPromptDetails(prompt);

    html += `</div>`;

    return html;
  }).join("");
}

function renderInlineEditor(promptIndex, prompt) {
  return `
    <div class="inline-editor">
      <div class="editor-header">
        <span>Editing Prompt ${promptIndex + 1}:</span>
        <div class="editor-actions">
          <button class="btn-save" onclick="handleSaveInlineEdit(${promptIndex})" title="Save changes">✓</button>
          <button class="btn-cancel" onclick="handleCancelInlineEdit(${promptIndex})" title="Cancel">✗</button>
        </div>
      </div>
      <div class="editor-body">
        <textarea class="prompt-editor-textarea" rows="6">${escapeHtml(prompt.text)}</textarea>
        <div class="editor-options">
          <label>Model:</label>
          <select class="model-select">
            <option value="">Default</option>
            <!-- Populate from available models -->
          </select>
        </div>
      </div>
    </div>
  `;
}
```

### D. Dashboard CSS Updates

**File:** `src/ui/webview/dashboard.css`

Add all CSS classes defined in Visual Design section above.

## Security Considerations

1. **File System Access**
   - All file operations restricted to workspace folder
   - Validate file paths before writing
   - Use VS Code's file system API for all operations

2. **Input Sanitization**
   - Escape HTML when rendering user-provided content
   - Validate filenames against reserved words and invalid characters
   - Limit file size to prevent memory issues

3. **Execution Safety**
   - Editing prompts does not automatically execute them
   - Require explicit user action (Run button) to execute
   - Show confirmation if editing while workflow is running

## Testing Strategy

### Manual Testing

1. **Inline Edit Testing**
   - Load a multi-prompt workflow
   - Click Edit on each prompt
   - Verify editor appears with correct content
   - Edit and save, verify file updates
   - Edit and cancel, verify no changes
   - Edit during execution (should be disabled)

2. **New Prompt Testing**
   - Click "New Prompt" button
   - Enter content and filename
   - Save without loading
   - Save and load
   - Test filename validation (invalid chars, existing files)
   - Test empty content validation

3. **Integration Testing**
   - Create prompt, load it, run it
   - Edit prompt, save, run again
   - Switch between files while editor is open
   - Close panel while editor is open

### Automated Testing

Consider adding tests for:

```typescript
// Test file operations
test("should save edited prompt to workflow file", async () => {
  // Create test workflow
  // Edit prompt
  // Verify file contents
});

test("should create new draft prompt file", async () => {
  // Create new prompt
  // Verify file exists
  // Verify contents
});

test("should validate filename correctly", () => {
  // Test various invalid filenames
  // Verify error messages
});
```

## Implementation Phases

### Phase 1: Inline Editing (Essential)
- [ ] Add edit buttons to prompt items
- [ ] Implement inline editor UI
- [ ] Add state management for editing
- [ ] Implement save/cancel handlers
- [ ] Add server-side file update logic
- [ ] Basic CSS styling

**Estimated effort:** 1-2 days

### Phase 2: New Prompt Creation (High Priority)
- [ ] Add "New Prompt" button dropdown
- [ ] Implement full-panel editor UI
- [ ] Add filename input and validation
- [ ] Implement draft prompt creation logic
- [ ] Add "Save & Load" functionality
- [ ] Enhanced CSS styling

**Estimated effort:** 1-2 days

### Phase 3: Polish & UX Improvements (Medium Priority)
- [ ] Add keyboard shortcuts (Ctrl+S to save, Esc to cancel)
- [ ] Add auto-resize for textareas
- [ ] Add character count indicator
- [ ] Add undo/redo support
- [ ] Improve animations and transitions
- [ ] Add loading indicators

**Estimated effort:** 1 day

### Phase 4: Advanced Features (Optional)
- [ ] Syntax highlighting for context references (@file, #file:)
- [ ] Auto-complete for file paths
- [ ] Prompt templates/snippets
- [ ] Rich text preview mode
- [ ] Multi-select for batch editing

**Estimated effort:** 2-3 days

## Open Questions

1. **Editing during execution**: Should we allow editing prompts while a workflow is running?
   - **Recommendation:** Disable editing for currently running prompt, allow editing future prompts

2. **Auto-save**: Should we auto-save changes periodically?
   - **Recommendation:** No auto-save initially, require explicit save action

3. **Model selection scope**: Should inline editor show model selector for all workflows?
   - **Recommendation:** Only show if workflow uses per-prompt models or file format supports it

4. **Dirty state tracking**: Should we track unsaved changes and warn on close?
   - **Recommendation:** Yes, show warning if user tries to close panel with unsaved edits

5. **Edit history**: Should we track edit history for undo beyond single session?
   - **Recommendation:** No, rely on VS Code's file history and git

## Success Metrics

1. **Adoption**: Track usage of inline editor vs. "Edit" button (VS Code editor)
2. **Efficiency**: Measure time to create/edit prompts (before vs. after)
3. **Error rates**: Monitor failed saves, validation errors
4. **User feedback**: Collect qualitative feedback on editing experience

## Future Enhancements

1. **Monaco Editor Integration**: Full-featured code editor with IntelliSense
2. **Diff View**: Show changes before saving
3. **Collaborative Editing**: Real-time collaboration (if FlightPath adds multi-user support)
4. **AI-Assisted Editing**: Suggest improvements to prompts using Copilot
5. **Template Library**: Pre-built prompt templates users can insert

## References

- **Existing Modal Implementation**: `src/ui/webview/dashboard.html` (New Workflow Modal)
- **Message Passing Pattern**: `src/ui/FlightPathDashboardProvider.ts` (handleWebviewMessage)
- **File Operations**: `src/flightpath/TemplateManager.ts` (createWorkflow method)
- **Validation Patterns**: Dashboard modal filename validation
- **CSS Patterns**: `src/ui/webview/dashboard.css` and `shared.css`
