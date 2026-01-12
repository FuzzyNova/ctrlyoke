# Dashboard.js Modularization Plan

**Date**: January 11, 2026  
**Author**: Nathan  
**Status**: ✅ **IMPLEMENTED** (January 2026)  
**Problem**: dashboard.js was ~3,017 lines and exceeded 25,000 tokens, making it difficult to maintain and too large for Claude's per-file context window.

---

## Implementation Results

The refactoring has been successfully completed. The original 3,017-line monolith was split into 8 modules:

| Module              | Planned | Actual      |
| ------------------- | ------- | ----------- |
| dashboard.js        | ~300    | 350 lines   |
| state-manager.js    | ~200    | 415 lines   |
| utilities.js        | ~150    | 217 lines   |
| workflow-manager.js | ~400    | 1,060 lines |
| prompts-manager.js  | ~400    | 381 lines   |
| output-manager.js   | ~400    | 516 lines   |
| editor-manager.js   | ~900    | 1,125 lines |
| message-router.js   | ~500    | 501 lines   |

**Total**: ~4,565 lines (vs original ~3,017) - Additional lines from improved documentation, error handling, and explicit interfaces.

---

## ⚠️ CRITICAL: This is a Pure Refactor

**ZERO FUNCTIONAL CHANGES ALLOWED**

This refactor is **purely structural** - moving code into modules for maintainability. Every user-facing feature, behavior, and interaction MUST work identically after the refactor.

### What Changes

- ✅ Code organization (monolith → modules)
- ✅ Internal architecture (state encapsulation, dependency injection)
- ✅ Code patterns (registry, callbacks, immutable state)

### What Does NOT Change

- ❌ User interface (no visual changes)
- ❌ User interactions (no behavior changes)
- ❌ Features (no additions, no removals)
- ❌ Performance characteristics (no optimizations)
- ❌ Message protocol (extension ↔ webview)
- ❌ State structure (same properties, same data)
- ❌ Event handling (same triggers, same responses)

### Success Definition

**"User cannot tell the difference"** - If a user ran the extension before and after the refactor, they should notice absolutely nothing different except potentially faster development of future features.

### Testing Requirement

Every manual test workflow in `manual-test/` must produce **identical results** before and after refactor. Byte-for-byte identical would be ideal, but functionally identical is required.

---

## Current State Analysis

### File Statistics

- **Total Lines**: 3,017 lines
- **Estimated Tokens**: ~30,000+ tokens (exceeds 25k limit)
- **Sections** (based on comment markers):
  1. State management (lines 1-160)
  2. Utility helpers (lines 164-358)
  3. Split button functions (lines 359-547)
  4. Event listeners (lines 548-748)
  5. Keyboard shortcuts (lines 749-782)
  6. Message handlers (lines 783-1333)
  7. Rendering functions (lines 1334-1717)
  8. Modal functions (lines 1718-1969)
  9. Properties drawer (lines 1970-1998)
  10. Section collapse (lines 1999-2089)
  11. Layout toggles (lines 2090-2189)
  12. Editor state management (lines 2190-2295)
  13. Prompt editor integration (lines 2296-2993)
  14. Initialization (lines 2994-3017)

### Current Dependencies

- **External modules** (already separated):
  - `CodeMirrorPromptEditor` (codemirror-editor.js)
  - `DashboardConstants` (compiled from TypeScript)
  - `gpt-tokenizer` (tokenizer bundle)
- **VS Code API**: `acquireVsCodeApi()` (called once, cached)
- **State sharing**: Heavy interdependence between sections

---

## Refactoring Strategy: Hybrid Approach

**Recommendation**: Split by **feature ownership** (who controls the UI + state for each visible section) combined with **shared utilities**. This aligns with Single Responsibility Principle and creates clear module boundaries.

### Why Not Pure UI Sections?

- **Too much coupling**: Prompts list, output, and editor all share state and message handling
- **Circular dependencies**: Would create import cycles
- **Loss of cohesion**: Split button logic is tightly coupled to workflow state

### Why Not Pure Responsibilities?

- **Too granular**: Would create 10+ tiny modules with complex imports
- **State management hell**: Shared state would need to be passed everywhere
- **Harder to reason about**: UI components would be scattered across files

---

## Proposed Module Architecture

### Module Breakdown (7 modules + main orchestrator)

```
dashboard.js (main orchestrator - 350 lines)
├── state-manager.js (415 lines)
├── utilities.js (217 lines)
├── workflow-manager.js (1,060 lines)
├── prompts-manager.js (381 lines)
├── output-manager.js (516 lines)
├── editor-manager.js (1,125 lines)
└── message-router.js (501 lines)
```

### 1. **state-manager.js** (Centralized State)

**Lines**: 415  
**Responsibility**: State object management, persistence, restoration

**Exports**:

```javascript
// State access (immutable by default - returns copies)
getState(); // Returns copy of full state
updateState(updates); // Merge updates into state
getEditorState(); // Returns copy of editor state
updateEditorState(updates); // Merge updates into editor state
getModalState(); // Returns copy of modal state
updateModalState(updates); // Merge updates into modal state

// Model options (dynamic from ModelRegistry)
getModelOptions();
setModelOptions(options);

// State persistence
saveEditorState();
restoreEditorState();

// State queries (computed properties)
hasPendingPrompts();
getCurrentPrompt();
getPromptByIndex(index);
getExecutionState();
isWorkflowRunning();
```

**Why separate?**

- **Single Responsibility**: Only manages state (no UI logic)
- **Encapsulation**: Prevents direct mutations (DRY - single place to update state)
- **Open/Closed**: Easy to add reactive state (Vue/React) without changing consumers
- **Testability**: State logic can be tested independently

---

### 2. **utilities.js** (Pure Helper Functions)

**Lines**: 217  
**Responsibility**: Pure utility functions with no side effects

**Exports**:

```javascript
// Time utilities
getTimestamp();
formatTime(timestampMs);

// String utilities
escapeHtml(text);
truncate(str, maxLen);
getWorkflowName(filePath);

// End condition utilities
getEndConditionValue(endCondition, property, defaultValue);
buildEndConditionFromControls();
setEndConditionControls(endCondition);

// Prompt item factory
createPromptItem(prompt, index, status, details);

// DOM utilities
getStatusIcon(status);
```

**Why separate?**

- Pure functions, easy to test
- No dependencies on state or DOM
- Reusable across all modules

---

### 3. **workflow-manager.js** (New Workflow Modal + Split Button)

**Lines**: 1,060  
**Responsibility**: Workflow creation, template selection, file loading

**Exports**:

```javascript
// Initialization
initWorkflowManager(vscode, elements, stateManager);

// Split button actions
handleNewWorkflowAction();
handleLoadFileAction();
toggleWorkflowDropdown();
updateNewWorkflowButtonState();

// Modal management
handleOpenNewWorkflowModal(message);
populateTemplateDropdown();
updateTemplateUI(template);
submitWorkflow(runAfter);
closeModal();

// Message handlers
handleTemplateInfo(message);
handleDefaultTemplateSet(message);
handleWorkflowCreated(message);

// Status updates
updateWorkflowStatus(filePath, executionState);
```

**Extracted from**:

- Split button functions (lines 359-547)
- Modal functions (lines 1718-1969)
- Workflow status updates

**Why group these?**

- Both relate to workflow lifecycle (creation, loading)
- Share modal state
- Split button is the entry point to modal

---

### 4. **prompts-manager.js** (Prompts List UI)

**Lines**: 381  
**Responsibility**: Prompts list rendering, selection, status updates

**Exports**:

```javascript
// Initialization
initPromptsManager(vscode, elements, stateManager, callbacks);

// Rendering
renderPromptsList();
updatePromptCounter();

// Event handlers
handlePromptClick(index);
handlePromptStatusChange(stepIndex, status, details);
handleRetryAttemptChange(stepIndex, currentRetry, maxRetries);

// Message handlers
handleFileSelected(fileName, prompts);
handleSessionRestored(fileName, prompts, results, executionState, currentIndex);
handlePromptsExtended(prompts);
handlePromptDeleted(fileName, prompts);

// Section collapse
togglePromptsSection();
restorePromptsCollapseState();
```

**Callbacks** (passed during init to avoid direct dependencies):

```javascript
{
  onPromptSelect: (index) => editorManager.selectPromptForEdit(index);
}
```

**Extracted from**:

- Rendering functions (renderPromptsList, updatePromptCounter)
- Message handlers (file selected, session restored, prompts extended/deleted)
- Section collapse logic for prompts

**Why separate?**

- **Single Responsibility**: Only manages prompts list UI
- **Dependency Inversion**: Uses callbacks instead of importing editor-manager
- **Interface Segregation**: Only receives needed DOM elements and state methods
- **Open/Closed**: Can add filtering/search without changing other modules

---

### 5. **output-manager.js** (CLI Output Display + Export)

**Lines**: 516  
**Responsibility**: CLI output rendering, streaming, export

**Exports**:

```javascript
// Initialization
initOutputManager(vscode, elements, stateManager);

// Rendering
renderAllCliOutputs();
renderCliOutput(stepIndex);
updateStreamingOutput(stepIndex);

// Message handlers
handleCliOutput(stepIndex, output);
handleCliStreamingChunk(stepIndex, chunk);
handleStatusMessage(messageData);

// Export
generateMarkdownOutput();
handleExportOutput();

// Section collapse
toggleOutputSection();
restoreOutputCollapseState();

// Autoscroll
setupAutoscroll();
```

**Extracted from**:

- CLI output rendering (lines ~1400-1700)
- Streaming logic
- Export functionality
- Section collapse for output

**Why separate?**

- Clear ownership of output panel
- Heavy rendering logic isolated
- Export is feature-complete in one place

---

### 6. **editor-manager.js** (Prompt Editor + Properties Drawer)

**Lines**: 1,125 (largest module, but cohesive)  
**Responsibility**: CodeMirror editor, properties drawer, prompt CRUD

**Exports**:

```javascript
// Initialization
initEditorManager(vscode, elements, stateManager, affUri, dicUri);

// Editor instance access
getEditor();

// Editor mode
updateEditorMode();
updateEditorMetadata();
switchToNewPromptMode();
selectPromptForEdit(index);
cancelEdit();

// CRUD operations
executePromptAction(actionType);
updatePrompt();
deletePrompt();

// Properties drawer
togglePropertiesDrawer();
openPropertiesDrawer();
closePropertiesDrawer();
populatePropertyControls(prompt);
getPropertyValues();
resetPropertyControls();
setPropertyControls(prompt);

// Model dropdown
updatePropertyModelDropdown(provider);

// Token counting
updateTokenCount();

// Completions
handleCompletionRequest(trigger, prefix, position);
handleCompletionResponse(items, from);

// Section collapse
toggleEditorSection();
restoreEditorCollapseState();

// Confirmation modal
showConfirmModal(title, message, onConfirm);
```

**Extracted from**:

- Editor state management (lines 2190-2295)
- Prompt editor integration (lines 2296-2993)
- Properties drawer (lines 1970-1998)
- Section collapse for editor
- Confirmation modal (shared utility)

**Why this is the largest module?**

- Editor has many responsibilities (text editing, properties, completions, CRUD)
- All logically related to "editing a prompt"
- Still under 1000 lines (maintainable)
- Could be further split if needed (e.g., properties-drawer.js)

---

### 7. **message-router.js** (Message Handling + Orchestration)

**Lines**: 501  
**Responsibility**: Route messages to appropriate managers, coordinate updates

**Exports**:

```javascript
// Initialization
initMessageRouter(vscode, stateManager, managers);

// Message routing (registry pattern - DRY)
registerHandler(messageType, handler);
handleMessage(event);

// Global handlers (not owned by a specific manager)
handleInit(data);
handleModelOptionsUpdate(data);
handleExecutionStarted(fileName, totalSteps);
handleExecutionStateChanged(executionState);
handleProgressUpdate(current, total);
handleExecutionCompleted();

// Rendering orchestration
renderAll();
renderExecutionState();
updateAllControls();
```

**Handler Registration Pattern** (DRY - eliminates switch statement):

```javascript
// Each manager registers its handlers during init
promptsManager.registerHandlers({
  [MESSAGE_TYPES.FILE_SELECTED]: (data) => handleFileSelected(data),
  [MESSAGE_TYPES.PROMPTS_EXTENDED]: (data) => handlePromptsExtended(data),
});

// Message router dispatches automatically
const handler = handlerRegistry[messageType];
if (handler) handler(data);
```

**Extracted from**:

- Main message handler (lines 807-911)
- Execution state handlers
- Global rendering orchestration

**Why separate?**

- **Single Responsibility**: Only routes messages and coordinates rendering
- **Open/Closed**: New message types don't require modifying router code
- **Dependency Inversion**: Managers register handlers (inversion of control)
- **DRY**: Registry pattern eliminates repetitive switch/case blocks

---

### 8. **dashboard.js** (Main Orchestrator)

**Lines**: 350  
**Responsibility**: Initialize all modules, set up event listeners, coordinate

**Structure**:

```javascript
(function () {
  // Acquire VS Code API (once)
  const vscode = acquireVsCodeApi();

  // Import all modules
  const stateManager = window.FlightPathStateManager;
  const utilities = window.FlightPathUtilities;
  const workflowManager = window.FlightPathWorkflowManager;
  const promptsManager = window.FlightPathPromptsManager;
  const outputManager = window.FlightPathOutputManager;
  const editorManager = window.FlightPathEditorManager;
  const messageRouter = window.FlightPathMessageRouter;

  // DOM elements object (DRY - single source of all element references)
  const elements = {
    // Workflow controls
    workflowName: document.getElementById("workflow-name"),
    btnNewWorkflowMain: document.getElementById("btn-new-workflow-main"),
    // ... other elements
  };

  // Initialize managers in dependency order
  stateManager.init();

  // Initialize feature managers (no interdependencies)
  workflowManager.init(vscode, elements, stateManager);
  outputManager.init(vscode, elements, stateManager);
  editorManager.init(vscode, elements, stateManager, affUri, dicUri);

  // Initialize prompts manager with callbacks (Dependency Inversion)
  promptsManager.init(vscode, elements, stateManager, {
    onPromptSelect: (index) => editorManager.selectPromptForEdit(index),
  });

  // Initialize message router with all managers
  messageRouter.init(vscode, stateManager, {
    workflowManager,
    promptsManager,
    outputManager,
    editorManager,
  });

  // Set up global event listeners (layout toggles, keyboard shortcuts)
  setupGlobalEventListeners();

  // Restore UI state from localStorage
  restoreUIState();

  // Signal ready to extension
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
```

**Why keep this small?**

- **Clear initialization sequence**: Dependency order is explicit
- **Minimal logic**: Just wiring, no business logic
- **Single place to see architecture**: All module relationships visible
- **Easy to maintain**: Adding new managers is straightforward

---

## Module Dependency Graph

```
dashboard.js (orchestrator)
    ├── state-manager.js (no deps)
    ├── utilities.js (no deps)
    ├── workflow-manager.js
    │       └── depends on: state-manager, utilities
    ├── prompts-manager.js
    │       └── depends on: state-manager, utilities
    ├── output-manager.js
    │       └── depends on: state-manager, utilities
    ├── editor-manager.js
    │       └── depends on: state-manager, utilities
    └── message-router.js
            └── depends on: all managers, state-manager
```

**Key principles**:

- **No circular dependencies**: Managers are fully independent, communication via message-router or callbacks
- **Shared state**: State-manager provides encapsulated access (no direct mutations)
- **Utilities are pure**: No dependencies, can be used anywhere
- **Message router coordinates**: Mediator pattern - managers register handlers, router dispatches
- **Dependency Inversion**: Managers depend on state-manager abstraction, not concrete state objects

---

## Implementation Strategy

### Phase 1: Extract Pure Utilities (Low Risk)

1. Create `utilities.js` with pure functions
2. Update `dashboard.js` to import from utilities
3. Test that all functionality still works
4. **Estimated effort**: 1-2 hours

### Phase 2: Extract State Manager (Medium Risk)

1. Create `state-manager.js` with state objects + immutable accessors
2. Replace direct state access in `dashboard.js` with `getState()/updateState()`
3. Add state persistence methods (localStorage integration)
4. Add computed properties (hasPendingPrompts, getCurrentPrompt, etc.)
5. Test state updates, persistence, and encapsulation
6. **Estimated effort**: 2-3 hours
7. **SOLID Focus**: Encapsulation, Single Responsibility, Open/Closed for reactive state

### Phase 3: Extract Feature Managers (High Risk)

1. **Output Manager** (easiest, least coupled)
   - Extract rendering and export logic
   - Wire up message handlers
   - Test CLI output display and export

2. **Workflow Manager** (moderate complexity)
   - Extract modal and split button
   - Test workflow creation and file loading

3. **Prompts Manager** (moderate complexity)
   - Extract list rendering
   - Test prompt selection and status updates

4. **Editor Manager** (most complex)
   - Extract CodeMirror integration
   - Extract properties drawer
   - Test editing, CRUD, completions

5. **Message Router** (coordination)
   - Extract message handling with registry pattern
   - Implement handler registration system (eliminates switch/case - DRY)
   - Wire up all managers
   - Test full message flow
   - **SOLID Focus**: Open/Closed (registry), Mediator pattern

6. **Estimated effort**: 6-8 hours (spread across multiple sessions)
7. **SOLID Focus per manager**:
   - Output: Interface Segregation (minimal dependencies)
   - Workflow: Single Responsibility (workflow lifecycle only)
   - Prompts: Dependency Inversion (callbacks not direct imports)
   - Editor: Could be split further if violating SRP (properties-drawer.js)
   - Router: Open/Closed (registry pattern)

### Phase 4: Cleanup and Testing (Zero-Regression Validation)

1. Remove unused code from `dashboard.js`
2. Add JSDoc comments to all module exports
3. **CRITICAL**: Run comprehensive regression testing
   - Execute ALL manual test workflows (before/after comparison)
   - Validate zero functional changes
   - Document any deviations (should be none)
4. Update `.github/instructions/webview.instructions.md`
5. **Estimated effort**: 2-3 hours
6. **Gate**: Cannot merge until 100% regression-free

**Total Estimated Effort**: 12-16 hours

---

## Alternative Approaches Considered

### ❌ Approach 1: Split by Pure UI Sections

```
prompts-list.js
cli-output.js
prompt-editor.js
workflow-modal.js
```

**Rejected because**:

- Too much state sharing (leads to coupling)
- Message handling scattered across files
- Circular dependency risk (prompts needs editor, editor needs prompts state)

### ❌ Approach 2: Split by Pure Responsibilities

```
state.js
renderers.js
event-handlers.js
message-handlers.js
utils.js
```

**Rejected because**:

- Too granular (10+ files)
- Related logic scattered (editor rendering in renderers.js, editor events in event-handlers.js)
- Harder to reason about features

### ✅ Approach 3: Hybrid (Recommended)

**Combines feature ownership with shared utilities**

- Each manager owns a cohesive feature (prompts, output, editor, workflow)
- Shared utilities for cross-cutting concerns
- State manager for centralized state
- Message router for coordination

**Advantages**:

- Clear ownership boundaries
- Easy to find code (editing prompts? → editor-manager.js)
- Minimal coupling (managers are independent)
- Scalable (can add more managers later)

---

## Migration Path for Existing Code

### Step-by-step extraction example (Output Manager)

**Before (dashboard.js)**:

```javascript
function renderAllCliOutputs() {
  // 150 lines of rendering logic
}

function handleCliOutput(stepIndex, output) {
  // Update state and render
}
```

**After (state-manager.js with encapsulation)**:

```javascript
(function () {
  // Private state (closure - prevents direct mutation)
  let state = {
    fileName: null,
    prompts: [],
    executionState: EXECUTION_STATES.IDLE,
    currentStep: 0,
    totalSteps: 0,
    cliOutputs: {},
    retryStates: {},
    statusMessages: {},
  };

  // Public API (immutable access - follows encapsulation)
  function getState() {
    // Return copy to prevent direct mutations (SOLID)
    return { ...state };
  }

  function updateState(updates) {
    // Single place to update state (DRY)
    state = { ...state, ...updates };
    // Could add logging, validation, or reactive updates here (Open/Closed)
  }

  function hasPendingPrompts() {
    // Computed property - encapsulates business logic
    return state.prompts.some((p) => p.status === STEP_STATUS.PENDING);
  }

  // Export public API
  window.FlightPathStateManager = {
    init: () => {
      /* Load from localStorage */
    },
    getState,
    updateState,
    hasPendingPrompts,
    getCurrentPrompt: () => state.prompts[state.currentStep],
    // ... other computed properties
  };
})();
```

**After (output-manager.js using state-manager)**:

```javascript
(function () {
  let vscode;
  let elements;
  let stateManager;

  function init(_vscode, _elements, _stateManager) {
    vscode = _vscode;
    elements = _elements;
    stateManager = _stateManager;
  }

  function renderAllCliOutputs() {
    const state = stateManager.getState(); // Immutable copy
    // Same rendering logic, but can't accidentally mutate state
  }

  function handleCliOutput(stepIndex, output) {
    // Update via state-manager (single source of truth - DRY)
    const state = stateManager.getState();
    state.cliOutputs[stepIndex] = [output];
    stateManager.updateState({ cliOutputs: state.cliOutputs });
    renderAllCliOutputs();
  }

  // Export public API
  window.FlightPathOutputManager = {
    init,
    renderAllCliOutputs,
    handleCliOutput,
    // ... other exports
  };
})();
```

**After (message-router.js with registry pattern)**:

```javascript
(function () {
  let handlerRegistry = {}; // Registry eliminates switch/case (DRY + Open/Closed)

  function registerHandler(messageType, handler) {
    if (!handlerRegistry[messageType]) {
      handlerRegistry[messageType] = [];
    }
    handlerRegistry[messageType].push(handler);
  }

  function handleMessage(event) {
    const { type, ...data } = event.data;

    // Dispatch to registered handlers (Open/Closed - no code changes needed)
    const handlers = handlerRegistry[type] || [];
    handlers.forEach((handler) => handler(data));
  }

  // Export
  window.FlightPathMessageRouter = {
    init: (vscode, stateManager, managers) => {
      // Managers register their handlers
      managers.outputManager.registerHandlers({
        [MESSAGE_TYPES.CLI_OUTPUT]: handleCliOutput,
        [MESSAGE_TYPES.CLI_STREAMING_CHUNK]: handleCliStreamingChunk,
      });

      // Set up main message listener
      window.addEventListener("message", handleMessage);
    },
    registerHandler,
    handleMessage,
  };
})();
```

**After (dashboard.js - minimal orchestration)**:

```javascript
// Initialize in dependency order (DIP - dependencies injected, not hardcoded)
stateManager.init();
outputManager.init(vscode, elements, stateManager);
promptsManager.init(vscode, elements, stateManager, {
  onPromptSelect: (index) => editorManager.selectPromptForEdit(index), // Callback (DIP)
});
messageRouter.init(vscode, stateManager, {
  outputManager,
  promptsManager /* ... */,
});
```

---

## Testing Strategy

### Per-Module Testing

1. **State Manager**: Test state get/set, persistence, restoration
2. **Utilities**: Test pure functions in isolation
3. **Workflow Manager**: Test modal open/close, template selection, file creation
4. **Prompts Manager**: Test list rendering, selection, status updates
5. **Output Manager**: Test output rendering, streaming, export
6. **Editor Manager**: Test CodeMirror integration, properties drawer, CRUD
7. **Message Router**: Test message dispatch to correct managers

### Integration Testing

1. Load workflow → verify all managers update
2. Execute workflow → verify prompts, output, editor sync
3. Edit prompt → verify editor and prompts list sync
4. Create workflow from template → verify modal and file loading
5. Session restore → verify all state restored correctly

### Regression Testing (Critical - Zero Tolerance)

**Before/After Comparison Required:**

1. Run ALL workflows in `manual-test/` directory BEFORE refactor
2. Document exact behavior (screenshots, output, timing)
3. Run SAME workflows AFTER refactor
4. Compare results - MUST be identical

**Test Coverage Required:**

- ✅ All existing manual test workflows in `manual-test/` produce identical results
- ✅ Zero UI regressions (layout, styles, interactions, animations)
- ✅ Zero performance regressions (rendering speed, memory usage, responsiveness)
- ✅ All keyboard shortcuts work identically
- ✅ All message types handled identically
- ✅ State persistence/restoration works identically
- ✅ CodeMirror editor behaves identically
- ✅ Properties drawer, modal, dropdowns all function identically

**Red Flags (Require Investigation):**

- 🚨 Any UI element shifts position
- 🚨 Any interaction requires different clicks/keys
- 🚨 Any message produces different behavior
- 🚨 Any state value changes unexpectedly
- 🚨 Any performance degradation
- 🚨 Any console errors that weren't there before

---

## Success Criteria

### Technical Goals

✅ **Token count**: Each module < 10,000 tokens (fits in Claude context)  
✅ **Line count**: Main dashboard.js < 500 lines  
✅ **Coupling**: No circular dependencies  
✅ **Cohesion**: Each module has single, clear responsibility  
✅ **Testability**: Pure functions extracted, modules can be tested independently

### Functional Goals

✅ **Zero regressions**: 100% identical functionality - not "mostly the same", but **exactly the same**  
✅ **Performance**: No measurable slowdown in UI responsiveness (same or faster)  
✅ **Maintainability**: Code is easier to understand and modify  
✅ **Documentation**: All modules have clear JSDoc comments  
✅ **Pixel-perfect UI**: No visual changes whatsoever (layout, styles, animations)  
✅ **Message compatibility**: Extension ↔ webview protocol unchanged

---

## Future Enhancements Enabled by Refactor

Once modularized, these features become easier to add:

1. **Prompts Manager**
   - Drag-and-drop reordering
   - Bulk operations (delete multiple, duplicate)
   - Filtering and search

2. **Output Manager**
   - Syntax highlighting for code blocks
   - Diff view for file changes
   - Export to PDF/HTML

3. **Editor Manager**
   - Split view (edit multiple prompts)
   - Diff view (compare prompt versions)
   - Advanced completions (custom agents, MCP tools)

4. **Workflow Manager**
   - Workflow history and replay
   - Workflow branching (conditional execution)
   - Workflow sharing and export

5. **State Manager**
   - Reactive state (Vue/React patterns)
   - Undo/redo for all actions
   - State time-travel debugging

---

## Open Questions

1. **Confirmation modal**: Should it be in utilities.js or editor-manager.js?
   - **Recommendation**: utilities.js (reusable across managers, follows DRY)

2. **Layout toggles**: Should they be in a separate layout-manager.js?
   - **Recommendation**: Keep in dashboard.js (simple global UI state, would violate YAGNI to extract)

3. **Model options**: Part of state-manager.js or separate model-manager.js?
   - **Recommendation**: state-manager.js (it's just config state, follows SRP for state management)

4. **DOM elements object**: Pass entire object or subset per manager?
   - **Recommendation**: Pass entire object (pragmatic for webview, follows KISS over strict ISP)
   - **Rationale**: TypeScript would enforce ISP via interfaces, but in vanilla JS the complexity isn't worth it

5. **Error handling**: Centralized in message-router.js or per-manager?
   - **Recommendation**: Per-manager for specific errors, router for global errors (follows SRP)

6. **Message handler registration**: Registry pattern or switch statement?
   - **Recommendation**: Registry pattern (follows Open/Closed, eliminates DRY violations)

---

## SOLID & DRY Compliance Review

### ✅ Single Responsibility Principle (SRP)

- ✅ Each module has one well-defined responsibility
- ✅ State-manager: only manages state (no UI logic)
- ✅ Utilities: only pure helper functions (no state, no side effects)
- ✅ Each feature manager: owns one UI section + its state/logic
- ✅ Message-router: only routes messages and coordinates rendering

### ✅ Open/Closed Principle (OCP)

- ✅ Message router uses registry pattern - new message types don't require modifying router
- ✅ State-manager uses update methods - easy to swap for reactive state (Vue/React) later
- ✅ Managers are independent - can add new managers without changing existing ones
- ✅ Callback pattern for cross-manager communication - loose coupling

### ✅ Liskov Substitution Principle (LSP)

- ✅ Not applicable (no inheritance hierarchy)
- ✅ All managers follow same initialization contract (init function)

### ✅ Interface Segregation Principle (ISP)

- ⚠️ DOM elements object is shared (pragmatic choice for webview)
- ✅ Each manager exports only functions it needs (no bloated interfaces)
- ✅ State-manager provides targeted queries (getPromptByIndex) not just raw state dumps

### ✅ Dependency Inversion Principle (DIP)

- ✅ Managers depend on state-manager abstraction, not concrete state objects
- ✅ Prompts-manager uses callbacks instead of importing editor-manager directly
- ✅ Message handlers are registered (inversion of control)
- ✅ High-level modules (managers) don't depend on low-level modules (DOM)

### ✅ Don't Repeat Yourself (DRY)

- ✅ State-manager is single source of truth for all state
- ✅ Utilities module eliminates duplicated helper functions
- ✅ Message router registry eliminates repetitive switch/case blocks
- ✅ createPromptItem() helper used by all prompt creation paths
- ✅ DOM elements object defined once in dashboard.js
- ⚠️ Each manager has similar init() pattern (acceptable boilerplate, not DRY violation)

### Additional Best Practices

- ✅ **KISS (Keep It Simple)**: Pragmatic choices (passing full elements object) over over-engineering
- ✅ **YAGNI (You Ain't Gonna Need It)**: No layout-manager.js (would be premature)
- ✅ **Composition over Inheritance**: Modules use composition (callbacks, shared state) not inheritance
- ✅ **Law of Demeter**: Managers don't reach into other managers' internals

---

## Final SOLID/DRY Architecture Summary

### Key Architectural Decisions

1. **State Encapsulation** (SRP + OCP)
   - State-manager returns immutable copies (no direct mutations)
   - Easy to swap for reactive state later (Vue/React) without breaking consumers
   - Single source of truth eliminates DRY violations

2. **Callback-Based Communication** (DIP)
   - Prompts-manager receives callbacks instead of importing editor-manager
   - Inverts dependency: high-level module (prompts) doesn't depend on low-level (editor)
   - Eliminates circular dependency risk

3. **Message Handler Registry** (OCP + DRY)
   - Registry pattern eliminates giant switch/case statements
   - New message types don't require modifying router code
   - Managers register their own handlers (loose coupling)

4. **Pure Utilities** (SRP)
   - No side effects, no state, no DOM dependencies
   - Fully testable in isolation
   - Reusable across all modules

5. **Pragmatic ISP Trade-off**
   - Passing full `elements` object instead of per-manager subsets
   - **Rationale**: In vanilla JavaScript webview, the complexity of strict ISP isn't worth it
   - **Alternative**: Would require TypeScript interfaces to enforce properly
   - **Risk**: Low (elements object is just DOM references, not business logic)

### Architecture Patterns Used

- **Mediator Pattern**: Message-router coordinates between managers
- **Registry Pattern**: Handlers registered instead of hardcoded switch/case
- **Module Pattern**: IIFE with closure for private state
- **Dependency Injection**: Dependencies passed to init(), not global imports
- **Immutable State**: State accessors return copies, preventing accidental mutations
- **Callback Pattern**: Cross-manager communication via callbacks

### SOLID Violations Avoided

❌ **Avoided**: Giant god-object (dashboard.js doing everything)  
❌ **Avoided**: Circular dependencies (prompts ↔ editor)  
❌ **Avoided**: Direct state mutations (all via state-manager)  
❌ **Avoided**: Tight coupling via direct imports (use callbacks/registry)  
❌ **Avoided**: Bloated interfaces (each manager exports only what it needs)

### DRY Violations Eliminated

✅ **Eliminated**: Repetitive prompt item creation (createPromptItem helper)  
✅ **Eliminated**: Duplicated state access patterns (state-manager encapsulation)  
✅ **Eliminated**: Repetitive message handling (registry pattern)  
✅ **Eliminated**: Scattered utility functions (utilities module)  
✅ **Eliminated**: Multiple sources of truth for state (centralized state-manager)

### Remaining Trade-offs

⚠️ **Trade-off 1**: Full `elements` object passed to managers

- **Why**: Pragmatic choice for vanilla JS webview
- **Risk**: Low (just DOM references)
- **Mitigation**: Could add TypeScript interfaces later for strict ISP

⚠️ **Trade-off 2**: Init boilerplate in each manager

- **Why**: Simple, explicit, easy to understand
- **Risk**: Low (minimal duplication, clear pattern)
- **Alternative**: Base manager class (would add complexity)

⚠️ **Trade-off 3**: Editor-manager is largest module (~900 lines)

- **Why**: Editor has many cohesive responsibilities (text, properties, CRUD)
- **Risk**: Medium (could grow over time)
- **Mitigation**: Can split into properties-drawer.js if needed

---

## Conclusion

**Recommended Approach**: Hybrid modularization by feature ownership

**Key Benefits**:

- ✅ Reduces dashboard.js from 3,017 → ~300 lines
- ✅ Each module < 1,000 lines (< 10k tokens)
- ✅ Clear separation of concerns
- ✅ Easy to find and modify code
- ✅ Scalable for future features
- ✅ No circular dependencies

**Implementation Timeline**: 12-16 hours over 2-3 sessions

**Risk Level**: Medium (requires careful state management migration)

**Next Steps**:

1. Review and approve this plan
2. Start with Phase 1 (utilities.js) - low risk, high value
3. Iterate through phases with testing at each step
4. Update documentation after each phase

---

## Appendix: Module Size Estimates

| Module              | Lines     | Est. Tokens | Risk   | Dependencies         |
| ------------------- | --------- | ----------- | ------ | -------------------- |
| dashboard.js        | 300       | 3,000       | Low    | All managers         |
| state-manager.js    | 200       | 2,000       | Medium | None                 |
| utilities.js        | 150       | 1,500       | Low    | None                 |
| workflow-manager.js | 400       | 4,000       | Medium | State, Utils         |
| prompts-manager.js  | 400       | 4,000       | Medium | State, Utils, Editor |
| output-manager.js   | 400       | 4,000       | Low    | State, Utils         |
| editor-manager.js   | 900       | 9,000       | High   | State, Utils         |
| message-router.js   | 500       | 5,000       | High   | All managers         |
| **Total**           | **3,250** | **32,500**  | -      | -                    |

**Notes**:

- Total lines increase slightly (3,017 → 3,250) due to module boilerplate and SOLID patterns
- Token count includes module initialization, exports, and encapsulation code
- All modules comfortably under 10k token limit (largest is editor-manager at ~9k)
- Main dashboard.js reduced by 90% (3,017 → 300 lines)
- Increased lines are offset by improved maintainability, testability, and SOLID compliance

---

## ✅ Final SOLID/DRY Review Checklist

### Single Responsibility Principle (SRP)

- ✅ State-manager: Only manages state, no UI logic
- ✅ Utilities: Only pure functions, no state or side effects
- ✅ Each feature manager: Owns exactly one UI section
- ✅ Message-router: Only routes messages and coordinates
- ✅ Dashboard.js: Only initialization and wiring

### Open/Closed Principle (OCP)

- ✅ Message router registry: Add new message types without modifying router
- ✅ State-manager: Can swap for reactive state without breaking consumers
- ✅ Callback pattern: Can change editor implementation without changing prompts
- ✅ Each manager is closed for modification, open for extension

### Liskov Substitution Principle (LSP)

- ✅ All managers follow same initialization contract
- ✅ No inheritance used (composition preferred)

### Interface Segregation Principle (ISP)

- ✅ Each manager exports only needed functions
- ✅ State queries are specific (getPromptByIndex) not generic dumps
- ⚠️ DOM elements object shared (pragmatic trade-off for vanilla JS)

### Dependency Inversion Principle (DIP)

- ✅ Managers depend on state-manager abstraction, not concrete state
- ✅ Callback pattern inverts dependencies (prompts → editor)
- ✅ Registry pattern inverts control (managers register handlers)
- ✅ Dependencies injected via init(), not hardcoded

---

## 🔒 Implementation Contract

**This refactor MUST be:**

1. ✅ **Zero functional changes** - User cannot tell the difference
2. ✅ **100% backward compatible** - All message types, state structure unchanged
3. ✅ **Regression-free** - Every test passes identically
4. ✅ **Performance-neutral or better** - No slowdowns allowed
5. ✅ **Visually identical** - Not a single pixel moves

**This refactor is NOT:**

1. ❌ **A feature addition** - No new capabilities
2. ❌ **A UX improvement** - No interaction changes
3. ❌ **A performance optimization** - Same speed (or faster as side effect)
4. ❌ **A bug fix** - Bugs stay bugs (fix separately)
5. ❌ **A design change** - Architecture only, not behavior

**Implementation Rule**: If you're tempted to "improve" something while refactoring - STOP. File a separate issue. This refactor must be pure code organization with zero behavior changes.

**Why This Matters**: Mixing refactors with feature changes makes debugging impossible. If something breaks, we need to know it was the refactor, not a "helpful improvement" sneaked in.

### Don't Repeat Yourself (DRY)

- ✅ State-manager is single source of truth
- ✅ Utilities eliminate duplicated helpers
- ✅ Registry pattern eliminates switch/case duplication
- ✅ createPromptItem() eliminates prompt creation duplication
- ✅ No duplicated business logic across modules

### Additional Best Practices

- ✅ KISS: Pragmatic choices (full elements object) over complexity
- ✅ YAGNI: No premature optimization (e.g., no layout-manager.js)
- ✅ Composition over Inheritance: Modules compose via callbacks
- ✅ Law of Demeter: Managers don't reach into other managers
- ✅ Encapsulation: State mutations only via state-manager
- ✅ Immutability: State accessors return copies

### Architecture Quality Metrics

- ✅ **Cohesion**: High (related functions grouped together)
- ✅ **Coupling**: Low (managers independent, communicate via callbacks/registry)
- ✅ **Complexity**: Reduced (each module < 1000 lines)
- ✅ **Maintainability**: Improved (clear ownership, easy to find code)
- ✅ **Testability**: High (pure functions, injectable dependencies)
- ✅ **Scalability**: Good (can add managers without changing existing code)

**Verdict**: ✅ **Plan is SOLID and DRY compliant with pragmatic trade-offs clearly documented.**
