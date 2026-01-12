# In-Panel Prompt Editor Design

## ✅ Implementation Status: COMPLETE

**Implemented:** January 2026

The in-panel prompt editor is fully implemented using CodeMirror with custom JavaScript completions. Key implementation files:

- [codemirror-editor.js](../src/ui/webview/codemirror-editor.js) - CodeMirror editor with completions, spell check, link decorations
- [editor-manager.js](../src/ui/webview/editor-manager.js) - Editor state management and event handling
- [FlightPathDashboardProvider.ts](../src/ui/FlightPathDashboardProvider.ts) - Extension host completion handling
- [typo.js](../src/ui/webview/typo.js) - Hunspell-based spell checking (Typo.js library)
- [dictionaries/](../src/ui/webview/dictionaries/) - en_US dictionary files

**Implementation notes vs. original design:**

- Used **CodeMirror** instead of `contenteditable` for richer editor features (undo/redo, selections, search)
- Used **Typo.js** with hunspell dictionaries instead of native browser spell check (more accurate, custom dictionary support)
- Single editor section (not tabbed Output/Editor) - editor is always visible below output
- Properties drawer slides in from the right for model/provider/agent settings

---

## Overview

This document describes the design and implementation plan for adding an in-panel text editor to the FlightPath dashboard. This feature will allow users to create and edit prompts directly within the custom webview panel, eliminating the need to switch to the VS Code text editor for basic prompt editing tasks.

## Editor Technology Selection

### Requirements Analysis

**1. Completions and Link Providers Reuse:**

- Existing `PromptCompletionProvider` and `PromptLinkProvider` rely on VS Code's Extension API
- These work with `vscode.TextDocument` objects and `vscode.CompletionItemProvider` interface
- Cannot be directly used with HTML textarea or contenteditable elements in webviews

**2. Spell Check Support:**

- Code Spell Checker (streetsidesoftware.code-spell-checker) works via VS Code's Diagnostic API
- Requires `vscode.TextDocument` with a valid `languageId`
- Does NOT work with arbitrary webview content (textarea, contenteditable)
- Checks documents based on:
  - File extension patterns
  - Language ID (`cSpell.enabledLanguageIds` setting)
  - Document text content via `vscode.workspace.onDidChangeTextDocument`

### Editor Options

#### Option 1: Virtual Document Approach (Fallback Alternative)

**How it works:**

1. Create an in-memory VS Code document using `vscode.workspace.openTextDocument({ content, language: 'markdown' })`
2. Open it in a non-visible editor column
3. Sync changes bidirectionally between webview textarea and virtual document
4. All existing VS Code features work: completions, links, spell check, etc.

**Pros:**

- ✅ **Reuses existing providers** - No code changes needed to `PromptCompletionProvider` or `PromptLinkProvider`
- ✅ **Spell check works natively** - Code Spell Checker sees it as a real document
- ✅ **All VS Code features** - IntelliSense, diagnostics, quick fixes, etc.
- ✅ **Simple webview** - Just a plain textarea with sync logic

**Cons:**

- ❌ **Not truly "in-panel"** - Actually opens a VS Code editor (can be hidden in background column)
- ❌ **Sync complexity** - Need to keep webview and document in sync
- ❌ **User confusion potential** - Users might see the virtual document in open editors list

**Implementation:**

```typescript
// In FlightPathDashboardProvider.ts

private virtualDocument: vscode.TextDocument | undefined;
private virtualDocumentUri: vscode.Uri | undefined;

async openEditorForPrompt(promptText: string, promptIndex: number): Promise<void> {
  // Create virtual document URI (untitled scheme with unique identifier)
  const uri = vscode.Uri.parse(`untitled:flightpath-prompt-${promptIndex}.md`);

  // Create/open the document
  const document = await vscode.workspace.openTextDocument({
    content: promptText,
    language: 'markdown', // or 'prompt' if we register a custom language
  });

  // Open in editor (ViewColumn.Beside to keep it separate)
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
    preserveFocus: true, // Keep focus on dashboard
  });

  // Listen for changes and sync to webview
  const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document === document) {
      this.postMessage({
        type: MESSAGE_TYPES.VIRTUAL_DOCUMENT_CHANGED,
        content: e.document.getText(),
      });
    }
  });

  this.virtualDocument = document;
  // Store listener for cleanup
}

// In webview: when user types in textarea, update virtual document
handleTextareaChange(newText: string): void {
  vscode.postMessage({
    type: MESSAGE_TYPES.UPDATE_VIRTUAL_DOCUMENT,
    content: newText,
  });
}
```

**Better Approach - Hidden Editor:**

```typescript
// Open in a column far to the right, or minimize it immediately
const editor = await vscode.window.showTextDocument(document, {
  viewColumn: vscode.ViewColumn.Three, // Far right
  preview: true,
  preserveFocus: true,
});

// Alternative: Use diff editor approach or notebook-style cell editing
```

#### Option 2: Monaco Editor in Webview

**How it works:**
Embed the full Monaco Editor (VS Code's editor engine) into the webview.

**Pros:**

- ✅ **Full editor features** - Syntax highlighting, minimap, find/replace
- ✅ **Completions possible** - Can register custom completion providers in Monaco
- ✅ **Looks professional** - Same editor as VS Code

**Cons:**

- ❌ **Cannot reuse existing providers** - Monaco and VS Code Extension APIs are different
- ❌ **No spell check integration** - Code Spell Checker won't work (it's a VS Code extension)
- ❌ **Large bundle size** - Monaco is ~5MB, increases extension size significantly
- ❌ **Complex integration** - Need to rebuild completions and links for Monaco API
- ❌ **Webview CSP restrictions** - Requires careful CSP configuration

**Verdict:** ❌ **Not recommended** - Too much work to reimplement existing features, no spell check.

#### Option 3: Simple Textarea with Custom Autocomplete UI

**How it works:**
Use HTML textarea with JavaScript-based autocomplete menu.

**Pros:**

- ✅ **Lightweight** - No external dependencies
- ✅ **Full control** - Custom styling and behavior

**Cons:**

- ❌ **Cannot reuse existing providers** - Need to reimplement all completion logic
- ❌ **No spell check** - Code Spell Checker won't work
- ❌ **Reinventing the wheel** - Building autocomplete UI from scratch
- ❌ **No link support** - Would need custom implementation

**Verdict:** ❌ **Not recommended** - Too much duplicate code, no spell check.

#### Option 4: Hybrid - Textarea with "Edit in VS Code" Button

**How it works:**
Simple textarea for basic editing, with a button to open in full VS Code editor when needed.

**Pros:**

- ✅ **Simple implementation** - Just a textarea and a button
- ✅ **All features when needed** - Full VS Code editor is one click away
- ✅ **Spell check available** - When editing in VS Code editor
- ✅ **No sync complexity** - One-way save back to dashboard

**Cons:**

- ❌ **Not truly in-panel** - Still requires switching to editor for advanced features
- ❌ **No completions in textarea** - Users must open editor for @ and # completions

**Implementation:**

```typescript
// Webview button click
async function editInVSCode() {
  vscode.postMessage({
    type: MESSAGE_TYPES.EDIT_IN_VSCODE,
    promptIndex: state.editingPromptIndex,
  });
}

// Extension side
async handleEditInVSCode(promptIndex: number): Promise<void> {
  const prompt = this.prompts[promptIndex];
  const document = await vscode.workspace.openTextDocument({
    content: prompt.text,
    language: 'markdown',
  });

  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
  });

  // On document close or save, sync back to dashboard
  const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc === document) {
      this.updatePrompt(promptIndex, doc.getText());
    }
  });
}
```

### ✅ IMPLEMENTED: Option 5 (Custom JavaScript Completions with CodeMirror)

**Based on research of GitHub Copilot Chat, Claude Code, and Codex extensions**

**Key Discovery:** Chat extensions don't use native VS Code completions - they build **custom JavaScript completions** in webviews!

**Actual Implementation Architecture:**

```
┌─────────────────────────────────────────────┐
│ Dashboard Editor Section (Webview)          │
│  ┌─────────────────────────────────────┐   │
│  │ CodeMirror Editor                   │   │
│  │ - Spell check: Typo.js (hunspell)   │   │
│  │ - Links: Decoration + Ctrl+Click    │   │
│  │ - Completions: CodeMirror dropdown  │   │
│  └─────────────────────────────────────┘   │
│  ┌─────────────────────────────────────┐   │
│  │ Native Completion Dropdown          │   │
│  │ > 📄 src/extension.ts               │   │
│  │   📁 src/flightpath/                │   │
│  │   📍 Current selection              │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
           ↕ postMessage
┌─────────────────────────────────────────────┐
│ Extension Host                              │
│ - Reuses CompletionHelpers for shared logic │
│ - handleCompletionRequest in Provider      │
│ - Sends completion data to webview         │
└─────────────────────────────────────────────┘
```

**How It Actually Works:**

1. CodeMirror editor with full undo/redo, multi-selection, search capabilities
2. Typo.js spell checker with hunspell en_US dictionary (not browser spellcheck)
3. Detect @ and # trigger characters via CodeMirror's autocompletion extension
4. Request completion data from extension host via postMessage
5. Display CodeMirror's native completion dropdown with keyboard navigation
6. Link decorations via ViewPlugin, Ctrl+Click opens files in VS Code

**Advantages (confirmed in implementation):**

- ✅ **Stays in dashboard panel** - No split-pane or separate editor needed
- ✅ **Rich spell check** - Typo.js with custom dictionary support
- ✅ **Full UX control** - Match VS Code completion styling exactly
- ✅ **Reuses existing logic** - Extension host uses CompletionHelpers
- ✅ **No API limitations** - All custom code, no Extension API restrictions
- ✅ **Same as Copilot/Claude/Codex** - Proven pattern used by all major chat extensions
- ✅ **CodeMirror bonuses** - Undo/redo, search, multiple selections, line wrapping

**Implementation Files:**

- `src/ui/webview/codemirror-editor.js` - Main editor class (CodeMirrorPromptEditor)
- `src/ui/webview/codemirror-bundle-source.js` - CodeMirror modules bundled
- `src/ui/webview/codemirror-loader.js` - Async loader for CodeMirror
- `src/ui/webview/typo.js` - Typo.js spell checker library
- `src/ui/webview/dictionaries/en_US/` - Hunspell dictionary files (.aff, .dic)
- `src/ui/FlightPathDashboardProvider.ts` - Extension host completion handling

**Estimated Effort:** 3-5 days

### Alternative: Option 1 (Virtual Document Approach)

**If custom completions prove too complex or users demand Code Spell Checker integration**, fall back to split-pane architecture:

**Updated based on VS Code source code research** (see [VSCODE_NATIVE_EDITOR_WIDGETS.md](VSCODE_NATIVE_EDITOR_WIDGETS.md))

**Rationale:**

1. **Industry standard pattern** - Used by Git extension, SCM providers, and internal VS Code features
2. **All features work natively** - Completions, links, spell check (no reimplementation needed)
3. **Proven in production** - SCM and Chat use CodeEditorWidget with real TextModels
4. **Simple provider registration** - Just register `'flightpath-prompt'` language ID
5. **No Extension API limitations** - We can use public `workspace.openTextDocument()` API

**Research Findings:**

- SCM commit input uses **CodeEditorWidget** with `'scminput'` language (`src/vs/workbench/contrib/scm/browser/scmViewPane.ts`)
- Chat input uses **CodeEditorWidget** with `'chatinput'` language (`src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts`)
- Webviews **cannot** embed native CodeEditorWidget (sandboxed iframes)
- Extension API **does not expose** CodeEditorWidget creation
- Git extension uses virtual documents for commit message editing

**User Flow:**

1. User clicks "Edit" on a prompt in dashboard
2. Extension creates `untitled:` document with `languageId: 'flightpath-prompt'`
3. Opens in background editor column (ViewColumn.Three, preserveFocus: true, preview: false)
4. Webview shows read-only view OR minimal sync indicator
5. User edits with full VS Code features (completions, links, spell check)
6. Changes sync bidirectionally in real-time
7. On document close, changes are saved to workflow file

**Implementation Advantages:**

- **Seamless editing** - User never leaves mental context, full editor features automatically available
- **No context switching** - Background editor can be mostly invisible (only visible in editor tabs list)
- **Automatic sync** - Webview and document stay in sync without manual "Edit in VS Code" action
- **Native features** - All existing providers (completions, links, spell check) work without modification

**Why NOT Option 4 (Hybrid)?**

- Requires extra "Edit in VS Code" button click (friction)
- User must explicitly switch contexts
- Virtual document is actually MORE seamless (automatic sync)
- Background editor can be hidden from view

### Implementation Plan

**Phase 1: Basic Textarea Editor**

- Plain textarea in Editor tab
- Save/Cancel buttons
- No completions or spell check in textarea

**Phase 2: "Edit in VS Code" Integration**

- Add "Edit in VS Code" button
- Create virtual document on demand
- Sync changes back to dashboard
- All existing providers work automatically

**Phase 3: Optional Enhancement - Inline Hints**

- Add hints in textarea: "Press @ for files, # for selections"
- Or: "Click 'Edit in VS Code' for completions and spell check"

### Why Tab Control + Split View (Not Modal)?

**Context Preservation is Critical:**

- Users need to see the prompt list while editing to understand workflow structure
- Users may want to reference CLI output while refining prompts iteratively
- Modal overlays hide this context, forcing users to memorize or switch views

**Flexible Workflow Support:**

- **Focused work**: Tab view for single-task concentration
- **Power users**: Split view for parallel reference (output + editing)
- **Responsive**: Graceful degradation on narrow screens

**VS Code Consistency:**

- Tab controls are familiar (editor groups, panels, output channels)
- Split views mirror VS Code's editor splitting behavior
- Non-blocking UI aligns with VS Code's philosophy

**User Benefits:**

1. **Iterative refinement**: See output → Edit prompt → Re-run (no context switching)
2. **Workflow understanding**: Always see which prompt is being edited in context
3. **Flexibility**: Choose tab or split based on screen size and preference
4. **Multi-tasking**: Monitor output while preparing next prompt

**Implementation Advantages:**

- Simpler state management (no modal z-index issues)
- Better accessibility (no focus trapping)
- Easier responsive design (CSS media queries handle layout)
- More extensible (can add more tabs/panels later)

## Goals

1. **In-panel rich editing**: Edit prompts with completions, links, and spell check without leaving dashboard
2. **@ and # completions**: Trigger file/directory/selection/symbol completions like VS Code editor
3. **Clickable links**: Ctrl+Click @file and #file:lines references to open/navigate
4. **Spell check**: Native browser spell check (red squiggly lines)
5. **Create new prompts**: Support creating draft prompts (`.prompt.md`) directly in the panel
6. **Preserve workflow context**: Maintain visibility of the full workflow while editing
7. **Professional UX**: Match GitHub Copilot Chat completion styling and behavior

## Non-Goals

- Full-featured code editor with syntax highlighting (Monaco Editor integration)
- Multi-file editing capabilities
- Advanced editing features (find/replace, code folding, etc.)
- Replacing the VS Code editor entirely

## User Interface Design

### A. Layout Architecture

The dashboard uses a **two-column layout with tab control** for the right pane:

**Left Pane (Fixed Width on Wide Screens):**

- Prompts list (existing functionality, unchanged)
- Always visible for workflow context

**Right Pane (Flexible Width):**

- **Default Mode**: Tab control with "Output" and "Editor" tabs
- **Side-by-Side Mode**: Output (50%) | Editor (50%) split view
- Toggle button to switch between modes

**Responsive Behavior:**

- **Wide (≥800px)**: Prompts (fixed 350px) | [Tab/Split View]
- **Narrow (<800px)**: Vertical stack - Prompts | [Tab View only]
- **Side-by-side on narrow**: Becomes vertical split (Output top, Editor bottom)

### B. Layout Examples

#### 1. **Default Tabbed Layout** (Wide Screen)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header: [Load] [New Workflow] | Workflow Status | [▶][⏸][⏹]        │
├──────────────────┬──────────────────────────────────────────────────┤
│ Prompts [1/3]    │ [Output] [Editor]                    [⬌ Split]  │
├──────────────────┼──────────────────────────────────────────────────┤
│ ✅ 1. Analyze... │ CLI Output:                                      │
│                  │ ┌────────────────────────────────────────────┐   │
│ ▶️  2. Implement │ │ > Analyze codebase structure                │  │
│                  │ │                                              │  │
│ ⏸️  3. Write... │ │ Response: The codebase follows a modular... │  │
│                  │ │                                              │  │
│                  │ │ Token usage: 1500 prompt / 3200 response    │  │
│                  │ └────────────────────────────────────────────┘   │
└──────────────────┴──────────────────────────────────────────────────┘
```

#### 2. **Editor Tab Active** (Wide Screen)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header: [Load] [New Workflow] | Workflow Status | [▶][⏸][⏹]        │
├──────────────────┬──────────────────────────────────────────────────┤
│ Prompts [1/3]    │ [Output] [Editor]                    [⬌ Split]  │
├──────────────────┼──────────────────────────────────────────────────┤
│ ✅ 1. Analyze... │ Editing: Prompt 2 of 3              [Save][✗]   │
│                  │ ┌────────────────────────────────────────────┐   │
│ ▶️  2. Implement │ │ Implement feature based on analysis       │ │  │
│     ← editing    │ │                                            │ │  │
│                  │ │ Use the insights from prompt 1 to create  │ │  │
│ ⏸️  3. Write... │ │ a new feature for user authentication.    │ │  │
│                  │ │                                            │ │  │
│                  │ └────────────────────────────────────────────┘   │
│                  │ Model: [claude-sonnet-4.5 ▼]                    │
│                  │ [+ New Draft Prompt]                             │
└──────────────────┴──────────────────────────────────────────────────┘
```

#### 3. **Side-by-Side Split View** (Wide Screen)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Header: [Load] [New Workflow] | Workflow Status | [▶][⏸][⏹]        │
├──────────────────┬──────────────────────────┬───────────────────────┤
│ Prompts [1/3]    │ Output              [⬌] │ Editor                │
├──────────────────┼──────────────────────────┼───────────────────────┤
│ ✅ 1. Analyze... │ CLI Output:              │ Editing: Prompt 2     │
│                  │ ┌──────────────────────┐ │ ┌─────────────────┐   │
│ ▶️  2. Implement │ │ > Analyze codebase   │ │ │ Implement feat. │ │ │
│     ← editing    │ │                      │ │ │                 │ │ │
│                  │ │ Response: The code.  │ │ │ Use insights... │ │ │
│ ⏸️  3. Write... │ │                      │ │ │                 │ │ │
│                  │ │ Tokens: 1500/3200    │ │ └─────────────────┘   │
│                  │ └──────────────────────┘ │ Model: [claude... ▼] │
└──────────────────┴──────────────────────────┴───────────────────────┘
```

#### 4. **Narrow Screen** (Vertical Stack with Tabs)

```
┌─────────────────────────────────────────┐
│ Header (compact)                        │
├─────────────────────────────────────────┤
│ Prompts                        [1/3]    │
│ ✅ 1. Analyze...                        │
│ ▶️  2. Implement...                     │
│ ⏸️  3. Write tests...                   │
├─────────────────────────────────────────┤
│ [Output] [Editor]                       │
├─────────────────────────────────────────┤
│ CLI Output:                             │
│ ┌─────────────────────────────────────┐ │
│ │ > Analyze codebase structure        │ │
│ │                                     │ │
│ │ Response: The codebase follows...   │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### C. Editor Modes

The editor supports two editing contexts:

#### 1. **Edit Existing Prompt** (Selected from prompt list)

**User Flow:**

1. Click prompt item in left pane OR click "Edit" button
2. Right pane switches to "Editor" tab
3. Editor loads selected prompt's content
4. User edits, then saves or cancels
5. Changes update the workflow file

**Features:**

- Pre-filled with current prompt text
- Model selector (if workflow supports per-prompt models)
- Save/Cancel actions
- Visual indicator showing which prompt is being edited

#### 2. **Create New Draft Prompt**

**User Flow:**

1. Click "New Draft Prompt" button in Editor tab
2. Editor clears to blank state
3. User writes new prompt
4. User enters filename
5. Saves to `.flightpath/prompts/[filename].prompt.md`
6. Optionally loads into dashboard immediately

**Features:**

- Blank textarea for new content
- Filename input with validation
- Save location preview
- "Save & Load" option to immediately use the prompt

### D. UI Components

#### 1. **Tab Control Component**

```html
<div class="tab-control">
  <div class="tab-buttons">
    <button class="tab-btn active" data-tab="output">Output</button>
    <button class="tab-btn" data-tab="editor">Editor</button>
    <button class="layout-toggle" title="Toggle split view">⬌</button>
  </div>
</div>

<div class="tab-content-area">
  <!-- Output or Editor content, or split view with both -->
</div>
```

#### 2. **Split View Toggle**

```html
<!-- Single view (tabs) -->
<div class="right-pane tab-mode">
  <div class="tab-control">...</div>
  <div class="tab-panels">
    <div class="tab-panel active" data-panel="output">
      <!-- Output content -->
    </div>
    <div class="tab-panel" data-panel="editor">
      <!-- Editor content -->
    </div>
  </div>
</div>

<!-- Split view -->
<div class="right-pane split-mode">
  <div class="tab-control">
    <button class="layout-toggle active" title="Back to tabs">⬌</button>
  </div>
  <div class="split-panels">
    <div class="split-panel output-panel">
      <!-- Output content -->
    </div>
    <div class="split-panel editor-panel">
      <!-- Editor content -->
    </div>
  </div>
</div>
```

#### 3. **Editor Panel Component**

```html
<div class="editor-panel">
  <div class="editor-header">
    <span class="editor-title">
      <span id="edit-mode-indicator">No prompt selected</span>
    </span>
    <div class="editor-actions">
      <button class="btn-save" disabled>Save</button>
      <button class="btn-cancel" disabled>Cancel</button>
    </div>
  </div>

  <div class="editor-body">
    <textarea
      id="prompt-editor-textarea"
      class="prompt-editor-textarea"
      rows="15"
      placeholder="Select a prompt to edit or create a new one"
    >
    </textarea>

    <div class="editor-options">
      <div class="option-row">
        <label>Model:</label>
        <select class="model-select" disabled>
          <option value="">Default</option>
          <!-- Dynamically populated -->
        </select>
      </div>
    </div>
  </div>

  <div class="editor-footer">
    <button id="btn-new-draft" class="btn-secondary">+ New Draft Prompt</button>
  </div>

  <!-- New draft prompt UI (shown when creating new) -->
  <div id="new-draft-ui" class="new-draft-ui" hidden>
    <div class="filename-input-group">
      <label>Filename:</label>
      <input type="text" id="new-prompt-filename" placeholder="my-prompt" />
      <span class="filename-extension">.prompt.md</span>
    </div>
    <p class="save-path-preview">.flightpath/prompts/</p>
    <p class="error-message" hidden></p>
    <div class="new-draft-actions">
      <button id="btn-save-draft" class="btn-primary">Save</button>
      <button id="btn-save-load-draft" class="btn-primary">Save & Load</button>
    </div>
  </div>
</div>
```

#### 4. **Output Panel** (Unchanged, just wrapped differently)

The existing output content remains the same, just moved into a panel that can be shown in a tab or split view.

### E. Interaction Flow

#### Edit Existing Prompt Flow

1. User clicks a prompt item in the left pane
2. Right pane switches to "Editor" tab (if in tab mode)
3. Editor tab displays:
   - "Editing: Prompt N of M" header
   - Textarea pre-filled with prompt content
   - Model selector (if applicable)
   - Save/Cancel buttons enabled
4. User edits text
5. User clicks Save:
   - Validate changes
   - Update workflow file on disk
   - Reload prompt in memory
   - Show success indicator
   - Keep editor open with updated content
6. User clicks Cancel:
   - Revert textarea to original content
   - Disable Save button until changes made again

#### Create New Draft Prompt Flow

1. User clicks "New Draft Prompt" button in Editor tab
2. Editor switches to "New Draft" mode:
   - Clear textarea
   - Show filename input UI
   - Hide model selector (draft prompts use default)
3. User enters prompt content and filename
4. User clicks "Save" or "Save & Load":
   - Validate filename
   - Create file in `.flightpath/prompts/[filename].prompt.md`
   - If "Save & Load", immediately load into dashboard
   - Show success notification
5. User clicks "Cancel" (if visible):
   - Clear new draft UI
   - Return to normal editor state

#### Layout Toggle Flow

1. User clicks split view toggle button (⬌)
2. If in tab mode:
   - Switch to split mode
   - Show both Output and Editor panels side-by-side (50/50)
   - Save preference to localStorage
3. If in split mode:
   - Switch back to tab mode
   - Show previously active tab
   - Save preference to localStorage

#### Responsive Layout Behavior

**Wide Screens (≥800px):**

- Prompts section: Fixed 350px width
- Right pane: Flexible, fills remaining space
- User can toggle between tabs and split view
- Split view shows Output | Editor side-by-side

**Narrow Screens (<800px):**

- Vertical stack: Prompts above right pane
- Right pane: Tab mode only (split toggle hidden)
- If user had split mode active, automatically switches to tabs
- When switching from narrow → wide, restore previous split/tab preference

### F. Visual Design

#### CSS Architecture

```css
/* Right pane container - holds tabs or split view */
.right-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* Tab control header */
.tab-control {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  padding-bottom: var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
}

.tab-buttons {
  display: flex;
  gap: var(--spacing-xs);
  flex: 1;
}

.tab-btn {
  padding: var(--spacing-xs) var(--spacing-md);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--fg-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s;
}

.tab-btn:hover {
  color: var(--fg-primary);
}

.tab-btn.active {
  color: var(--fg-primary);
  border-bottom-color: var(--vscode-focusBorder);
}

.layout-toggle {
  margin-left: auto;
  padding: var(--spacing-xs);
  background: var(--vscode-button-secondaryBackground);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.layout-toggle:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.layout-toggle.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

/* Tab mode - single panel visible */
.right-pane.tab-mode .tab-panels {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.right-pane.tab-mode .tab-panel {
  display: none;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.right-pane.tab-mode .tab-panel.active {
  display: flex;
}

/* Split mode - both panels visible */
.right-pane.split-mode .tab-buttons {
  display: none; /* Hide tab buttons in split mode */
}

.right-pane.split-mode .split-panels {
  display: flex;
  gap: var(--spacing-md);
  flex: 1;
  min-height: 0;
}

.split-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: var(--spacing-md);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

/* Responsive: vertical split on narrow screens if split mode */
@media (max-width: 799px) {
  .right-pane.split-mode .split-panels {
    flex-direction: column;
  }

  /* Hide split toggle on narrow screens */
  .layout-toggle {
    display: none;
  }

  /* Force tab mode on narrow screens */
  .right-pane.split-mode {
    /* Could force back to tab mode via JS, or allow vertical split */
  }
}

/* Editor panel styles */
.editor-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--spacing-sm);
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: var(--spacing-sm);
  border-bottom: 1px solid var(--border-color);
}

.editor-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-secondary);
  text-transform: uppercase;
}

.editor-actions {
  display: flex;
  gap: var(--spacing-xs);
}

.editor-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--spacing-sm);
}

.prompt-editor-textarea {
  flex: 1;
  min-height: 200px;
  padding: var(--spacing-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family);
  font-size: 13px;
  resize: vertical;
  box-sizing: border-box;
}

.prompt-editor-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.prompt-editor-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.editor-options {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
}

.option-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.option-row label {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-secondary);
  min-width: 60px;
}

.model-select {
  flex: 1;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  font-size: 12px;
}

.editor-footer {
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
}

/* New draft prompt UI */
.new-draft-ui {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  background: var(--vscode-editor-inactiveSelectionBackground);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  margin-top: var(--spacing-sm);
}

.new-draft-ui[hidden] {
  display: none;
}

.filename-input-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.filename-input-group label {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-secondary);
}

.filename-input-group input {
  flex: 1;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px 0 0 4px;
  font-size: 12px;
}

.filename-extension {
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-left: none;
  border-radius: 0 4px 4px 0;
  font-size: 12px;
  color: var(--fg-secondary);
}

.save-path-preview {
  font-size: 11px;
  color: var(--fg-secondary);
  margin: 0;
}

.error-message {
  font-size: 11px;
  color: var(--vscode-errorForeground);
  margin: 0;
}

.new-draft-actions {
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
}

/* Animations */
@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.tab-panel.active,
.split-panel {
  animation: slideIn 0.2s ease-out;
}
```

````

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
  editingPromptIndex: null,     // Index of prompt being edited (null = none)
  editingOriginalText: null,    // Original text for cancel/revert
  editingOriginalModel: null,   // Original model for cancel/revert
  isNewDraft: false,            // True when creating new draft prompt

  // NEW: Layout state
  layoutMode: 'tab',            // 'tab' or 'split'
  activeTab: 'output',          // 'output' or 'editor'
};
````

### B. Message Types

Add new message types to `DashboardConstants.ts`:

```typescript
export const MESSAGE_TYPES = {
  // ... existing messages ...

  // Prompt editing messages
  SELECT_PROMPT_FOR_EDIT: "selectPromptForEdit", // Webview -> Extension
  SAVE_PROMPT_EDIT: "savePromptEdit", // Webview -> Extension
  CANCEL_PROMPT_EDIT: "cancelPromptEdit", // Webview -> Extension
  CREATE_DRAFT_PROMPT: "createDraftPrompt", // Webview -> Extension
  PROMPT_UPDATED: "promptUpdated", // Extension -> Webview
  PROMPT_CREATED: "promptCreated", // Extension -> Webview

  // Layout messages
  TOGGLE_LAYOUT_MODE: "toggleLayoutMode", // Webview only (no server action)
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

### C. Dashboard HTML Updates

**File:** `src/ui/webview/dashboard.html`

Replace the current `#output-section` with a new `#right-pane` structure:

```html
<!-- OLD: Remove this -->
<!--
<div id="output-section">
  <div class="section-header">
    <h3>Output</h3>
    <div class="output-controls">...</div>
  </div>
  <div id="output-content">...</div>
</div>
-->

<!-- NEW: Right pane with tab control -->
<div id="right-pane" class="right-pane tab-mode">
  <div class="tab-control">
    <div class="tab-buttons">
      <button class="tab-btn active" data-tab="output">Output</button>
      <button class="tab-btn" data-tab="editor">Editor</button>
    </div>
    <button class="layout-toggle" title="Toggle split view">⬌</button>
  </div>

  <div class="tab-panels">
    <!-- Output Tab Panel -->
    <div class="tab-panel active" data-panel="output">
      <div class="section-header">
        <h3>Output</h3>
        <div class="output-controls">
          <label class="autoscroll-toggle">
            <input type="checkbox" id="autoscroll-checkbox" checked />
            <span>Autoscroll</span>
          </label>
          <button
            id="btn-export"
            class="btn-secondary btn-small"
            title="Export output"
          >
            Export
          </button>
        </div>
      </div>
      <div id="output-content">
        <div class="empty-state">No output yet</div>
      </div>
    </div>

    <!-- Editor Tab Panel -->
    <div class="tab-panel" data-panel="editor">
      <div class="editor-panel">
        <div class="editor-header">
          <span class="editor-title">
            <span id="edit-mode-indicator">No prompt selected</span>
          </span>
          <div class="editor-actions">
            <button id="btn-save-edit" class="btn-primary" disabled>
              Save
            </button>
            <button id="btn-cancel-edit" class="btn-secondary" disabled>
              Cancel
            </button>
          </div>
        </div>

        <div class="editor-body">
          <textarea
            id="prompt-editor-textarea"
            class="prompt-editor-textarea"
            placeholder="Select a prompt from the list to edit, or create a new draft prompt"
            disabled
          >
          </textarea>

          <div class="editor-options">
            <div class="option-row">
              <label>Model:</label>
              <select id="model-select" class="model-select" disabled>
                <option value="">Default</option>
                <!-- Populated dynamically -->
              </select>
            </div>
          </div>
        </div>

        <div class="editor-footer">
          <button id="btn-new-draft" class="btn-secondary">
            + New Draft Prompt
          </button>
        </div>

        <!-- New draft UI (shown when creating) -->
        <div id="new-draft-ui" class="new-draft-ui" hidden>
          <div class="filename-input-group">
            <label>Filename:</label>
            <input
              type="text"
              id="new-prompt-filename"
              placeholder="my-prompt"
            />
            <span class="filename-extension">.prompt.md</span>
          </div>
          <p id="save-path-preview" class="save-path-preview">
            Save to: .flightpath/prompts/
          </p>
          <p id="filename-error" class="error-message" hidden></p>
          <div class="new-draft-actions">
            <button id="btn-save-draft" class="btn-primary">Save</button>
            <button id="btn-save-load-draft" class="btn-primary">
              Save & Load
            </button>
            <button id="btn-cancel-draft" class="btn-secondary">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Split panels (shown in split mode) -->
  <div class="split-panels" hidden>
    <div class="split-panel output-panel">
      <!-- Output content (same as tab panel, shared via JS) -->
    </div>
    <div class="split-panel editor-panel">
      <!-- Editor content (same as tab panel, shared via JS) -->
    </div>
  </div>
</div>
```

### D. Dashboard JavaScript Updates

**File:** `src/ui/webview/dashboard.js`

Key functions to add/update:

```javascript
// === Layout Management ===

function toggleLayoutMode() {
  const rightPane = elements.rightPane;
  const isCurrentlySplit = rightPane.classList.contains("split-mode");

  if (isCurrentlySplit) {
    // Switch to tab mode
    state.layoutMode = "tab";
    rightPane.classList.remove("split-mode");
    rightPane.classList.add("tab-mode");
    showActiveTab(); // Show previously active tab
  } else {
    // Switch to split mode
    state.layoutMode = "split";
    rightPane.classList.remove("tab-mode");
    rightPane.classList.add("split-mode");
    renderSplitView();
  }

  // Save preference
  localStorage.setItem("flightpath.layoutMode", state.layoutMode);
}

function switchTab(tabName) {
  state.activeTab = tabName;

  // Update tab buttons
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  // Update tab panels
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Save preference
  localStorage.setItem("flightpath.activeTab", tabName);
}

function renderSplitView() {
  const splitPanels = document.querySelector(".split-panels");
  const outputPanel = splitPanels.querySelector(".output-panel");
  const editorPanel = splitPanels.querySelector(".editor-panel");

  // Clone content from tab panels to split panels
  const outputTabContent = document.querySelector(
    '[data-panel="output"] #output-content'
  );
  const editorTabContent = document.querySelector(
    '[data-panel="editor"] .editor-panel'
  );

  // Move or clone DOM elements as needed
  // (Implementation detail: may need to move actual DOM nodes or use shared references)

  splitPanels.hidden = false;
}

// === Editor State Management ===

function selectPromptForEdit(promptIndex) {
  if (promptIndex < 0 || promptIndex >= state.prompts.length) {
    console.error("Invalid prompt index:", promptIndex);
    return;
  }

  const prompt = state.prompts[promptIndex];

  // Save original values for cancel
  state.editingPromptIndex = promptIndex;
  state.editingOriginalText = prompt.text;
  state.editingOriginalModel = prompt.model || null;
  state.isNewDraft = false;

  // Switch to editor tab
  switchTab("editor");

  // Update editor UI
  elements.editorTextarea.value = prompt.text;
  elements.editorTextarea.disabled = false;
  elements.modelSelect.value = prompt.model || "";
  elements.modelSelect.disabled = false;
  elements.btnSaveEdit.disabled = false;
  elements.btnCancelEdit.disabled = false;
  elements.editModeIndicator.textContent = `Editing: Prompt ${promptIndex + 1} of ${state.prompts.length}`;

  // Hide new draft UI if visible
  elements.newDraftUI.hidden = true;

  // Focus textarea
  elements.editorTextarea.focus();
}

function savePromptEdit() {
  if (state.editingPromptIndex === null && !state.isNewDraft) {
    console.error("No prompt selected for editing");
    return;
  }

  const newText = elements.editorTextarea.value.trim();
  const newModel = elements.modelSelect.value;

  if (!newText) {
    showError("Prompt text cannot be empty");
    return;
  }

  if (state.isNewDraft) {
    // Create new draft prompt
    const filename = elements.newPromptFilename.value.trim();
    const validation = validatePromptFilename(filename);

    if (!validation.valid) {
      showError(validation.error);
      return;
    }

    vscode.postMessage({
      type: MESSAGE_TYPES.CREATE_DRAFT_PROMPT,
      content: newText,
      filename: filename,
      loadAfter: false, // Can add UI toggle for this
    });
  } else {
    // Update existing prompt
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_PROMPT_EDIT,
      promptIndex: state.editingPromptIndex,
      newText: newText,
      model: newModel || undefined,
    });
  }
}

function cancelPromptEdit() {
  if (state.isNewDraft) {
    // Cancel new draft creation
    state.isNewDraft = false;
    elements.newDraftUI.hidden = true;
    elements.editorTextarea.value = "";
    elements.editorTextarea.disabled = true;
    elements.btnSaveEdit.disabled = true;
    elements.btnCancelEdit.disabled = true;
    elements.editModeIndicator.textContent = "No prompt selected";
  } else if (state.editingPromptIndex !== null) {
    // Revert to original text
    elements.editorTextarea.value = state.editingOriginalText || "";
    elements.modelSelect.value = state.editingOriginalModel || "";

    // Clear editing state
    state.editingPromptIndex = null;
    state.editingOriginalText = null;
    state.editingOriginalModel = null;

    // Disable editor
    elements.editorTextarea.disabled = true;
    elements.modelSelect.disabled = true;
    elements.btnSaveEdit.disabled = true;
    elements.btnCancelEdit.disabled = true;
    elements.editModeIndicator.textContent = "No prompt selected";
  }
}

function startNewDraftPrompt() {
  // Clear any existing edit
  if (state.editingPromptIndex !== null) {
    cancelPromptEdit();
  }

  state.isNewDraft = true;
  state.editingPromptIndex = null;

  // Switch to editor tab
  switchTab("editor");

  // Clear and enable editor
  elements.editorTextarea.value = "";
  elements.editorTextarea.disabled = false;
  elements.modelSelect.disabled = true; // Draft prompts use default model
  elements.btnSaveEdit.disabled = false;
  elements.btnCancelEdit.disabled = false;
  elements.editModeIndicator.textContent = "New Draft Prompt";

  // Show new draft UI
  elements.newDraftUI.hidden = false;
  elements.newPromptFilename.value = "";
  elements.filenameError.hidden = true;

  // Focus textarea
  elements.editorTextarea.focus();
}

// === Message Handlers ===

function handlePromptUpdated(message) {
  if (message.success) {
    // Success: Keep editor open with updated content
    // FlightPathManager will reload the file and send updated prompts
    showNotification("Prompt updated successfully");

    // Optionally clear dirty state indicator if added
  } else {
    showError(`Failed to update prompt: ${message.error}`);
  }
}

function handlePromptCreated(message) {
  if (message.success) {
    showNotification("Draft prompt created successfully");

    // Clear new draft UI
    state.isNewDraft = false;
    elements.newDraftUI.hidden = true;
    elements.editorTextarea.value = "";
    elements.editorTextarea.disabled = true;
    elements.btnSaveEdit.disabled = true;
    elements.btnCancelEdit.disabled = true;
    elements.editModeIndicator.textContent = "No prompt selected";

    // If loadAfter was true, file will be loaded automatically
  } else {
    showError(`Failed to create prompt: ${message.error}`);
  }
}

// === Prompt List Enhancement ===

function renderPromptsList() {
  if (state.prompts.length === 0) {
    elements.promptsList.innerHTML =
      '<p class="empty-state">No prompts loaded</p>';
    return;
  }

  elements.promptsList.innerHTML = state.prompts
    .map((prompt, index) => {
      const icon = getStatusIcon(prompt.status);
      const statusClass = `prompt-item status-${prompt.status}`;
      const isEditing = state.editingPromptIndex === index;
      const editingClass = isEditing ? "editing" : "";

      return `
      <div class="${statusClass} ${editingClass}" 
           data-prompt-index="${index}"
           onclick="selectPromptForEdit(${index})">
        <div class="prompt-header">
          <span class="prompt-icon">${icon}</span>
          <span class="prompt-text">${index + 1}. ${truncate(prompt.text, 60)}</span>
          ${isEditing ? '<span class="editing-indicator">✏️</span>' : ""}
        </div>
        ${renderPromptDetails(prompt)}
      </div>
    `;
    })
    .join("");
}

// === Event Listeners ===

function initializeEventListeners() {
  // ... existing listeners ...

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Layout toggle
  document
    .querySelector(".layout-toggle")
    ?.addEventListener("click", toggleLayoutMode);

  // Editor actions
  elements.btnSaveEdit?.addEventListener("click", savePromptEdit);
  elements.btnCancelEdit?.addEventListener("click", cancelPromptEdit);
  elements.btnNewDraft?.addEventListener("click", startNewDraftPrompt);

  // New draft actions
  elements.btnSaveDraft?.addEventListener("click", () => {
    // Set loadAfter to false
    savePromptEdit();
  });

  elements.btnSaveLoadDraft?.addEventListener("click", () => {
    // Set loadAfter to true (need to modify savePromptEdit or use separate function)
    const newText = elements.editorTextarea.value.trim();
    const filename = elements.newPromptFilename.value.trim();

    if (!newText || !filename) return;

    vscode.postMessage({
      type: MESSAGE_TYPES.CREATE_DRAFT_PROMPT,
      content: newText,
      filename: filename,
      loadAfter: true,
    });
  });

  elements.btnCancelDraft?.addEventListener("click", cancelPromptEdit);

  // Enable Save button when editor content changes
  elements.editorTextarea?.addEventListener("input", () => {
    if (state.editingPromptIndex !== null || state.isNewDraft) {
      elements.btnSaveEdit.disabled = false;
    }
  });
}

// === Initialization ===

function restoreLayoutPreferences() {
  // Restore layout mode
  const savedLayoutMode = localStorage.getItem("flightpath.layoutMode");
  if (savedLayoutMode === "split") {
    state.layoutMode = "split";
    elements.rightPane.classList.remove("tab-mode");
    elements.rightPane.classList.add("split-mode");
    renderSplitView();
  }

  // Restore active tab
  const savedActiveTab = localStorage.getItem("flightpath.activeTab");
  if (savedActiveTab && ["output", "editor"].includes(savedActiveTab)) {
    switchTab(savedActiveTab);
  }
}

// Call on initialization
document.addEventListener("DOMContentLoaded", () => {
  initializeElements();
  initializeEventListeners();
  restoreLayoutPreferences();
  sendReadyMessage();
});
```

````

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
````

## Implementation Phases

### Phase 1: Tab Control & Layout Foundation (Essential)

- [ ] Restructure HTML: Add Editor tab to dashboard
- [ ] Implement tab control (Workflow/Editor/Output tabs)
- [ ] Implement tab switching logic
- [ ] Add CSS for tab control
- [ ] Handle responsive behavior
- [ ] Persist active tab to localStorage

**Estimated effort:** 0.5 day

### Phase 2: Basic contenteditable Editor (Essential)

- [ ] Add `contenteditable` div with `spellcheck="true"` to Editor tab
- [ ] Add completion dropdown HTML structure
- [ ] Add link tooltip HTML structure
- [ ] Add metadata bar (char count, word count, modified indicator)
- [ ] Add CSS for editor, dropdown, tooltips (see WEBVIEW_CUSTOM_COMPLETIONS.md)
- [ ] Implement "Select prompt to edit" flow
- [ ] Add state management for editing
- [ ] Implement save/cancel handlers (update workflow file)
- [ ] Add server-side file update logic (FlightPathDashboardProvider)

**Estimated effort:** 1 day

**Note:** This phase delivers a functional editor with browser spell check but NO completions/links yet.

### Phase 3: Custom JavaScript Completions (High Priority)

- [ ] Create `prompt-editor.js` with PromptEditor class
- [ ] Implement input detection (@ and # trigger characters)
- [ ] Implement keyboard navigation (↑↓, Enter, Escape)
- [ ] Implement dropdown rendering and positioning
- [ ] Add extension host `handleCompletionRequest()` method
- [ ] Request file/directory completions for @
- [ ] Request selection/symbol completions for #
- [ ] Implement completion insertion at cursor position
- [ ] Add cursor position management utilities

**Estimated effort:** 1.5 days

**Benefits unlocked:**

- ✅ @ completions for workspace files and directories
- ✅ # completions for current selections and symbols
- ✅ Keyboard navigation matching VS Code behavior
- ✅ Completion filtering as you type

### Phase 4: Link Detection & Click Handlers (High Priority)

- [ ] Implement regex-based link detection
- [ ] Detect @file references
- [ ] Detect #file:path:line-line references
- [ ] Detect #sym:path:symbol references
- [ ] Style links with CSS (underline, color)
- [ ] Implement Ctrl+Click / Cmd+Click handlers
- [ ] Add extension host `handleLinkClick()` method
- [ ] Open files, navigate to selections, jump to symbols
- [ ] Implement hover tooltips for links

**Estimated effort:** 1 day

**Benefits unlocked:**

- ✅ Clickable references to files, lines, and symbols
- ✅ Hover previews showing what will open
- ✅ Same UX as PromptLinkProvider but in-panel

### Phase 5: New Draft Prompt Creation (High Priority)

- [ ] Add "New Draft Prompt" button in editor
- [ ] Implement new draft mode (clear editor, show filename UI)
- [ ] Add filename input and validation
- [ ] Implement draft prompt creation logic (server-side)
- [ ] Add "Save" and "Save & Load" options
- [ ] Handle success/error notifications

**Estimated effort:** 0.5 day

### Phase 6: Polish & UX Improvements (Medium Priority)

- [ ] Add keyboard shortcuts (Ctrl+S to save, Esc to cancel)
- [ ] Implement character/word count updates (debounced)
- [ ] Add modified indicator (tracks changes from original)
- [ ] Improve animations and transitions
- [ ] Add loading indicators for save operations
- [ ] Add confirmation dialog for unsaved changes
- [ ] Test edge cases (rapid typing, large files, cursor positioning)
- [ ] Add placeholder text with usage hints

**Estimated effort:** 0.5 day

### Phase 7: Optional Monaco Upgrade (If Needed)

- [ ] Evaluate if contenteditable is sufficient
- [ ] If not: Integrate Monaco Editor (~5MB bundle increase)
- [ ] Rebuild completions for Monaco API
- [ ] Add syntax highlighting for markdown/code blocks
- [ ] Add find/replace functionality

**Estimated effort:** 2-3 days (only if needed)

**Total Core Implementation (Phases 1-6):** 5 days

**Note:** Phase 7 (Monaco) only needed if contenteditable proves insufficient. Most chat extensions use contenteditable successfully.

### Why This Phased Approach?

**Phase 2 (Textarea)** delivers immediate value:

- Users can edit prompts in the dashboard
- Simple edits don't require opening VS Code editor
- Fast iteration for tweaking existing prompts

**Phase 3 ("Edit in VS Code")** adds power-user features:

- Reuses ALL existing infrastructure (no code duplication)
- Professional editing experience for complex prompts
- All FlightPath completion/link providers work automatically
- Spell check integration "just works"

**Progressive enhancement:**

- Beginners: Use simple textarea
- Power users: Use "Edit in VS Code" for completions/spell-check
- Both workflows coexist peacefully

## Open Questions

1. **Editing during execution**: Should we allow editing prompts while a workflow is running?
   - **Recommendation:** Allow editing future prompts, disable currently executing prompt
   - **Indicator:** Show "Currently running" badge on active prompt in list

2. **Auto-save**: Should we auto-save changes periodically?
   - **Recommendation:** No auto-save initially, require explicit save action
   - **Future:** Add auto-save with visual indicator (like VS Code's dot on tab)

3. **Model selection scope**: Should editor show model selector for all workflows?
   - **Recommendation:** Show model selector, but disable if workflow doesn't support per-prompt models
   - **Tooltip:** Explain when disabled ("This workflow uses a single model for all prompts")

4. **Dirty state tracking**: Should we track unsaved changes and warn on close?
   - **Recommendation:** Yes, show warning if user:
     - Switches to different prompt with unsaved changes
     - Closes dashboard panel with unsaved changes
     - Starts workflow execution with unsaved changes

5. **Split view default**: Should split view be the default for wide screens?
   - **Recommendation:** No, default to tab view (Output tab active)
   - **Reasoning:** Split view can be overwhelming for new users, let them discover it
   - **Discoverability:** Tooltip on toggle button, or one-time hint on first use

6. **Content sharing between tab and split modes**: How to handle DOM elements?
   - **Option A:** Clone/recreate content in both views
   - **Option B:** Move DOM nodes between views
   - **Recommendation:** Use shared data model, render separately (avoids DOM manipulation bugs)

7. **Narrow screen split behavior**: Vertical split or force to tabs?
   - **Recommendation:** Allow vertical split (Output top, Editor bottom)
   - **Reasoning:** Users with vertical monitors may prefer this layout
   - **Constraint:** Minimum height required for each panel (200px)

8. **Keyboard shortcuts**: What shortcuts to support?
   - **Recommended:**
     - `Ctrl+S` / `Cmd+S`: Save prompt
     - `Esc`: Cancel edit
     - `Ctrl+E` / `Cmd+E`: Toggle split view
     - `Ctrl+1` / `Cmd+1`: Switch to Output tab
     - `Ctrl+2` / `Cmd+2`: Switch to Editor tab

## Success Metrics

1. **Adoption**: Track usage of inline editor vs. "Edit" button (VS Code editor)
2. **Efficiency**: Measure time to create/edit prompts (before vs. after)
3. **Error rates**: Monitor failed saves, validation errors
4. **User feedback**: Collect qualitative feedback on editing experience

## Summary

### Key Decisions

**1. Layout: Tab Control (Workflow | Editor | Output)**

- Three tabs in dashboard sidebar panel
- Workflow: Prompt list (existing)
- Editor: New contenteditable editor with completions
- Output: CLI output (existing)
- **Rationale:** Simple, no split-pane complexity, stays in sidebar

**2. Editor Technology: Custom JavaScript Completions (Like Copilot Chat)**

- **contenteditable div** with `spellcheck="true"` (browser spell check FREE)
- **Custom completion dropdown** built with HTML/CSS/JavaScript
- **Extension host provides data** (reuses PromptCompletionProvider logic)
- **Link detection** via regex (reuses PromptLinkProvider patterns)
- **Rationale:** Proven pattern (Copilot/Claude/Codex use this), full control, no API limitations

**3. No Monaco Editor Initially**

- ✅ Start with contenteditable (lightweight, sufficient for 95% of cases)
- ⏸️ Monaco as fallback if needed (adds 5MB, requires rebuilding providers)
- **Rationale:** Ship fast, upgrade later if users demand advanced features

### User Workflows

**Basic Editing:**

1. Click prompt in Workflow tab
2. Dashboard switches to Editor tab
3. Edit text with spell check (red squiggly lines appear automatically)
4. Click Save
5. Done ✅

**Using Completions:**

1. Type `@` in editor
2. Completion dropdown appears with workspace files/folders
3. Use ↑↓ arrows to select, Enter to insert
4. Type `#` in editor
5. Completion dropdown shows current selections and symbols
6. Select and insert
7. Click Save
8. Done ✅

**Using Links:**

1. Type `@src/extension.ts` in editor
2. Reference becomes underlined link (auto-detected)
3. Hover to see preview
4. Ctrl+Click to open file
5. Reference appears in prompt when executed
6. Done ✅

### Implementation Timeline

**Core Features (5 days):**

- Phase 1: Tab control layout (0.5 day)
- Phase 2: Basic contenteditable editor (1 day)
- Phase 3: Custom JavaScript completions (1.5 days)
- Phase 4: Link detection & click handlers (1 day)
- Phase 5: New draft prompts (0.5 day)
- Phase 6: Polish & UX (0.5 day)

**Optional Monaco Upgrade (2-3 days):**

- Only if contenteditable proves insufficient
- Most extensions (Copilot, Claude, Codex) don't need this

**Total:** 5 days for complete implementation (contenteditable approach)

### Technical Highlights

**Custom Completion Dropdown:**

```javascript
// In prompt-editor.js
class PromptEditor {
  handleInput(e) {
    const char = editor.textContent[getCursorPos() - 1];
    if (char === "@" || char === "#") {
      this.requestCompletions(char, getWordBeforeCursor());
    }
  }

  requestCompletions(trigger, prefix) {
    vscode.postMessage({
      type: "REQUEST_COMPLETIONS",
      trigger,
      prefix,
    });
  }
}
```

**Extension Host (Reuses Existing Logic):**

```typescript
// In FlightPathDashboardProvider.ts
private async handleCompletionRequest(trigger: string, prefix: string) {
  const items = [];

  if (trigger === '@') {
    // Same logic as PromptCompletionProvider.provideCompletionItems
    const files = await vscode.workspace.findFiles('**/*');
    items.push(...files.map(uri => ({
      label: vscode.workspace.asRelativePath(uri),
      insertText: `@${vscode.workspace.asRelativePath(uri)}`,
      type: 'file'
    })));
  }

  this.postMessage({ type: 'COMPLETION_ITEMS', items });
}
```

**Browser Spell Check (FREE):**

```html
<div contenteditable="true" spellcheck="true">
  <!-- Red squiggly lines appear automatically! -->
</div>
```

**Reuses existing PromptCompletionProvider and PromptLinkProvider patterns** - No duplication, just different presentation layer!

### Success Metrics

**Feature Adoption:**

- % of prompts edited in textarea vs VS Code editor
- Frequency of "Edit in VS Code" button clicks

**User Satisfaction:**

- Time saved editing prompts (before/after)
- Qualitative feedback on editing experience

**Technical Quality:**

- Zero code duplication for completions/links
- Spell check integration works seamlessly

### Future Enhancements (Post-Launch)

1. **Smart "Edit in VS Code"** - Auto-open when user types @ or #
2. **Inline hints** - Show @ and # syntax hints in textarea
3. **Multi-prompt editing** - Select multiple prompts, edit in VS Code
4. **Prompt templates** - Pre-built snippets for common patterns
5. **Version history** - Track prompt changes over time
