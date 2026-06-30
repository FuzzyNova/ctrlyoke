# ctrlyoke Webview Migration Map

**From**: Vanilla JS modules (`src/ui/webview/`)  
**To**: React 19 + TypeScript (`src/ui/webview-react/`)

This document maps each vanilla JS module to its equivalent React component(s), hooks, and stores.

---

## Core Architecture Mapping

### State Management

| Old (Vanilla JS)           | New (React)               | Notes                                         |
| -------------------------- | ------------------------- | --------------------------------------------- |
| `state-manager.js`         | `store/workflowStore.ts`  | Workflow state (fileName, prompts, execution) |
| `state-manager.js`         | `store/uiStore.ts`        | UI state (layout, collapsed sections)         |
| `state-manager.js`         | `store/editorStore.ts`    | Editor state (selected prompt, mode)          |
| `state-manager.js`         | `store/settingsStore.ts`  | Settings state (provider, model, defaults)    |
| Imperative state mutations | Zustand immutable updates | State updates via `set()` actions             |

**Migration Notes**:

- Old: Single object with nested properties, direct mutations
- New: Multiple stores by domain, immutable updates
- Old: `getState()`, `updateState()`
- New: `useWorkflowStore()`, `useUiStore()`, etc.

---

### Message Handling

| Old (Vanilla JS)                     | New (React)                   | Notes                          |
| ------------------------------------ | ----------------------------- | ------------------------------ |
| `message-router.js`                  | `hooks/useMessageHandler.ts`  | Central message routing        |
| `messageCommandMap` object           | Handler functions in hook     | Command → handler mapping      |
| `window.addEventListener('message')` | `useEffect` with API listener | Message subscription           |
| Direct function calls                | Store updates                 | Handlers update Zustand stores |

**Migration Flow**:

**Old**:

```javascript
// message-router.js
messageCommandMap = {
  [MESSAGE_TYPES.FILE_SELECTED]: handleFileSelected,
  // ...
};

function handleFileSelected(payload) {
  stateManager.updateState({ fileName: payload.fileName });
  renderAll();
}
```

**New**:

```typescript
// hooks/useMessageHandler.ts
useEffect(() => {
  const handler = (message: IncomingMessage) => {
    switch (message.type) {
      case MESSAGE_TYPES.FILE_SELECTED:
        workflowStore.setState({ fileName: message.fileName });
        break;
    }
  };
  api.onMessage(handler);
}, []);
```

---

## Module → Component/Hook Mapping

### 1. dashboard.js → App.tsx + Multiple Components

**Old File**: `dashboard.js` (339 lines - orchestrator)

**New Files**:

- `App.tsx` - Main app layout
- `components/layout/Header.tsx` - Header component
- `components/layout/PromptsPanel.tsx` - Left panel
- `components/layout/OutputSection.tsx` - Output panel
- `components/layout/EditorSection.tsx` - Editor panel
- `hooks/useMessageHandler.ts` - Message routing

**Responsibilities**:

| Old Function              | New Location                   | Type                    |
| ------------------------- | ------------------------------ | ----------------------- |
| `init()`                  | `App.tsx` useEffect            | Hook                    |
| Global event listeners    | Individual components          | Event handlers          |
| DOM elements object       | React refs + state             | N/A (React manages DOM) |
| Layout toggle handlers    | `components/layout/Header.tsx` | Component               |
| Section collapse handlers | Individual section components  | Component state         |

**Key Differences**:

- Old: Single IIFE module, imperative DOM manipulation
- New: Component tree, declarative rendering
- Old: Global elements object (`elements.btnRun`)
- New: Component-scoped refs (`const btnRef = useRef()`)

---

### 2. editor-manager.js → Editor Components + Store

**Old File**: `editor-manager.js` (1032 lines)

**New Files**:

- `components/editor/PromptEditor.tsx` - Main editor wrapper
- `components/editor/CodeMirrorEditor.tsx` - CodeMirror integration
- `components/editor/PropertiesDrawer.tsx` - Properties slide-up panel
- `components/editor/EditorFooter.tsx` - Footer controls
- `store/editorStore.ts` - Editor state management

**Function Mapping**:

| Old Function                         | New Location                         | Type                 |
| ------------------------------------ | ------------------------------------ | -------------------- |
| `initializeEditor()`                 | `CodeMirrorEditor.tsx` useEffect     | Component hook       |
| `setupEventListeners()`              | Individual components                | Event handlers       |
| `togglePropertiesDrawer()`           | `PropertiesDrawer.tsx` state         | Component state      |
| `saveEditorState()`                  | `editorStore.ts` persist middleware  | Store middleware     |
| `restoreEditorState()`               | `editorStore.ts` hydration           | Store initialization |
| `updateEditorMetadata()`             | `EditorFooter.tsx` computed values   | Component            |
| `getPropertyValues()`                | `PropertiesDrawer.tsx` form state    | Component state      |
| `resetPropertyControls()`            | `PropertiesDrawer.tsx` reset handler | Component function   |
| `updatePropertyModelDropdown()`      | `PropertiesDrawer.tsx` useEffect     | Component hook       |
| `setPropertyControls()`              | `PropertiesDrawer.tsx` props         | Component props      |
| `updateEditorMode()`                 | `PromptEditor.tsx` derived state     | Component            |
| `hasPendingPrompts()`                | `workflowStore.ts` selector          | Store selector       |
| `updateEditorButtons()`              | `EditorFooter.tsx` derived props     | Component            |
| `executePrompt()`                    | `EditorFooter.tsx` handler           | Component function   |
| `updateExistingPrompt()`             | `EditorFooter.tsx` handler           | Component function   |
| `cancelEdit()`                       | `PromptEditor.tsx` handler           | Component function   |
| `deletePrompt()`                     | `PromptEditor.tsx` handler           | Component function   |
| `selectPromptForEdit()`              | `editorStore.ts` action              | Store action         |
| `handleMessageCompletionsResponse()` | `CodeMirrorEditor.tsx`               | Component function   |
| `toggleEditorSection()`              | `EditorSection.tsx` state            | Component state      |
| `restoreEditorCollapseState()`       | `uiStore.ts` persist                 | Store persistence    |
| `refreshModelDropdown()`             | `PropertiesDrawer.tsx` useEffect     | Component hook       |

**CodeMirror Integration**:

| Old                                          | New                              |
| -------------------------------------------- | -------------------------------- |
| `window.CodeMirrorPromptEditor` global class | `CodeMirrorEditor.tsx` component |
| Manual initialization with URIs              | React component with props       |
| Callback-based change handling               | onChange prop                    |
| Global editor instance                       | Component-scoped ref             |

---

### 3. prompts-manager.js → Prompts Components

**Old File**: `prompts-manager.js` (364 lines)

**New Files**:

- `components/prompts/PromptItem.tsx` - Individual prompt
- `components/prompts/StatusIcon.tsx` - Status indicator
- `components/prompts/PromptCounter.tsx` - Counter display
- `components/layout/PromptsPanel.tsx` - Container

**Function Mapping**:

| Old Function                    | New Location                  | Type              |
| ------------------------------- | ----------------------------- | ----------------- |
| `renderPromptsList()`           | `PromptsPanel.tsx` map/render | Component JSX     |
| `createPromptItem()`            | `PromptItem.tsx`              | Component         |
| `getStatusIcon()`               | `StatusIcon.tsx`              | Component         |
| `updatePromptCounter()`         | `PromptCounter.tsx`           | Component         |
| `togglePromptsSection()`        | `PromptsPanel.tsx` state      | Component state   |
| `restorePromptsCollapseState()` | `uiStore.ts` persist          | Store persistence |

**Rendering Pattern**:

**Old**:

```javascript
function renderPromptsList() {
  const html = prompts
    .map((prompt, index) => {
      return createPromptItem(prompt, index);
    })
    .join("");
  elements.promptsList.innerHTML = html;
}
```

**New**:

```tsx
function PromptsPanel() {
  const steps = useWorkflowStore((state) => state.prompts);
  return (
    <div>
      {prompts.map((prompt, index) => (
        <PromptItem key={index} prompt={prompt} index={index} />
      ))}
    </div>
  );
}
```

---

### 4. output-manager.js → Output Components

**Old File**: `output-manager.js` (530 lines)

**New Files**:

- `components/output/CliOutput.tsx` - CLI output container
- `components/output/ToolCallOutput.tsx` - Tool call rendering
- `components/output/BashOutput.tsx` - Bash command output
- `components/output/StatusMessage.tsx` - Status messages
- `components/layout/OutputSection.tsx` - Container
- `utils/diff.ts` - Diff rendering utilities

**Function Mapping**:

| Old Function                   | New Location                              | Type                |
| ------------------------------ | ----------------------------------------- | ------------------- |
| `renderAllCliOutputs()`        | `OutputSection.tsx` map/render            | Component JSX       |
| `renderCliOutput()`            | `CliOutput.tsx`                           | Component           |
| `renderToolCall()`             | `ToolCallOutput.tsx`                      | Component           |
| `renderToolDiff()`             | `ToolCallOutput.tsx` with `utils/diff.ts` | Component + utility |
| `renderStatusMessage()`        | `StatusMessage.tsx`                       | Component           |
| `handleCliStreamingChunk()`    | Store action + component                  | Real-time update    |
| `generateMarkdownOutput()`     | `utils/export.ts`                         | Utility function    |
| `handleExportOutput()`         | `OutputSection.tsx` handler               | Component function  |
| `toggleOutputSection()`        | `OutputSection.tsx` state                 | Component state     |
| `restoreOutputCollapseState()` | `uiStore.ts` persist                      | Store persistence   |

**Streaming Pattern**:

**Old**:

```javascript
function handleCliStreamingChunk(stepIndex, chunk) {
  const output = state.cliOutputs[stepIndex];
  output.response += chunk;
  if (stepIndex === state.currentStep - 1) {
    renderCliOutput(stepIndex);
  }
}
```

**New**:

```typescript
// In useMessageHandler
case MESSAGE_TYPES.CLI_STREAMING_CHUNK:
  workflowStore.appendStreamChunk(message.stepIndex, message.chunk);
  break;

// CliOutput.tsx auto-rerenders via subscription
function CliOutput({ stepIndex }: Props) {
  const output = useWorkflowStore(
    state => state.cliOutputs[stepIndex]
  );
  return <div>{output.response}</div>;
}
```

---

### 5. workflow-manager.js → Workflow Components

**Old File**: `workflow-manager.js` (688 lines)

**New Files**:

- `components/workflow/WorkflowControls.tsx` - Control buttons
- `components/workflow/WorkflowStatus.tsx` - Status display
- `components/workflow/TemplateModal.tsx` - Template modal
- `components/workflow/RecentWorkflows.tsx` - Workflow switcher
- `components/shared/SplitButton.tsx` - Reusable split button

**Function Mapping**:

| Old Function                 | New Location                       | Type               |
| ---------------------------- | ---------------------------------- | ------------------ |
| `initNewWorkflow()`          | `WorkflowControls.tsx` handler     | Component function |
| `showTemplateModal()`        | `TemplateModal.tsx` state          | Component state    |
| `populateTemplateDropdown()` | `TemplateModal.tsx` select options | Component JSX      |
| `handleTemplateSelected()`   | `TemplateModal.tsx` handler        | Component function |
| `renderWorkflowStatus()`     | `WorkflowStatus.tsx`               | Component          |
| `updateWorkflowDisplay()`    | `WorkflowStatus.tsx` props         | Component props    |
| `showWorkflowDropdown()`     | `RecentWorkflows.tsx` state        | Component state    |
| `renderWorkflowMenu()`       | `RecentWorkflows.tsx`              | Component          |
| Split button logic           | `SplitButton.tsx` reusable         | Shared component   |

---

### 6. utilities.js → utils/ Directory

**Old File**: `utilities.js` (233 lines - pure functions)

**New Files**:

- `utils/time.ts` - Time formatting
- `utils/string.ts` - String utilities
- `utils/endConditions.ts` - End condition helpers
- `utils/prompts.ts` - Prompt utilities
- `utils/tokenizer.ts` - Token counting (imported)

**Function Mapping**:

| Old Function                      | New File                            | Notes           |
| --------------------------------- | ----------------------------------- | --------------- |
| `getTimestamp()`                  | `utils/time.ts`                     | Pure function   |
| `formatTime()`                    | `utils/time.ts`                     | Pure function   |
| `escapeHtml()`                    | `utils/string.ts`                   | Pure function   |
| `truncate()`                      | `utils/string.ts`                   | Pure function   |
| `getWorkflowName()`               | `utils/string.ts`                   | Pure function   |
| `getEndConditionValue()`          | `utils/endConditions.ts`            | Pure function   |
| `buildEndConditionFromControls()` | `utils/endConditions.ts`            | Pure function   |
| `setEndConditionControls()`       | `utils/endConditions.ts`            | Pure function   |
| `createPromptItem()`              | `components/prompts/PromptItem.tsx` | Now a component |
| `getStatusIcon()`                 | `components/prompts/StatusIcon.tsx` | Now a component |

**Migration Pattern**:

- Pure utility functions → Keep as utilities
- DOM-generating functions → Convert to React components
- State-dependent functions → Move to components or stores

---

## Shared Components

### New Reusable Components (No Old Equivalent)

| Component                           | Purpose                     |
| ----------------------------------- | --------------------------- |
| `components/shared/Button.tsx`      | Styled button with variants |
| `components/shared/Modal.tsx`       | Reusable modal dialog       |
| `components/shared/SplitButton.tsx` | Split button with dropdown  |
| `components/shared/Collapsible.tsx` | Collapsible section wrapper |

These consolidate repeated patterns from the old code:

- Old: Inline button HTML in multiple files
- New: Single `<Button>` component with variants

---

## HTML → JSX Mapping

### dashboard.html → App.tsx + Components

| Old HTML Element                     | New React Component             |
| ------------------------------------ | ------------------------------- |
| `<div id="app">`                     | `<App />`                       |
| `<div id="header">`                  | `<Header />`                    |
| `<div id="action-buttons">`          | `<WorkflowControls />`          |
| `<div id="workflow-status">`         | `<WorkflowStatus />`            |
| `<div id="controls">`                | `<Header />` control buttons    |
| `<div id="main-content">`            | `<App />` main layout           |
| `<div id="prompts-section">`         | `<PromptsPanel />`              |
| `<div id="prompts-list">`            | `<PromptsPanel />` children     |
| `<div class="prompt-item">`          | `<PromptItem />`                |
| `<div id="output-editor-container">` | `<App />` right side            |
| `<div id="output-section">`          | `<OutputSection />`             |
| `<div id="output-content">`          | `<OutputSection />` children    |
| `<div class="cli-output-item">`      | `<CliOutput />`                 |
| `<div id="editor-section">`          | `<EditorSection />`             |
| `<div class="prompt-editor">`        | `<CodeMirrorEditor />`          |
| `<div class="properties-drawer">`    | `<PropertiesDrawer />`          |
| `<div id="new-workflow-modal">`      | `<TemplateModal />`             |
| `<div id="confirmation-modal">`      | `<Modal />` with custom content |

---

## CSS/SCSS Migration

### dashboard.scss → Tailwind CSS + CSS Modules

| Old Approach                     | New Approach                             |
| -------------------------------- | ---------------------------------------- |
| `dashboard.scss` (1800 lines)    | Tailwind utility classes                 |
| `shared.scss` (shared variables) | Tailwind config `theme.extend`           |
| Global CSS classes               | Component-scoped styles                  |
| `.btn-primary`                   | `className="btn-primary"` (custom class) |
| `.prompt-item`                   | `PromptItem.module.css` (if needed)      |
| VS Code CSS variables            | Same (inherited)                         |

**Migration Strategy**:

1. **Phase 1**: Import compiled `dashboard.css` to get old styles working
2. **Phase 2**: Convert layout/spacing to Tailwind utilities
3. **Phase 3**: Convert component styles to CSS modules or styled-components
4. **Phase 4**: Remove old CSS entirely

**Quick Fix** (recommended for now):

```typescript
// App.tsx or main.tsx
import "../../../webview/dashboard.css"; // Use old compiled CSS temporarily
```

---

## Data Flow Comparison

### Old (Imperative)

```
Extension → window.postMessage
         ↓
message-router.js → messageCommandMap
         ↓
state-manager.js → updateState (mutation)
         ↓
render functions → innerHTML updates
```

### New (Reactive)

```
Extension → vscodeApi.postMessage
         ↓
useMessageHandler → switch/case
         ↓
Zustand store → setState (immutable)
         ↓
Component subscriptions → automatic re-render
```

---

## Migration Checklist by File

### ✅ Completed (Infrastructure)

- [x] VS Code API integration (`useVsCodeApi`)
- [x] Message handler hook structure
- [x] Zustand stores structure
- [x] Component file structure
- [x] Tailwind configuration
- [x] Build setup (Vite)

### ❌ TODO (Implementation)

#### High Priority

- [ ] **Uncomment CSS imports** in `styles/globals.css`
  - Codicons CSS
  - Custom icons CSS
- [ ] **Wire up message handlers** in `useMessageHandler.ts`
  - `init` → Initialize stores
  - `fileSelected` → Update workflow store
  - `executionStateChanged` → Update execution state
  - `promptsExtended` → Add prompts
  - `progressUpdate` → Update progress
  - `sessionRestored` → Restore session
  - All 17 message types from old message-router

- [ ] **Implement Header component**
  - Split button (New Workflow dropdown)
  - Workflow status split button
  - Execution state badge
  - Control buttons (play/pause/stop)
  - Layout toggle

- [ ] **Implement PromptsPanel**
  - Render prompt items from store
  - Status icons (from `StatusIcon.tsx`)
  - Click handlers for editing
  - Counter display

- [ ] **Implement OutputSection**
  - CLI output rendering
  - Tool call output
  - Diff visualization
  - Status messages
  - Auto-scroll

- [ ] **Implement EditorSection**
  - CodeMirror integration
  - Properties drawer
  - CRUD operations
  - Metadata (token count)

#### Medium Priority

- [ ] **TemplateModal** component
  - Template selection
  - Variable inputs
  - File name generation

- [ ] **WorkflowStatus** component
  - Workflow name display
  - Workflow switcher dropdown
  - Recent workflows

- [ ] **PropertiesDrawer** component
  - Property form controls
  - End condition section
  - Session management

#### Low Priority

- [ ] Keyboard shortcuts
- [ ] Animations
- [ ] Accessibility improvements
- [ ] Performance optimization

---

## Quick Reference: Where to Find Things

### Looking for old functionality?

| I want to...                  | Check this new location                  |
| ----------------------------- | ---------------------------------------- |
| **Update workflow state**     | `store/workflowStore.ts`                 |
| **Handle extension messages** | `hooks/useMessageHandler.ts`             |
| **Render prompts list**       | `components/layout/PromptsPanel.tsx`     |
| **Show CLI output**           | `components/output/CliOutput.tsx`        |
| **Edit a prompt**             | `components/editor/PromptEditor.tsx`     |
| **Toggle properties**         | `components/editor/PropertiesDrawer.tsx` |
| **Show modal**                | `components/shared/Modal.tsx`            |
| **Format time**               | `utils/time.ts`                          |
| **Calculate tokens**          | `utils/tokenizer.ts`                     |
| **Handle CodeMirror**         | `components/editor/CodeMirrorEditor.tsx` |

### Looking for old files?

| Old File              | New Equivalent                                                |
| --------------------- | ------------------------------------------------------------- |
| `dashboard.js`        | `App.tsx` + multiple components                               |
| `editor-manager.js`   | `components/editor/*` + `store/editorStore.ts`                |
| `prompts-manager.js`  | `components/prompts/*` + `components/layout/PromptsPanel.tsx` |
| `output-manager.js`   | `components/output/*` + `components/layout/OutputSection.tsx` |
| `workflow-manager.js` | `components/workflow/*`                                       |
| `state-manager.js`    | `store/*` (4 separate stores)                                 |
| `message-router.js`   | `hooks/useMessageHandler.ts`                                  |
| `utilities.js`        | `utils/*` (split by domain)                                   |

---

## Next Steps

1. **Immediate** (make dashboard functional):
   - Uncomment CSS imports
   - Wire up message handlers to stores
   - Verify state updates work

2. **Short-term** (basic functionality):
   - Implement Header with basic controls
   - Implement PromptsPanel with prompt items
   - Implement OutputSection with CLI output
   - Implement EditorSection with CodeMirror

3. **Long-term** (feature parity):
   - All modals and dropdowns
   - All animations and transitions
   - Full keyboard navigation
   - Complete accessibility

---

**Last Updated**: February 3, 2026  
**Migration Progress**: ~15% (infrastructure complete, implementation pending)
