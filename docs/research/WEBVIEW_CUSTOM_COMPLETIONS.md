# Webview Custom Completions Implementation

## Executive Summary

**Goal:** Add rich in-panel prompt editing to FlightPath dashboard with:

- @ completions (workspace files, directories)
- # completions (file selections, symbols)
- Spell check (browser native)
- Ctrl+Click links to open files/selections
- Keyboard navigation (↑↓ arrows, Enter, Escape)

**Approach:** Custom JavaScript completions in webview (same as Copilot Chat, Claude, Codex)

**Effort:** ~3-5 days implementation

- Day 1: Basic contenteditable + dropdown UI
- Day 2: Completion logic + keyboard navigation
- Day 3: Link detection + click handlers
- Day 4: Integration with existing providers
- Day 5: Polish + edge cases

## Research Summary

### Key Finding: Chat Extensions Use Custom JavaScript Completions

**GitHub Copilot Chat, Claude Code, and Codex extensions DO NOT use native VS Code completions.** They build custom completion UIs entirely with HTML/CSS/JavaScript in their webviews.

## How It Actually Works

### 1. **Input Element**

Uses standard HTML `contenteditable` div or `<textarea>`:

```html
<div
  contenteditable="true"
  id="prompt-input"
  class="prompt-editor"
  placeholder="Type your prompt..."
></div>
```

### 2. **Custom Completion Dropdown**

A styled div that appears on trigger:

```html
<div id="completion-dropdown" class="completion-menu" hidden>
  <div class="completion-item" data-index="0">
    <span class="completion-icon">📄</span>
    <span class="completion-label">src/extension.ts</span>
  </div>
  <div class="completion-item" data-index="1">
    <span class="completion-icon">📄</span>
    <span class="completion-label">src/FlightPathManager.ts</span>
  </div>
</div>
```

### 3. **JavaScript Logic**

Detects trigger characters and shows dropdown:

```javascript
const editor = document.getElementById("prompt-input");
const dropdown = document.getElementById("completion-dropdown");
let completionItems = [];
let selectedIndex = 0;

editor.addEventListener("input", (e) => {
  const text = editor.textContent;
  const cursorPos = getCursorPosition();

  // Check for trigger characters
  if (text[cursorPos - 1] === "@" || text[cursorPos - 1] === "#") {
    // Request completions from extension host
    vscode.postMessage({
      type: "REQUEST_COMPLETIONS",
      trigger: text[cursorPos - 1],
      prefix: getWordBeforeCursor(),
    });
  }
});

// Handle keyboard navigation
editor.addEventListener("keydown", (e) => {
  if (!dropdown.hidden) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, completionItems.length - 1);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertCompletion(completionItems[selectedIndex]);
      hideDropdown();
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  }
});

// Receive completions from extension host
window.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === "COMPLETION_ITEMS") {
    completionItems = message.items;
    showDropdown(message.items, getCursorCoordinates());
  }
});
```

### 4. **Extension Host Side**

Responds with completion data:

```typescript
// In FlightPathDashboardProvider.ts
private async handleCompletionRequest(trigger: string, prefix: string): Promise<void> {
  let items: CompletionItem[] = [];

  if (trigger === '@') {
    // Get workspace files
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
    items = files.map(uri => ({
      label: vscode.workspace.asRelativePath(uri),
      insertText: `@${vscode.workspace.asRelativePath(uri)}`,
      icon: '📄',
      type: 'file'
    }));
  }
  else if (trigger === '#') {
    // Get current file selections or symbols
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const selection = editor.selection;
      if (!selection.isEmpty) {
        items.push({
          label: `${filePath}:${selection.start.line + 1}-${selection.end.line + 1}`,
          insertText: `#file:${filePath}:${selection.start.line + 1}-${selection.end.line + 1}`,
          icon: '📍',
          type: 'selection'
        });
      }
    }
  }

  // Filter by prefix
  if (prefix) {
    items = items.filter(item =>
      item.label.toLowerCase().includes(prefix.toLowerCase())
    );
  }

  this.postMessage({
    type: 'COMPLETION_ITEMS',
    items: items.slice(0, 50) // Limit results
  });
}
```

## FlightPath Implementation Plan

### Phase 1: Replace Textarea with Custom Editor

**Current:**

```html
<textarea id="prompt-text" rows="10"></textarea>
```

**New:**

```html
<div class="prompt-editor-container">
  <div
    id="prompt-editor"
    contenteditable="true"
    class="prompt-editor"
    spellcheck="true"
    placeholder="Type your prompt... Use @ for files, # for selections"
  ></div>
  <div id="completion-dropdown" class="completion-menu" hidden>
    <!-- Populated dynamically -->
  </div>
</div>
```

### Phase 2: Add Completion Logic

**File:** `src/ui/webview/prompt-editor.js`

```javascript
class PromptEditor {
  constructor(editorElement, dropdownElement) {
    this.editor = editorElement;
    this.dropdown = dropdownElement;
    this.completionItems = [];
    this.selectedIndex = 0;
    this.isDropdownVisible = false;

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Input detection
    this.editor.addEventListener("input", this.handleInput.bind(this));

    // Keyboard navigation
    this.editor.addEventListener("keydown", this.handleKeyDown.bind(this));

    // Click to insert
    this.dropdown.addEventListener(
      "click",
      this.handleDropdownClick.bind(this)
    );

    // Blur to hide (with delay for click handling)
    this.editor.addEventListener("blur", () => {
      setTimeout(() => this.hideDropdown(), 200);
    });
  }

  handleInput(e) {
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();
    const charBefore = text[cursorPos - 1];

    if (charBefore === "@" || charBefore === "#") {
      this.requestCompletions(charBefore, "");
    } else if (this.isDropdownVisible) {
      // Filter current completions
      const prefix = this.getWordBeforeCursor();
      this.filterCompletions(prefix);
    }
  }

  requestCompletions(trigger, prefix) {
    vscode.postMessage({
      type: "REQUEST_COMPLETIONS",
      trigger,
      prefix,
    });
  }

  showCompletions(items) {
    this.completionItems = items;
    this.selectedIndex = 0;
    this.renderDropdown();
    this.positionDropdown();
    this.dropdown.hidden = false;
    this.isDropdownVisible = true;
  }

  renderDropdown() {
    this.dropdown.innerHTML = this.completionItems
      .map(
        (item, index) => `
      <div class="completion-item ${index === this.selectedIndex ? "selected" : ""}" data-index="${index}">
        <span class="completion-icon">${item.icon || "📄"}</span>
        <span class="completion-label">${this.escapeHtml(item.label)}</span>
        ${item.detail ? `<span class="completion-detail">${this.escapeHtml(item.detail)}</span>` : ""}
      </div>
    `
      )
      .join("");
  }

  // ... keyboard navigation, insertion, etc.
}
```

### Phase 3: Spell Check

**Spell check works automatically** with `contenteditable` + `spellcheck="true"` attribute!

Browser provides native spell check (red squiggly lines), no custom code needed.

### Phase 4: Clickable Links

**Regex-based link detection:**

```javascript
class PromptEditor {
  // ...

  highlightLinks() {
    const text = this.editor.textContent;
    const linkPatterns = [
      /@([^\s]+)/g, // @file references
      /#file:([^\s:]+:\d+-\d+)/g, // #file:path:line-line
    ];

    // Replace with clickable spans
    let html = this.escapeHtml(text);
    html = html.replace(
      /@([^\s]+)/g,
      '<span class="link" data-type="file" data-value="$1">@$1</span>'
    );
    html = html.replace(
      /#file:([^\s:]+:\d+-\d+)/g,
      '<span class="link" data-type="selection" data-value="$1">#file:$1</span>'
    );

    this.editor.innerHTML = html;
    this.restoreCursor();
  }

  handleLinkClick(e) {
    if (e.target.classList.contains("link")) {
      const type = e.target.dataset.type;
      const value = e.target.dataset.value;

      vscode.postMessage({
        type: "OPEN_LINK",
        linkType: type,
        linkValue: value,
      });
    }
  }
}
```

**CSS:**

```css
.prompt-editor .link {
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
  cursor: pointer;
}

.prompt-editor .link:hover {
  tFull Implementation Plan

### Architecture Overview

```

┌─────────────────────────────────────────────────────────────┐
│ FlightPath Dashboard (Webview) │
├─────────────────────────────────────────────────────────────┤
│ │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Prompt Editor Tab │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ │ │
│ │ ┌──────────────────────────────────────────────┐ │ │
│ │ │ contenteditable Editor │ │ │
│ │ │ - Type @ for files │ │ │
│ │ │ - Type # for selections │ │ │
│ │ │ - Spell check enabled │ │ │
│ │ │ - Links auto-detected & Ctrl+Clickable │ │ │
│ │ └──────────────────────────────────────────────┘ │ │
│ │ │ │
│ │ ┌──────────────────────────────────────────────┐ │ │
│ │ │ Completion Dropdown (when @ or # typed) │ │ │
│ │ ├──────────────────────────────────────────────┤ │ │
│ │ │ > 📄 src/extension.ts │ │ │
│ │ │ 📄 src/FlightPathManager.ts │ │ │
│ │ │ 📁 src/flightpath/ │ │ │
│ │ │ 📍 extension.ts:42-58 (selected) │ │ │
│ │ └──────────────────────────────────────────────┘ │ │
│ │ │ │
│ │ [Save Draft] [Load File] [Clear] │ │
│ └────────────────────────────────────────────────────┘ │
│ │
└─────────────────────────────────────────────────────────────┘
↕ postMessage ↕ postMessage
┌─────────────────────────────────────────────────────────────┐
│ Extension Host (FlightPathDashboardProvider) │
├─────────────────────────────────────────────────────────────┤
│ - handleCompletionRequest() │
│ - handleLinkClick() │
│ - handleSaveDraft() │
│ Reuses: │
│ - PromptCompletionProvider logic (file/selection search) │
│ - PromptLinkProvider logic (link detection patterns) │
└─────────────────────────────────────────────────────────────┘

````

### Phase 1: HTML Structure & Basic Editor

**File:** `src/ui/webview/dashboard.html`

Add new tab structure to dashboard:

```html
<!-- Add after prompts-section -->
<div id="editor-section" class="editor-section" hidden>
  <div class="section-header">
    <h3>Prompt Editor</h3>
    <div class="editor-controls">
      <button id="btn-editor-load" class="btn-secondary btn-small" title="Load prompt file">
        Load
      </button>
      <button id="btn-editor-save" class="btn-secondary btn-small" title="Save as draft">
        Save Draft
      </button>
      <button id="btn-editor-clear" class="btn-secondary btn-small" title="Clear editor">
        Clear
      </button>
    </div>
  </div>

  <div class="editor-container">
    <!-- Main editor with contenteditable -->
    <div
      id="prompt-editor"
      class="prompt-editor"
      contenteditable="true"
      spellcheck="true"
      data-placeholder="Type your prompt here...&#10;&#10;Use @ to reference files and folders&#10;Use # for file selections and symbols&#10;&#10;Examples:&#10;  @src/extension.ts - Reference entire file&#10;  @src/flightpath/ - Reference directory&#10;  #file:src/extension.ts:10-20 - Reference specific lines&#10;  #sym:src/types.ts:PromptFile - Reference symbol"
    ></div>

    <!-- Completion dropdown (positioned absolutely over editor) -->
    <div id="completion-dropdown" class="completion-dropdown" hidden>
      <div class="completion-header">
        <span class="completion-title">Suggestions</span>
        <span class="completion-hint">↑↓ navigate • ↵ select • Esc dismiss</span>
      </div>
      <div class="completion-list">
        <!-- Populated dynamically -->
      </div>
      <div class="completion-footer">
        <span id="completion-count">0 items</span>
      </div>
    </div>

    <!-- Link preview tooltip (shown on hover over detected links) -->
    <div id="link-tooltip" class="link-tooltip" hidden>
      <div class="link-tooltip-content">
        <!-- Populated dynamically -->
      </div>
    </div>
  </div>

  <!-- Editor metadata bar -->
  <div class="editor-metadata">
    <span id="editor-char-count" class="metadata-item">0 characters</span>
    <span class="metadata-separator">•</span>
    <span id="editor-word-count" class="metadata-item">0 words</span>
    <span class="metadata-separator">•</span>
    <span id="editor-modified" class="metadata-item" hidden>Modified</span>
  </div>
</div>

<!-- Tab switcher buttons (add to header) -->
<div id="view-tabs" class="view-tabs">
  <button class="tab-button active" data-tab="prompts">
    <span class="codicon codicon-list-unordered"></span> Workflow
  </button>
  <button class="tab-button" data-tab="editor">
    <span class="codicon codicon-edit"></span> Editor
  </button>
  <button class="tab-button" data-tab="output">
    <span class="codicon codicon-output"></span> Output
  </button>
</div>
````

### Phase 2: CSS Styling

**File:** `src/ui/webview/prompt-editor.css` (new file)

```css
/* ============================================
   PROMPT EDITOR STYLES
   ============================================ */

/* Editor Container */
.editor-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.editor-container {
  position: relative;
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-input-border, var(--border-color));
  border-radius: 4px;
  margin: var(--spacing-md) 0;
}

/* Contenteditable Editor */
.prompt-editor {
  flex: 1;
  padding: var(--spacing-md);
  overflow-y: auto;
  font-family: var(
    --vscode-editor-font-family,
    "Consolas",
    "Courier New",
    monospace
  );
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.6;
  color: var(--vscode-editor-foreground);
  outline: none;
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* Placeholder styling */
.prompt-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--vscode-input-placeholderForeground);
  pointer-events: none;
  white-space: pre-wrap;
  opacity: 0.6;
}

.prompt-editor:focus:empty::before {
  opacity: 0.4;
}

/* Link styling */
.prompt-editor .link {
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
  border-radius: 2px;
  padding: 0 2px;
  transition: background-color 0.1s ease;
}

.prompt-editor .link:hover {
  background-color: var(
    --vscode-textLink-activeForeground,
    rgba(75, 150, 255, 0.1)
  );
  text-decoration-style: solid;
}

.prompt-editor .link.file-link {
  /* @file references */
}

.prompt-editor .link.selection-link {
  /* #file:path:lines references */
}

.prompt-editor .link.symbol-link {
  /* #sym:path:symbol references */
}

/* Completion Dropdown */
.completion-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 300px;
  background: var(--vscode-editorSuggestWidget-background);
  border: 1px solid var(--vscode-editorSuggestWidget-border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  margin-bottom: 4px;
}

.completion-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-editorSuggestWidget-background);
  border-bottom: 1px solid var(--vscode-editorSuggestWidget-border);
  font-size: 11px;
}

.completion-title {
  font-weight: 600;
  color: var(--vscode-editorSuggestWidget-foreground);
}

.completion-hint {
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
}

.completion-list {
  flex: 1;
  overflow-y: auto;
  max-height: 250px;
}

.completion-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background-color 0.05s ease;
}

.completion-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.completion-item.selected {
  background-color: var(--vscode-list-activeSelectionBackground);
  border-left-color: var(--vscode-list-activeSelectionForeground);
}

.completion-item.selected .completion-label {
  color: var(--vscode-list-activeSelectionForeground);
}

.completion-icon {
  font-size: 16px;
  flex-shrink: 0;
  width: 20px;
  text-align: center;
}

.completion-label {
  flex: 1;
  font-size: 13px;
  color: var(--vscode-editorSuggestWidget-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.completion-detail {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
  padding-left: var(--spacing-sm);
}

.completion-footer {
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-editorSuggestWidget-background);
  border-top: 1px solid var(--vscode-editorSuggestWidget-border);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-align: right;
}

/* Link Tooltip */
.link-tooltip {
  position: absolute;
  background: var(--vscode-editorHoverWidget-background);
  border: 1px solid var(--vscode-editorHoverWidget-border);
  border-radius: 4px;
  padding: var(--spacing-sm);
  font-size: 12px;
  color: var(--vscode-editorHoverWidget-foreground);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  z-index: 999;
  max-width: 400px;
  pointer-events: none;
}

.link-tooltip-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

/* Editor Metadata Bar */
.editor-metadata {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--vscode-statusBar-background);
  color: var(--vscode-statusBar-foreground);
  font-size: 11px;
  border-radius: 0 0 4px 4px;
}

.metadata-item {
  white-space: nowrap;
}

.metadata-separator {
  color: var(--vscode-statusBar-foreground);
  opacity: 0.5;
}

/* Tab Switcher */
.view-tabs {
  display: flex;
  gap: 2px;
  padding: var(--spacing-xs) 0;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: var(--spacing-md);
}

.tab-button {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  color: var(--fg-secondary);
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s ease;
}

.tab-button:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--fg-primary);
}

.tab-button.active {
  color: var(--vscode-textLink-activeForeground);
  border-bottom-color: var(--vscode-textLink-activeForeground);
  font-weight: 600;
}

.tab-button .codicon {
  font-size: 14px;
}

/* Scrollbar styling for completion list */
.completion-list::-webkit-scrollbar {
  width: 8px;
}

.completion-list::-webkit-scrollbar-track {
  background: var(--vscode-scrollbarSlider-background);
}

.completion-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-hoverBackground);
  border-radius: 4px;
}

.completion-list::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-activeBackground);
}
```

### Phase 3: JavaScript Implementation

**File:** `src/ui/webview/prompt-editor.js` (new file)

```javascript
/**
 * FlightPath Prompt Editor
 * Custom contenteditable editor with @ and # completions
 */

class PromptEditor {
  constructor(vscode) {
    this.vscode = vscode;

    // DOM elements
    this.editor = document.getElementById("prompt-editor");
    this.dropdown = document.getElementById("completion-dropdown");
    this.dropdownList = this.dropdown.querySelector(".completion-list");
    this.dropdownCount = document.getElementById("completion-count");
    this.tooltip = document.getElementById("link-tooltip");
    this.charCount = document.getElementById("editor-char-count");
    this.wordCount = document.getElementById("editor-word-count");
    this.modifiedIndicator = document.getElementById("editor-modified");

    // State
    this.completionItems = [];
    this.selectedIndex = 0;
    this.isDropdownVisible = false;
    this.currentTrigger = null; // '@' or '#'
    this.currentPrefix = "";
    this.triggerPosition = null;
    this.isModified = false;
    this.originalContent = "";

    // Link patterns (same as PromptLinkProvider)
    this.linkPatterns = [
      { regex: /@([^\s]+)/g, type: "file" },
      { regex: /#file:([^\s:]+):(\d+)-(\d+)/g, type: "selection" },
      { regex: /#sym:([^\s:]+):([^\s:]+)(?::(\d+))?/g, type: "symbol" },
    ];

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.updateMetadata();
  }

  setupEventListeners() {
    // Input detection for completions
    this.editor.addEventListener("input", this.handleInput.bind(this));

    // Keyboard navigation
    this.editor.addEventListener("keydown", this.handleKeyDown.bind(this));

    // Link detection and styling (on input debounced)
    this.editor.addEventListener(
      "input",
      this.debounce(() => {
        this.detectAndStyleLinks();
      }, 300)
    );

    // Click handlers for links
    this.editor.addEventListener("click", this.handleEditorClick.bind(this));

    // Hover for link tooltips
    this.editor.addEventListener("mousemove", this.handleMouseMove.bind(this));
    this.editor.addEventListener("mouseleave", () => this.hideTooltip());

    // Dropdown click to insert
    this.dropdownList.addEventListener(
      "click",
      this.handleDropdownClick.bind(this)
    );

    // Blur to hide dropdown (with delay for click handling)
    this.editor.addEventListener("blur", () => {
      setTimeout(() => this.hideDropdown(), 200);
    });

    // Metadata updates
    this.editor.addEventListener(
      "input",
      this.debounce(() => {
        this.updateMetadata();
        this.markModified();
      }, 500)
    );

    // Message handler from extension
    window.addEventListener("message", this.handleMessage.bind(this));
  }

  // ============================================
  // COMPLETION LOGIC
  // ============================================

  handleInput(e) {
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();

    if (cursorPos === null) return;

    const charBefore = text[cursorPos - 1];

    // Check for trigger characters
    if (charBefore === "@" || charBefore === "#") {
      this.currentTrigger = charBefore;
      this.triggerPosition = cursorPos - 1;
      this.currentPrefix = "";
      this.requestCompletions(charBefore, "");
    }
    // Update prefix if dropdown is visible
    else if (this.isDropdownVisible) {
      const prefix = this.getWordBeforeCursor();

      // Close dropdown if user deleted trigger or moved away
      if (!this.isValidCompletionContext()) {
        this.hideDropdown();
        return;
      }

      this.currentPrefix = prefix;
      this.filterCompletions(prefix);
    }
  }

  isValidCompletionContext() {
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();

    if (cursorPos === null || this.triggerPosition === null) return false;

    // Check if trigger character still exists before cursor
    const textBetween = text.substring(this.triggerPosition, cursorPos);

    // Must start with trigger and only contain valid identifier chars
    return (
      textBetween.startsWith(this.currentTrigger) &&
      /^[@#][\w\/.:-]*$/.test(textBetween)
    );
  }

  requestCompletions(trigger, prefix) {
    this.vscode.postMessage({
      type: "REQUEST_COMPLETIONS",
      trigger,
      prefix,
    });
  }

  showCompletions(items) {
    this.completionItems = items;
    this.selectedIndex = 0;
    this.renderDropdown();
    this.positionDropdown();
    this.dropdown.hidden = false;
    this.isDropdownVisible = true;
  }

  filterCompletions(prefix) {
    if (!prefix) {
      this.showCompletions(this.completionItems);
      return;
    }

    const filtered = this.completionItems.filter((item) =>
      item.label.toLowerCase().includes(prefix.toLowerCase())
    );

    this.completionItems = filtered;
    this.selectedIndex = 0;
    this.renderDropdown();

    if (filtered.length === 0) {
      this.hideDropdown();
    }
  }

  renderDropdown() {
    this.dropdownList.innerHTML = this.completionItems
      .map(
        (item, index) => `
      <div class="completion-item ${index === this.selectedIndex ? "selected" : ""}" data-index="${index}">
        <span class="completion-icon">${this.getCompletionIcon(item.type)}</span>
        <span class="completion-label">${this.escapeHtml(item.label)}</span>
        ${item.detail ? `<span class="completion-detail">${this.escapeHtml(item.detail)}</span>` : ""}
      </div>
    `
      )
      .join("");

    this.dropdownCount.textContent = `${this.completionItems.length} item${this.completionItems.length === 1 ? "" : "s"}`;
  }

  positionDropdown() {
    // Position dropdown near cursor
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const editorRect = this.editor.getBoundingClientRect();

    // Position above cursor (or below if not enough space)
    const dropdownHeight = 300; // max-height from CSS
    const spaceAbove = rect.top - editorRect.top;
    const spaceBelow = editorRect.bottom - rect.bottom;

    if (spaceAbove > dropdownHeight || spaceAbove > spaceBelow) {
      this.dropdown.style.bottom = `${editorRect.bottom - rect.top + 4}px`;
      this.dropdown.style.top = "auto";
    } else {
      this.dropdown.style.top = `${rect.bottom - editorRect.top + 4}px`;
      this.dropdown.style.bottom = "auto";
    }
  }

  hideDropdown() {
    this.dropdown.hidden = true;
    this.isDropdownVisible = false;
    this.currentTrigger = null;
    this.triggerPosition = null;
    this.currentPrefix = "";
  }

  // ============================================
  // KEYBOARD NAVIGATION
  // ============================================

  handleKeyDown(e) {
    if (!this.isDropdownVisible) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.selectNext();
        break;
      case "ArrowUp":
        e.preventDefault();
        this.selectPrevious();
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        this.insertSelectedCompletion();
        break;
      case "Escape":
        e.preventDefault();
        this.hideDropdown();
        break;
    }
  }

  selectNext() {
    this.selectedIndex = Math.min(
      this.selectedIndex + 1,
      this.completionItems.length - 1
    );
    this.updateSelection();
  }

  selectPrevious() {
    this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
    this.updateSelection();
  }

  updateSelection() {
    const items = this.dropdownList.querySelectorAll(".completion-item");
    items.forEach((item, index) => {
      item.classList.toggle("selected", index === this.selectedIndex);
    });

    // Scroll into view
    const selectedItem = items[this.selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: "nearest" });
    }
  }

  handleDropdownClick(e) {
    const item = e.target.closest(".completion-item");
    if (!item) return;

    const index = parseInt(item.dataset.index);
    this.selectedIndex = index;
    this.insertSelectedCompletion();
  }

  insertSelectedCompletion() {
    if (
      this.selectedIndex < 0 ||
      this.selectedIndex >= this.completionItems.length
    )
      return;

    const completion = this.completionItems[this.selectedIndex];
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();

    // Replace from trigger position to cursor
    const before = text.substring(0, this.triggerPosition);
    const after = text.substring(cursorPos);
    const newText = before + completion.insertText + after;

    this.editor.textContent = newText;

    // Set cursor after inserted text
    const newCursorPos = this.triggerPosition + completion.insertText.length;
    this.setCursorPosition(newCursorPos);

    this.hideDropdown();
    this.detectAndStyleLinks();
    this.markModified();
  }

  // ============================================
  // LINK DETECTION & STYLING
  // ============================================

  detectAndStyleLinks() {
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();

    // Build HTML with link spans
    let html = this.escapeHtml(text);

    // Apply each link pattern
    this.linkPatterns.forEach((pattern) => {
      html = html.replace(pattern.regex, (match) => {
        return `<span class="link ${pattern.type}-link" data-type="${pattern.type}" data-value="${this.escapeHtml(match)}">${this.escapeHtml(match)}</span>`;
      });
    });

    // Only update if content changed (avoid losing cursor)
    if (this.editor.innerHTML !== html) {
      this.editor.innerHTML = html;
      if (cursorPos !== null) {
        this.setCursorPosition(cursorPos);
      }
    }
  }

  handleEditorClick(e) {
    const link = e.target.closest(".link");
    if (!link) return;

    // Ctrl+Click or Cmd+Click to open
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.openLink(link.dataset.type, link.dataset.value);
    }
  }

  openLink(type, value) {
    this.vscode.postMessage({
      type: "OPEN_LINK",
      linkType: type,
      linkValue: value,
    });
  }

  // ============================================
  // TOOLTIPS
  // ============================================

  handleMouseMove(e) {
    const link = e.target.closest(".link");

    if (link) {
      this.showTooltip(link, e.clientX, e.clientY);
    } else {
      this.hideTooltip();
    }
  }

  showTooltip(linkElement, x, y) {
    const type = linkElement.dataset.type;
    const value = linkElement.dataset.value;

    let content = "";

    switch (type) {
      case "file":
        content = `<strong>File Reference</strong><br>Ctrl+Click to open: ${value}`;
        break;
      case "selection":
        content = `<strong>Line Selection</strong><br>Ctrl+Click to open: ${value}`;
        break;
      case "symbol":
        content = `<strong>Symbol Reference</strong><br>Ctrl+Click to navigate: ${value}`;
        break;
    }

    this.tooltip.querySelector(".link-tooltip-content").innerHTML = content;
    this.tooltip.style.left = `${x + 10}px`;
    this.tooltip.style.top = `${y + 10}px`;
    this.tooltip.hidden = false;
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  getCursorPosition() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(this.editor);
    preRange.setEnd(range.endContainer, range.endOffset);

    return preRange.toString().length;
  }

  setCursorPosition(pos) {
    const selection = window.getSelection();
    const range = document.createRange();

    let currentPos = 0;
    let found = false;

    const findPosition = (node) => {
      if (found) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent.length;
        if (currentPos + length >= pos) {
          range.setStart(node, pos - currentPos);
          range.collapse(true);
          found = true;
        } else {
          currentPos += length;
        }
      } else {
        for (let child of node.childNodes) {
          findPosition(child);
          if (found) break;
        }
      }
    };

    findPosition(this.editor);

    if (found) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  getWordBeforeCursor() {
    const text = this.editor.textContent;
    const cursorPos = this.getCursorPosition();

    if (cursorPos === null || this.triggerPosition === null) return "";

    const textAfterTrigger = text.substring(
      this.triggerPosition + 1,
      cursorPos
    );
    return textAfterTrigger;
  }

  updateMetadata() {
    const text = this.editor.textContent;
    const charCount = text.length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

    this.charCount.textContent = `${charCount} character${charCount === 1 ? "" : "s"}`;
    this.wordCount.textContent = `${wordCount} word${wordCount === 1 ? "" : "s"}`;
  }

  markModified() {
    if (this.editor.textContent !== this.originalContent) {
      this.isModified = true;
      this.modifiedIndicator.hidden = false;
    } else {
      this.isModified = false;
      this.modifiedIndicator.hidden = true;
    }
  }

  getCompletionIcon(type) {
    const icons = {
      file: "📄",
      directory: "📁",
      selection: "📍",
      symbol: "🔷",
    };
    return icons[type] || "•";
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // ============================================
  // PUBLIC API
  // ============================================

  setText(text) {
    this.editor.textContent = text;
    this.originalContent = text;
    this.detectAndStyleLinks();
    this.updateMetadata();
    this.isModified = false;
    this.modifiedIndicator.hidden = true;
  }

  getText() {
    return this.editor.textContent;
  }

  clear() {
    this.setText("");
  }

  focus() {
    this.editor.focus();
  }

  // ============================================
  // MESSAGE HANDLING
  // ============================================

  handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case "COMPLETION_ITEMS":
        this.showCompletions(message.items);
        break;
      case "LOAD_PROMPT":
        this.setText(message.content);
        break;
    }
  }
}

// Initialize editor when DOM is ready
let promptEditor;
if (typeof vscode !== "undefined") {
  promptEditor = new PromptEditor(vscode);
}
```

### Phase 4: Extension Host Integration

**File:** `src/ui/FlightPathDashboardProvider.ts`

Add completion request handler:

```typescript
private async handleCompletionRequest(
  trigger: string,
  prefix: string
): Promise<void> {
  const items: CompletionItem[] = [];

  if (trigger === '@') {
    // File and directory completions
    const files = await vscode.workspace.findFiles(
      '**/*',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}'
    );

    // Add files
    items.push(...files.map(uri => ({
      label: vscode.workspace.asRelativePath(uri),
      insertText: `@${vscode.workspace.asRelativePath(uri)}`,
      type: 'file',
      detail: 'File'
    })));

    // Add unique directories
    const dirs = new Set<string>();
    files.forEach(uri => {
      const relativePath = vscode.workspace.asRelativePath(uri);
      const dirPath = relativePath.substring(0, relativePath.lastIndexOf('/'));
      if (dirPath) {
        const parts = dirPath.split('/');
        for (let i = 1; i <= parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/') + '/');
        }
      }
    });

    items.push(...Array.from(dirs).map(dir => ({
      label: dir,
      insertText: `@${dir}`,
      type: 'directory',
      detail: 'Directory'
    })));
  }
  else if (trigger === '#') {
    // Selection and symbol completions
    const editor = vscode.window.activeTextEditor;

    if (editor) {
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);

      // Current selection
      if (!editor.selection.isEmpty) {
        const start = editor.selection.start.line + 1;
        const end = editor.selection.end.line + 1;
        items.push({
          label: `${filePath}:${start}-${end}`,
          insertText: `#file:${filePath}:${start}-${end}`,
          type: 'selection',
          detail: 'Current selection'
        });
      }

      // Symbols in current file
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri
      );

      if (symbols) {
        this.flattenSymbols(symbols).forEach(symbol => {
          items.push({
            label: `${filePath}:${symbol.name}`,
            insertText: `#sym:${filePath}:${symbol.name}:${symbol.range.start.line + 1}`,
            type: 'symbol',
            detail: vscode.SymbolKind[symbol.kind]
          });
        });
      }
    }
  }

  // Filter by prefix if provided
  let filtered = items;
  if (prefix) {
    const lowerPrefix = prefix.toLowerCase();
    filtered = items.filter(item =>
      item.label.toLowerCase().includes(lowerPrefix)
    );
  }

  // Limit results
  const limited = filtered.slice(0, 100);

  this.postMessage({
    type: 'COMPLETION_ITEMS',
    items: limited
  });
}

private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];

  const flatten = (syms: vscode.DocumentSymbol[]) => {
    syms.forEach(sym => {
      result.push(sym);
      if (sym.children) {
        flatten(sym.children);
      }
    });
  };

  flatten(symbols);
  return result;
}

private async handleLinkClick(linkType: string, linkValue: string): Promise<void> {
  // Reuse PromptLinkProvider logic
  if (linkType === 'file') {
    const filePath = linkValue.substring(1); // Remove @
    const uri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      filePath
    );
    await vscode.window.showTextDocument(uri);
  }
  else if (linkType === 'selection') {
    // Parse #file:path:start-end
    const match = linkValue.match(/#file:([^:]+):(\d+)-(\d+)/);
    if (match) {
      const [, filePath, startStr, endStr] = match;
      const start = parseInt(startStr) - 1;
      const end = parseInt(endStr) - 1;

      const uri = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        filePath
      );

      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      const range = new vscode.Range(
        new vscode.Position(start, 0),
        new vscode.Position(end, doc.lineAt(end).text.length)
      );

      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }
  else if (linkType === 'symbol') {
    // Parse #sym:path:symbolName:line
    const match = linkValue.match(/#sym:([^:]+):([^:]+)(?::(\d+))?/);
    if (match) {
      const [, filePath, symbolName, lineStr] = match;
      const uri = vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders![0].uri,
        filePath
      );

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      if (lineStr) {
        const line = parseInt(lineStr) - 1;
        const editor = vscode.window.activeTextEditor!;
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}

interface CompletionItem {
  label: string;
  insertText: string;
  type: 'file' | 'directory' | 'selection' | 'symbol';
  detail?: string;
}
```

### Phase 5: Integration with Dashboard

Update dashboard.js to handle tab switching and editor initialization:

```javascript
// Tab switching
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;

    // Update active tab button
    document
      .querySelectorAll(".tab-button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    // Show/hide sections
    document.getElementById("prompts-section").hidden = tab !== "prompts";
    document.getElementById("editor-section").hidden = tab !== "editor";
    document.getElementById("output-section").hidden = tab !== "output";

    // Focus editor if switched to editor tab
    if (tab === "editor" && promptEditor) {
      promptEditor.focus();
    }
  });
});

// Load prompt into editor
function loadPromptIntoEditor(promptText) {
  if (promptEditor) {
    promptEditor.setText(promptText);

    // Switch to editor tab
    document.querySelector('[data-tab="editor"]').click();
  }
}

// Save draft
document.getElementById("btn-editor-save").addEventListener("click", () => {
  const content = promptEditor.getText();
  vscode.postMessage({
    type: "SAVE_DRAFT_PROMPT",
    content,
  });
});

// Clear editor
document.getElementById("btn-editor-clear").addEventListener("click", () => {
  if (confirm("Clear editor content?")) {
    promptEditor.clear();
  }
});
```

## Monaco Editor Fallback (If Needed)

If contenteditable proves insufficient, we can upgrade to Monaco Editor:

**Pros:**

- Full VS Code editor features (minimap, find/replace, etc.)
- Better performance with large files
- Built-in syntax highlighting

**Cons:**

- Large bundle size (~5MB)
- Cannot reuse VS Code completion providers directly
- Requires rebuilding completion logic for Monaco API

**Implementation:**

```javascript
// Load Monaco from CDN or bundle
require(["vs/editor/editor.main"], function () {
  const editor = monaco.editor.create(
    document.getElementById("monaco-container"),
    {
      value: "",
      language: "markdown",
      theme: "vs-dark",
      minimap: { enabled: false },
      lineNumbers: "on",
      wordWrap: "on",
      scrollBeyondLastLine: false,
    }
  );

  // Register custom completion provider
  monaco.languages.registerCompletionItemProvider("markdown", {
    triggerCharacters: ["@", "#"],
    provideCompletionItems: (model, position) => {
      // Request from extension host, return Monaco completion format
    },
  });
});
```

## Testing Plan

1. **Manual Testing:**
   - Type @ and verify file completions appear
   - Type # and verify selection completions appear
   - Arrow keys navigate dropdown
   - Enter/Tab insert completion
   - Escape dismisses dropdown
   - Ctrl+Click opens links
   - Spell check shows red squiggly lines
   - Metadata updates (char/word count)

2. **Edge Cases:**
   - Empty editor
   - Very long file lists (>1000 files)
   - Rapid typing (debouncing)
   - Cursor positioning after completion
   - Multiple @ or # in same line
   - Link detection with special characters

3. **Integration Testing:**
   - Save draft creates `.prompt.md` file
   - Load file populates editor
   - Tab switching preserves content
   - Extension host message handling

## Recommendation

**Start with contenteditable + custom JavaScript** (Phases 1-5). This matches how Copilot Chat, Claude, and Codex work.

Only upgrade to Monaco if:

- Users request advanced features (find/replace, minimap)
- Performance issues with large prompts (>10K chars)
- Need syntax highlighting for code blocks

The contenteditable approach is simpler, lighter, and sufficient for 95% of use cases.om extension host

## Disadvantages

❌ **More code to maintain** - Custom completion logic vs. native API
❌ **Different UX** - Not identical to VS Code completions (but close enough)
❌ **Browser spell check** - Not Code Spell Checker (different dictionary)

## Recommendation

**Use Custom JavaScript Completions** for in-panel prompt editing:

1. Replace textarea with `contenteditable` div
2. Implement custom completion dropdown (triggered by @, #)
3. Use browser spell check (spellcheck="true")
4. Add Ctrl+Click link handlers with CSS styling
5. Keep extension host logic (reuse PromptCompletionProvider data sources)

This is exactly what Copilot Chat, Claude, and Codex do - and it works well!
