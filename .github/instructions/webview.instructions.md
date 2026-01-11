---
applyTo: "src/ui/webview/**"
---

<purpose>
WebView UI for dashboard (workflow visualization/execution, CodeMirror editor, CLI output streaming) and settings (provider/model/agent configuration).
</purpose>

<architecture>
**Components:**
1. FlightPathDashboardProvider (TypeScript) - WebView provider, message routing, state management
2. FlightPathSettingsProvider (TypeScript) - Settings WebView provider
3. dashboard.js (JavaScript) - DOM manipulation, state rendering, VS Code API
4. settings.js (JavaScript) - Settings UI, provider/model selection
5. codemirror-editor.js - Prompt editor with autocomplete, spell check, Ctrl+Click navigation
6. shared.css → dashboard.css/settings.css (cascading styles)

**Communication:** Extension ↔ WebView via `postMessage()` with MESSAGE_TYPES constants

**Styling:** `shared.css` (compact spacing: `--spacing-xs/sm/md/lg`, theme colors), extended by view-specific CSS. CSP-compliant with embedded icons.
</architecture>

<dashboardProvider>
**Update methods:** File selected, execution state/progress, step status, retry attempts, CLI output (batch/streaming), queue extension, session restore

**Message handlers:** Command-mapped (run/pause/stop, select/append/edit file, template actions) + direct (export, execute/update/delete prompts, completions, open file)
</dashboardProvider>

<dashboardJS>
**State management:** currentFile, prompts array, cliOutputs array, executionState, currentStepIndex, editorState (memento-backed persistence)

**Key features:** Real-time DOM updates, auto-scroll CLI output, CodeMirror integration, template modal, property drawer, queue position logic (END/NEXT/BEFORE_CURRENT)
</dashboardJS>

<codemirrorEditor>
**Features:** VS Code theme integration, `@file` and `#file:` autocomplete, Ctrl+Click navigation, Typo.js spell check (en_US), real-time change callbacks, line/column tracking
</codemirrorEditor>

<security>
CSP headers, `localResourceRoots` restricted to `out/ui/webview/`, custom icons as data URIs, no inline scripts/eval
</security>

<relatedFiles>
- FlightPathDashboardProvider.ts, FlightPathSettingsProvider.ts - Providers
- DashboardConstants.ts - MESSAGE_TYPES, EXECUTION_STATES, etc.
- CompletionHelpers.ts - Autocomplete logic
- ModelRegistry.ts - Available models per provider
</relatedFiles>

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
- `clearWorkflow` → Clear current workflow state, start blank
- `run` → Execute `flightpath.run`
- `pause/resume/stop` → Execute corresponding commands
- `showOutput` → Execute `flightpath.showOutputPanel`
- `newWorkflow` → Open "New Workflow" blank state
- `newWorkflow` (from template button) → Open template modal with available templates
- `templateSelected` → Create workflow from template with variable substitution
- `setDefaultTemplate` → Save user's default template preference
- `createNewTemplate` → Create new custom template (future)
- `requestCompletions` → Provide autocomplete suggestions for CodeMirror
- `openFile` → Open file in VS Code editor with optional line selection
- `executePrompt` → Execute single prompt from editor with action type (RUN, QUEUE, RUN_NEXT, etc.)
- `updatePrompt` → Update existing prompt in queue
- `selectPromptForEdit` → Load prompt into editor
- `deletePrompt` → Remove prompt from queue
- `exportOutput` → Export CLI output to markdown file
- `changeProvider/changeModel/changeAgent` → Settings panel configuration changes

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
  executionState: 'idle' | 'running' | 'paused' | 'stopped' | 'cancelling' | 'completed' | 'error',
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
promotEditor: CodeMirrorPromptEditor // CodeMirrorPromptEditor instance
}

modalState = {
templates: TemplateInfo[], // Available templates (built-in, custom, actions)
currentTemplate: TemplateInfo | null, // Selected template during creation
workflowsDir: string, // Directory for saving workflows
defaultTemplateId: string // User's preferred default template
}

````

**Constants imported from DashboardConstants.ts:**

Dashboard.js imports all shared constants from compiled `DashboardConstants.js` (loaded via script tag), ensuring single source of truth:

- `MESSAGE_TYPES` - All message types for extension ↔ webview communication
- `EXECUTION_STATES` - Queue execution states
- `STEP_STATUS` - Prompt execution status values
- `ACTION_TYPES` - Prompt editor action types (RUN, QUEUE, RUN_NEXT, etc.)
- `PROVIDER_IDS` - Provider identifiers
- `DEFAULT_MODELS` - Default model per provider
- `CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS` - Static model lists
- `PROMPT_PROPERTIES`, `END_CONDITION_PROPERTIES` - Property definitions

**External dependencies (loaded via script tags):**

- `gptTokenizer` (window.gptTokenizer) - Token counting for editor
- `CodeMirror` (window.CM) - Editor modules loaded by codemirror-loader.js

**Message handlers:**

- `init` → Hydrate initial state with model options, templates, and provider status
- `fileSelected` → Update file, prompts, reset execution state and retry states
- `sessionRestored` → Restore full state including prompts, outputs, and execution state (CLI session resume)
- `executionStarted` → Show progress bar, update state
- `executionStateChanged` → Update execution state badge in header
- `progressUpdate` → Update progress counter (current/total)
- `stepStatusChanged` → Update prompt item status/details, add status messages
- `retryAttemptChanged` → Update retry state for step, re-render prompts
- `cliOutput` → Store and render complete CLI response
- `cliStreamingChunk` → Append chunk to response, render if current step with autoscroll
- `statusMessage` → Add status message (info/warning/error) to step
- `executionCompleted` → Update state, enable re-run button
- `modelOptionsUpdate` → Update available models per provider from ModelRegistry
- `providerStatusUpdate` → Update provider availability (CLI checking, available, not available)
- `templatesLoaded` → Populate template dropdown in modal (built-in, custom, actions)
- `defaultTemplateSet` → Confirm default template updated
- `workflowCreated` → Close modal and optionally run new workflow
- `promptsExtended` → Show notification and update prompts list (dynamic queue)
- `promptsAppended` → Add prompts to queue
- `promptDeleted` → Remove prompt from list and update display
- `queueExtended` → Show notification with queue size info
- `queueSizeLimitReached` → Show warning about queue size limit
- `executionTimeLimitReached` → Show warning about execution time limit
- `dynamicQueueEnabled/Disabled` → Update dynamic queue status
- `completions` → Pass autocomplete suggestions to CodeMirror editor

**Rendering functions:**

- `render()` → Top-level orchestrator
- `renderExecutionState()` → Updates execution state badge with appropriate styling
- `renderPromptsList()` → Prompt items with status icons, retry info, details, click handlers for editing
- `renderCliOutputs(stepIndex)` → CLI outputs with retry attempt labels, streaming indicator, token stats
- `updateControls()` → Enable/disable buttons based on state and editor mode
- `updateEditorControls()` → Show/hide editor action buttons (Run, Queue, Update, Cancel, Delete)
- `renderPromptCounter()` → Show current/total prompt count
- `updateTokenCount()` → Calculate and display GPT token count for editor content
- `populatePropertyControls()` → Load prompt properties into drawer (provider, model, agent, etc.)
- `populateTemplateDropdown()` → Render template options grouped by type (built-in, custom, actions)
- `renderProviderStatus()` → Update provider availability indicators in settings

**Status icons (codicons):**

- Pending: `codicon-circle-outline`
- Running: `codicon-play`
- Completed: `codicon-pass`
- Failed: `codicon-error`
- Retry: `codicon-refresh`
- Cancelled: `codicon-close`

**Execution state badge:**

- Displayed in header between file info and controls
- Color-coded: Idle (gray), Running (blue/pulsing), Paused (yellow), Stopped (orange), Cancelling (red/pulsing), Completed (green), Error (red)
- Text updates: "Idle", "Running", "Paused", "Stopped", "Cancelling", "Completed", "Error"

**Retry display:**

- Shows "Retry N of M" with retry icon under prompt when retrying
- Orange/warning color to indicate retry status
- Visible in prompt list during retry attempts
- Cleared on success or when moving to next prompt

**Controls logic:**

- **Header buttons:**
  - Load: Always enabled
  - Queue File: Enabled when workflow loaded and not running
  - New Workflow: Always enabled (clears current workflow)
  - From Template: Always enabled
  - Run: Enabled if prompts exist AND (not running OR completed)
  - Re-run mode: Show ↻ icon and "Re-run" tooltip when completed
  - Pause/Stop: Enabled only when running
- **Layout controls:**
  - Vertical/Horizontal layout toggle
  - Swap panels button to reverse output/editor positions
  - Active state styling for current layout
- **Editor action buttons:**
  - Run: Appends prompt and starts/resumes workflow (intelligent positioning)
  - Queue: Appends prompt without auto-starting
  - Update: Shown only in edit mode (updates existing prompt)
  - Delete: Shown only in edit mode (removes prompt from queue)
  - Cancel: Exits edit mode and reverts to new prompt mode
- **Properties drawer:**
  - Slide-in panel from right
  - Provider, Model, Agent selectors
  - New Chat Session, Allow Dynamic Extension toggles
  - End Condition fields (script, returns, timeout, retries, retry prompt)

**Intelligent prompt positioning (ACTION_TYPES):**

When user clicks "Run" or "Queue" with prompts in the editor:

- `RUN` → Append to end + ensure workflow runs
- `QUEUE` → Append to end, preserve current state
- `RUN_NEXT` → Append after current step + ensure workflow runs (when running)
- `QUEUE_NEXT` → Append after current step, preserve current state
- `RUN_BEFORE_CURRENT` → Insert before current + start workflow (when stopped/idle with prompts)

Logic determines final action based on execution state and queue position.

**CLI output rendering:**

- Show prompt text with timestamp
- Show response text (streaming or complete)
- Show token statistics (input/output/total tokens, cost, elapsed time)
- Streaming indicator: Pulsing dot with "Streaming..." text
- Auto-scroll during streaming (if autoscroll checkbox enabled)
- Export button to save output as markdown
- Syntax highlighting with colored left borders (blue for prompt, green for response)
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

<settingsWebview>
**FlightPathSettingsProvider** - Separate webview for global FlightPath settings

**Purpose:**
Provides a user-friendly UI for configuring FlightPath execution settings without editing JSON settings directly.

**State management:**

```javascript
state = {
  provider: 'copilot-cli' | 'copilot-chat' | 'claude-cli' | 'codex-cli',
  model: string, // Model ID for current provider
  agent: string | 'default',
  executionMode: 'interactive' | 'headless',
  newChatSessionPerPrompt: boolean,
  dynamicQueueEnabled: boolean
}

providerStatus = {
  [providerId]: { available: boolean, status: 'checking' | 'available' | 'not_available' }
}

modelOptions = {
  [providerId]: Array<{ value: string, label: string }>
}
```

**Components:**

- **Provider dropdown** - Select AI provider (Copilot CLI, Copilot Chat, Claude CLI, Codex CLI)
- **Model dropdown** - Select model for current provider (dynamically populated)
- **Agent dropdown** - Select custom agent or "default"
- **Execution mode dropdown** - Interactive (visible terminal) or Headless (background)
- **New Chat Session checkbox** - Start new chat session for each prompt (Chat mode only)
- **Dynamic Queue checkbox** - Enable autonomous workflow extension

**Message handling:**

Extension → Settings:

- `init` → Send initial state with model options and provider status
- `modelOptionsUpdate` → Update available models from ModelRegistry
- `providerStatusUpdate` → Update provider availability

Settings → Extension:

- `changeProvider` → Update flightpath.provider setting
- `changeModel` → Update provider-specific model setting
- `changeAgent` → Update custom agent setting
- `changeExecutionMode` → Update cliExecutionMode setting
- `changeDynamicQueue` → Update enableDynamicQueue setting
- `changeNewChatSession` → Update newChatSessionPerPrompt setting

**Provider status indicators:**

- Shows real-time availability of each CLI provider
- "checking..." → Querying provider availability
- Green checkmark → Provider available
- Red X → Provider not installed/available

**Dynamic UI behavior:**

- Execution mode selector only visible for CLI providers
- New Chat Session option only visible for Copilot Chat provider
- Model dropdown repopulated when provider changes
- Settings persist to VS Code workspace configuration

**Integration:**

Settings panel is registered in extension.ts alongside dashboard. Changes immediately update FlightPathManager configuration via ConfigurationUtils.

</settingsWebview>

<relatedFiles>
- `../FlightPathDashboardProvider.ts` - Dashboard webview provider (main UI)
- `../FlightPathSettingsProvider.ts` - Settings webview provider (configuration UI)
- `../StatusBarManager.ts` - Companion UI component for status bar display
- `../../flightpath/FlightPathManager.ts` - Orchestrates dashboard updates
- `../../flightpath/TemplateManager.ts` - Manages workflow templates
- `../../flightpath/cli/CopilotCommandLineIntegration.ts` - Source of CLI output
- `../../completions/CompletionHelpers.ts` - File/hash completion providers
- `../../types/FlightPathTypes.ts` - QueueState and PromptItem type definitions
- `../../types/DashboardConstants.ts` - Shared constants (single source of truth)
- `../../utils/ModelRegistry.ts` - Dynamic model discovery
- `../../utils/ModelConstants.ts` - Model definitions and display names
- `../../utils/ConfigurationUtils.ts` - VS Code settings management
- `../../extension.ts` - Dashboard and settings provider registration
</relatedFiles>

<importantContext>
**WebView resource loading:**
- JS/CSS files must be in `out/ui/webview/` after build
- Use `webview.asWebviewUri()` to convert file paths to webview URIs
- Build process must copy webview assets from `src/ui/webview/` to `out/ui/webview/`
- Build process compiles `src/types/DashboardConstants.ts` to `out/types/DashboardConstants.js` (loaded via script tag)
- CodeMirror bundle loaded via `codemirror-loader.js` script tag
- GPT tokenizer bundle loaded via `gpt-tokenizer-bundle.js` script tag
- Typo.js spell checker loaded from `typo.js`
- Dictionary files (en_US.aff, en_US.dic) in `dictionaries/en_US/` directory
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
