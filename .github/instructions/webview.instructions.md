---
applyTo: "src/ui/webview/**"
---

<purpose>
WebView-based dashboard UI for real-time workflow visualization, execution control, prompt editing, and CLI output monitoring.
</purpose>

<architecture>
**Multi-component system:**
1. **FlightPathDashboardProvider** (TypeScript) - VS Code WebView provider, message routing, state management
2. **dashboard.js** (Client-side JavaScript) - DOM manipulation, state rendering, VS Code API communication
3. **codemirror-editor.js** (CodeMirror integration) - Modern prompt editor with autocomplete, spell check, and link navigation
4. **shared.css** (Shared Styles) - Common variables, base styles, and theme integration for all FlightPath webviews
5. **dashboard.css** (Dashboard Styles) - Extends shared.css with dashboard-specific layout

**Shared styling architecture:**

- `shared.css` defines CSS custom properties (spacing, colors) and base element styles
- Each webview (dashboard, settings) has its own CSS file extending shared.css
- HTML templates link `{{sharedStyleUri}}` first, then view-specific `{{styleUri}}`
- Ensures consistent look and feel across all FlightPath panels

**Spacing variables (compact for panel usage):**

- `--spacing-xs: 4px` - Minimal spacing
- `--spacing-sm: 6px` - Small gaps
- `--spacing-md: 8px` - Standard spacing
- `--spacing-lg: 12px` - Section spacing

**Communication flow:**

- Extension → WebView: `postMessage()` with typed message objects
- WebView → Extension: `vscode.postMessage()` triggering command execution
- State synchronization: Bidirectional updates for file selection, execution progress, CLI output, prompt editing
  </architecture>

<flightPathDashboardProvider>
**Responsibilities:**
- Implements `vscode.WebviewViewProvider` for sidebar integration
- HTML generation with secure CSP and local resource URIs
- Message routing between WebView and extension commands
- State updates via public methods called by FlightPathManager
- Initial state hydration on webview ready
- Template management for workflow creation
- Completion provider integration for CodeMirror autocomplete

**Key public methods (called by FlightPathManager):**

```typescript
updateFileSelected(fileName, prompts); // File selection with prompt list
updateExecutionStarted(fileName, totalSteps); // Workflow start
updateExecutionState(state); // Execution state changes (idle, running, paused, completed, error)
updateProgress(current, total); // Progress updates (current/total prompts)
updateStepStatus(stepIndex, status, details); // Individual prompt status
updateRetryAttempt(stepIndex, currentRetry, maxRetries); // Retry attempt tracking
updateCliOutput(stepIndex, output); // Complete CLI response
updateCliStreamingChunk(stepIndex, chunk); // Real-time streaming chunks
updateExecutionCompleted(); // Workflow completion
updatePromptsExtended(prompts); // Queue extension notification (dynamic queue)
updateSessionRestored(state); // Session restoration (CLI resume)
```

**Message handling (command routing via messageCommandMap):**

- `ready` → Send initial state with model options and templates
- `selectFile` → Execute `flightpath.selectPromptFile`
- `appendFile` → Execute `flightpath.appendFromDashboard`
- `editFile` → Execute `flightpath.editCurrentPromptFile`
- `run` → Execute `flightpath.run`
- `pause/resume/stop` → Execute corresponding commands
- `showOutput` → Execute `flightpath.showOutputPanel`
- `newWorkflow` → Open template modal with available templates
- `templateSelected` → Create workflow from template with variable substitution
- `requestCompletions` → Provide autocomplete suggestions for CodeMirror
- `openFile` → Open file in VS Code editor with optional line selection
- `executePrompt` → Execute single prompt from editor
- `updatePrompt` → Update existing prompt in queue
- `selectPromptForEdit` → Load prompt into editor
- `deletePrompt` → Remove prompt from queue
- `exportOutput` → Export CLI output to markdown file

**Security:**

- `enableScripts: true` for interactive UI
- `localResourceRoots` restricted to `out/ui/webview/`
- CSP headers via `webview.asWebviewUri()` for script/style loading
- Custom icons embedded as data URIs in `custom-icons.css`
  </flightPathDashboardProvider>

<dashboardJS>
**Client-side state management:**
```javascript
state = {
  fileName: string | null,
  prompts: Array<{index, text, status, details, provider, model, agent, newChatSession, allowDynamicExtension, endCondition}>,
  executionState: 'idle' | 'running' | 'paused' | 'completed' | 'error',
  currentStep: number,
  totalSteps: number,
  cliOutputs: { [stepIndex]: array of outputs (including retries) },
  retryStates: { [stepIndex]: { currentRetry, maxRetries } },
  statusMessages: { [stepIndex]: array of status messages }
}

editorState = {
selectedPromptIndex: number | null, // null = new prompt mode, number = editing existing
originalPromptData: object | null, // For Cancel/revert functionality
savedNewPromptState: object | null, // Saved new prompt state when switching to edit mode
hasActiveQueue: boolean, // Whether a workflow is currently loaded
promptEditor: CodeMirrorPromptEditor // PromptEditor instance
}

modalState = {
templates: TemplateInfo[],
currentTemplate: TemplateInfo | null,
workflowsDir: string,
defaultTemplateId: string
}

````

**Message handlers:**

- `init` → Hydrate initial state with model options and templates
- `fileSelected` → Update file, prompts, reset execution state and retry states
- `executionStarted` → Show progress bar, update state
- `executionStateChanged` → Update execution state badge in header
- `progressUpdate` → Update progress counter (current/total)
- `stepStatusChanged` → Update prompt item status/details, add status messages
- `retryAttemptChanged` → Update retry state for step, re-render prompts
- `cliOutput` → Store and render complete CLI response
- `cliStreamingChunk` → Append chunk to response, render if current step with autoscroll
- `executionCompleted` → Update state, enable re-run button
- `modelOptionsUpdate` → Update available models per provider from ModelRegistry
- `templatesLoaded` → Populate template dropdown in modal
- `promptsExtended` → Show notification and update prompts list (dynamic queue)
- `sessionRestored` → Restore full state including prompts, outputs, and execution state
- `completions` → Pass autocomplete suggestions to CodeMirror editor

**Rendering functions:**

- `render()` → Top-level orchestrator
- `renderExecutionState()` → Updates execution state badge with appropriate styling
- `renderPromptsList()` → Prompt items with status icons, retry info, details, click handlers for editing
- `renderCliOutputs(stepIndex)` → CLI outputs with retry attempt labels, streaming indicator
- `updateControls()` → Enable/disable buttons based on state and editor mode
- `updateEditorControls()` → Show/hide editor action buttons (Run, Append, Update, Cancel, Delete)
- `renderPromptCounter()` → Show current/total prompt count
- `renderPropertyControls()` → Populate property drawer with prompt settings

**Status icons (codicons):**

- Pending: `codicon-circle-outline`
- Running: `codicon-play`
- Completed: `codicon-pass`
- Failed: `codicon-error`
- Retry: `codicon-refresh`

**Execution state badge:**

- Displayed in header between file info and controls
- Color-coded: Idle (gray), Running (blue/pulsing), Paused (yellow), Completed (green), Error (red)
- Text updates: "Idle", "Running", "Paused", "Completed", "Error"

**Retry display:**

- Shows "Retry N of M" with retry icon under prompt when retrying
- Orange/warning color to indicate retry status
- Visible in prompt list during retry attempts
- Cleared on success or when moving to next prompt

**Controls logic:**

- **Header buttons:**
  - Load: Always enabled
  - Append: Enabled when workflow loaded and not running
  - New Workflow: Always enabled
  - Run: Enabled if prompts exist AND (not running OR completed)
  - Re-run mode: Show ↻ icon and "Re-run" tooltip when completed
  - Pause/Stop: Enabled only when running
- **Layout controls:**
  - Vertical/Horizontal layout toggle
  - Swap panels button to reverse output/editor positions
  - Active state styling for current layout
- **Editor action buttons:**
  - Run (single prompt): Enabled when editor has text and not currently running
  - Append: Enabled when editor has text and workflow loaded
  - Append Next: Enabled when editor has text, workflow loaded, and execution running
  - Update: Shown only in edit mode
  - Delete: Shown only in edit mode
  - Cancel: Always enabled in edit mode

**CLI output rendering:**

- Show prompt text with timestamp
- Show response text (streaming or complete)
- Show token statistics (input/output/total tokens, cost, elapsed time)
- Streaming indicator: Pulsing dot with "Streaming..." text
- Auto-scroll during streaming (if autoscroll checkbox enabled)
- Export button to save output as markdown
- Empty state: "No output yet"

**Important behaviors:**

- File selection resets execution state and progress (prevents stale data)
- CLI output only renders for `currentStep - 1` (most recently completed step)
- Streaming chunks accumulate in `cliOutputs[stepIndex].response`
  </dashboardJS>

<codeMirrorEditor>
**CodeMirrorPromptEditor** - Modern code editor for FlightPath prompts

**Responsibilities:**
- Rich text editing with VS Code theme integration
- Custom autocomplete for `@file` and `#file` references
- Clickable links with Ctrl+Click navigation
- Native spell checking with Typo.js
- Undo/redo, search, multiple selections

**Architecture:**

```javascript
class CodeMirrorPromptEditor {
  constructor(containerElement, affUri, dicUri, vscodeApi);
  init(); // Loads CodeMirror bundle and initializes Typo.js
  buildExtensions(); // Configures editor features
  getText(); // Get current editor content
  setText(text); // Set editor content
  focus(); // Focus editor
  handleCompletionResponse(completions); // Handle autocomplete results
}
````

**Extensions:**

- `minimalSetup` - Basic editor features (line numbers, selection, etc.)
- `lineWrapping` - Wrap long lines
- `history()` - Undo/redo support
- `themeExtension()` - VS Code theme integration
- `linterThemeExtension()` - Error/warning styling
- `spellCheckExtension()` - Native spell checking with Typo.js
- `autocompletionExtension()` - Custom autocomplete for @file and #file
- `linkDecorationExtension()` - Underline clickable links
- `updateListenerExtension()` - Emit change events
- `keymapExtension()` - Custom keyboard shortcuts
- `clickHandlerExtension()` - Ctrl+Click link navigation

**Autocomplete flow:**

1. User types `@` or `#file:`
2. Editor triggers `requestCompletions` message to extension
3. FlightPathDashboardProvider calls completion helpers (from CompletionHelpers.ts)
4. Extension sends `completions` message with results
5. Editor displays dropdown with file/selection suggestions
6. User selects item, text is inserted

**Link navigation:**

- Pattern matching: `@path/to/file.ts`, `#file:path:10-20`, `#sym:path:symbol:42`
- Ctrl+Click sends `openFile` message to extension
- Extension opens file in VS Code editor with optional line selection

**Spell checking:**

- Typo.js with en_US dictionary (aff/dic files loaded at init)
- Squiggly underline for misspelled words
- VS Code color integration for error styling

**Theme integration:**

- All colors via `var(--vscode-*)` CSS variables
- Matches VS Code editor appearance (font, colors, selection)
- Dark/light theme support automatic
  </codeMirrorEditor>
  **Responsive layout:**
- Adaptive three-panel layout: Prompts + Output + Editor
- Layout modes: Vertical stack (default) or horizontal stack
- Collapsible sections with chevron buttons
- Swap panels feature to reverse output/editor positions

**VS Code theme integration:**

```css
--bg-primary: var(--vscode-editor-background)
  --bg-secondary: var(--vscode-sideBar-background)
  --fg-primary: var(--vscode-editor-foreground)
  --fg-secondary: var(--vscode-descriptionForeground)
  --border-color: var(--vscode-panel-border)
  --status-success: var(--vscode-testing-iconPassed)
  --status-error: var(--vscode-testing-iconFailed)
  --status-running: var(--vscode-progressBar-background);
```

**Layout structure:**

```
#app (flexbox column, 100vh)
├── #header (fixed height, action buttons + workflow status + controls)
│   ├── #action-buttons (Load, Append, New Workflow)
│   ├── #workflow-status (file name + execution state badge)
│   └── #controls (layout toggle + Run/Pause/Stop)
└── #main-content (flex:1, responsive split)
    ├── #prompts-section (scrollable list with collapse)
    └── #output-editor-container (right side)
        ├── #output-section (scrollable CLI output with collapse)
        └── #editor-section (CodeMirror editor with properties drawer)
```

**Key styling patterns:**

- Scrollable sections: `flex:1` + `min-height:0` + `overflow-y:auto`
- Status colors: Applied via `.status-{completed|failed|running|pending}` classes
- Collapsible sections: `.collapsed` class hides content, rotates chevron -90deg
- Section icons: Hidden normally, shown when collapsed for visual feedback
- CLI output: Syntax highlighting for prompt (blue tint) and response (green tint)
- Border-left indicators: 3px colored bars for prompt/response differentiation
- Properties drawer: Slide-in panel from right with form controls
- Layout classes: `.layout-vertical`, `.layout-horizontal`, `.swapped`
- CodeMirror theme: Inherits VS Code theme variables for seamless integration

**Modal styling:**

- Full-screen overlay with centered modal dialog
- Template dropdown with descriptions
- Variable inputs with validation
- Filename preview and error display
- Set as default checkbox for templates
  </dashboardCSS>

<integrationWithFlightPathManager>
**Dashboard lifecycle:**
1. FlightPathManager registers dashboard provider in `extension.ts`
2. User opens FlightPath sidebar view (or it auto-opens)
3. WebView sends `ready` message → Provider sends initial state with models and templates
4. User selects file OR creates new workflow from template → Manager calls `updateFileSelected()`
5. User edits prompts in CodeMirror editor with autocomplete and spell check
6. User clicks Run (full queue) OR Run Single (current prompt) → Manager executes workflow
7. During execution:
   - Manager calls `updateExecutionStarted()` before first prompt
   - Manager calls `updateStepStatus()` when prompt starts/completes/fails
   - Manager calls `updateProgress()` after each step (current/total counter)
   - Manager calls `updateCliOutput()` OR `updateCliStreamingChunk()` for CLI responses
   - Manager calls `updateStatusMessage()` for warnings/errors/info messages
   - Manager calls `updateExecutionCompleted()` after final prompt
8. WebView renders updates in real-time with autoscroll and syntax highlighting
9. For dynamic queue: Manager calls `updatePromptsExtended()` when queue grows
10. For session restore: Manager calls `updateSessionRestored()` with full state

**CLI output flow (streaming):**

```
CopilotCommandLineIntegration streams chunk
→ FlightPathManager receives chunk in onResponseChunk
→ Manager calls dashboardProvider.updateCliStreamingChunk(stepIndex, chunk)
→ DashboardProvider sends { type: 'cliStreamingChunk', stepIndex, chunk }
→ dashboard.js appends chunk to state.cliOutputs[stepIndex].response
→ If current step, renderCliOutput() updates display with accumulated text
→ Autoscroll if checkbox enabled
→ On completion, final updateCliOutput() called with complete output + stats
```

**CLI output flow (non-streaming/final):**

```
CopilotCommandLineIntegration completes request
→ FlightPathManager receives complete output in onResponseComplete
→ Manager calls dashboardProvider.updateCliOutput(stepIndex, output)
→ DashboardProvider sends { type: 'cliOutput', stepIndex, output }
→ dashboard.js stores output in state.cliOutputs[stepIndex]
→ If stepIndex === currentStep - 1, renderCliOutput() displays output
```

**Prompt editing flow:**

```
User clicks prompt in list
→ dashboard.js sends { type: 'selectPromptForEdit', index }
→ Editor loads prompt text and properties into CodeMirror and property drawer
→ User modifies text/properties
→ User clicks Update
→ dashboard.js sends { type: 'updatePrompt', index, prompt, properties }
→ FlightPathManager updates queue and prompt file
→ Dashboard re-renders with updated prompt
```

**Template workflow creation flow:**

```
User clicks New Workflow
→ dashboard.js sends { type: 'newWorkflow' }
→ DashboardProvider queries TemplateManager.listTemplates()
→ Provider sends { type: 'templatesLoaded', templates }
→ Modal displays templates with descriptions
→ User selects template, fills variables, sets filename
→ dashboard.js sends { type: 'templateSelected', templateId, variables, fileName, shouldRun }
→ Provider calls TemplateManager.createFromTemplate()
→ Workflow file created, optionally executed
```

**State synchronization:**

- Dashboard state is derived from FlightPathManager state
- No independent state mutations (single source of truth in Manager)
- WebView never sends state updates, only command triggers
- Editor state persisted to VS Code memento for session recovery
  </integrationWithFlightPathManager>

<futureEnhancements>
- Drag-and-drop prompt reordering
- Bulk prompt operations (delete multiple, duplicate)
- Prompt templates library
- Advanced property controls (conditional execution, parallel prompts)
- Execution history with replay capability
- Log filtering and search
- Export execution reports (HTML, PDF)
- Syntax highlighting for code blocks in CLI responses
- Diff view for prompt updates
- Keyboard shortcuts for all controls
- Split view for comparing prompts
</futureEnhancements>

<relatedFiles>
- `../StatusBarManager.ts` - Companion UI component for status bar display
- `../../flightpath/FlightPathManager.ts` - Orchestrates dashboard updates
- `../../flightpath/cli/CopilotCommandLineIntegration.ts` - Source of CLI output
- `../../types/FlightPathTypes.ts` - QueueState and PromptItem type definitions
- `../../extension.ts` - Dashboard provider registration
</relatedFiles>

<importantContext>
**WebView resource loading:**
- JS/CSS files must be in `out/ui/webview/` after build
- Use `webview.asWebviewUri()` to convert file paths to webview URIs
- Build process must copy webview assets from `src/ui/webview/` to `out/ui/webview/`
- CodeMirror bundle loaded via `codemirror-loader.js` script tag
- Custom icons embedded as data URIs in `custom-icons.css` (auto-generated from SVG sources)

**Debugging tips:**

- WebView console: Right-click webview → "Open WebView Developer Tools"
- Message flow: Add `console.log()` in both provider and dashboard.js
- State inspection: Use `vscode.postMessage({ type: 'debug', state })` pattern
- CodeMirror debugging: Access editor via `editorState.promptEditor.view`

**Performance considerations:**

- Streaming chunks: Renders throttled to avoid excessive DOM updates
- Large responses: Auto-scroll only when enabled via checkbox
- History: CLI outputs stored per step, cleared on new file load
- Editor state: Debounced saves to VS Code memento (500ms)

**Accessibility:**

- Ensure all buttons have proper `title` attributes
- Use semantic HTML for screen reader support
- Maintain keyboard navigation (tab order)
- Status colors should have text fallbacks (not color-only indication)
- Codicons provide visual consistency and theme adaptation

**Icon system:**

- NEVER use raw emoji characters (🔄, ✅, ❌, 📁, etc.) in dashboard HTML/CSS/JS
- Emojis cannot be styled or colored to match VS Code themes
- ALWAYS use codicons for icons - they inherit VS Code theme colors perfectly
- Codicon usage:
  - Include codicon.css via `{{codiconsUri}}` placeholder in HTML template
  - Use `<i class="codicon codicon-{name}"></i>` for icons
  - See https://microsoft.github.io/vscode-codicons/dist/codicon.html for full icon list
- Text symbols (→, ↻, etc.) are acceptable for CSS ::before/::after content where codicons cannot be used
- Custom icons (append, etc.) use data URI embedded CSS from `custom-icons.css`
  </importantContext>
