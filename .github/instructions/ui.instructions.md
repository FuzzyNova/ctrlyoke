---
applyTo: "src/ui/**"
---

<purpose>
User interface components for status display, workflow monitoring, prompt editing, and template-based workflow creation.
</purpose>

<statusBarManager>
**Responsibilities:**
- Status bar item lifecycle and updates
- Visual feedback for workflow state (icons, colors, tooltips)
- Progress indication during execution
- Auto-hide success messages after 5 seconds

**State visualization:**

- Idle: `$(compass) FlightPath` - default state, ready
- Running: `$(compass-dot) FlightPath N/M` - progress with prominent background
- Paused: `$(debug-pause) FlightPath N/M` - warning background
- Completed: `$(check) FlightPath Complete` - success, auto-hides after 5s
- Error: `$(error) FlightPath Error` - error background

**Icon selection:**

- `$(compass)` - Navigation/direction theme fits "FlightPath" metaphor
- `$(compass-dot)` - Animated feel for running state
- `$(debug-pause)` - Standard VS Code pause icon
- `$(check)` - Clear success indicator
- `$(error)` - Standard VS Code error icon

**Background colors:**

- Prominent: Running and completed (blue)
- Warning: Paused (yellow/orange)
- Error: Error state (red)
- Use ThemeColor for automatic theme adaptation
  </statusBarManager>

<dashboardProvider>
**FlightPathDashboardProvider** - WebView-based visual dashboard

**Responsibilities:**

- WebView lifecycle management (registration, HTML generation, message routing)
- State synchronization (file selection, execution progress, CLI output, prompt editing)
- Template-based HTML rendering with URI placeholders
- Template management for workflow creation
- Completion provider integration for CodeMirror autocomplete
- File operations (open, export, edit)
- Session state persistence and restoration

**Architecture:**

- **HTML Template**: `src/ui/webview/dashboard.html` (copied to `out/ui/webview/`)
- **CSS**:
  - `src/ui/webview/shared.css` (common styles for all FlightPath webviews)
  - `src/ui/webview/dashboard.css` (dashboard-specific layout)
  - `src/ui/webview/custom-icons.css` (auto-generated from SVG icons)
- **JavaScript**:
  - `src/ui/webview/dashboard.js` (UI logic, state management)
  - `src/ui/webview/codemirror-editor.js` (CodeMirror prompt editor)
  - `src/ui/webview/codemirror-loader.js` (CodeMirror bundle loader)
- **Constants**: Shared via `DashboardConstants.ts` (MESSAGE_TYPES, EXECUTION_STATES, etc.)

**Template System:**

- HTML template uses `{{placeholders}}` for URI injection
- `getHtmlContent()` loads template from file and replaces placeholders:
  - `{{cspSource}}` - Content Security Policy nonce
  - `{{constantsUri}}` - DashboardConstants.js bundle
  - `{{scriptUri}}` - dashboard.js
  - `{{styleUri}}` - dashboard.css
  - `{{sharedStyleUri}}` - shared.css
  - `{{customIconsUri}}` - custom-icons.css
  - `{{codiconsUri}}` - VS Code codicons.css
  - `{{codemirrorLoaderUri}}` - CodeMirror loader script
  - `{{affUri}}`, `{{dicUri}}` - Spell check dictionary files
- Fallback error HTML if template fails to load

**Message Flow:**

- Extension → Webview: `postMessage()` with typed messages (MESSAGE_TYPES)
- Webview → Extension: `vscode.postMessage()` triggering VS Code commands via `messageCommandMap`
- State updates: File selection, execution state, step status, CLI output, retry attempts, prompt edits, template selections

**Update Methods (called by FlightPathManager):**

- `updateFileSelected(fileName, prompts)` - File loaded with prompt list
- `updateExecutionStarted(fileName, totalSteps)` - Workflow begins
- `updateProgress(current, total)` - Current/total step counter
- `updateExecutionState(state)` - Running/paused/completed/error
- `updateStepStatus(stepIndex, status, details)` - Individual prompt state changes
- `updateRetryAttempt(stepIndex, currentRetry, maxRetries)` - Retry counter
- `updateCliOutput(stepIndex, output)` - CLI prompt/response with token stats
- `updateCliStreamingChunk(stepIndex, chunk)` - Real-time streaming chunks
- `updateStatusMessage(stepIndex, message, severity)` - Warnings/errors/info messages
- `updateExecutionCompleted()` - Workflow completion
- `updatePromptsExtended(prompts)` - Queue extension notification (dynamic queue)
- `updateSessionRestored(state)` - Session restoration (CLI resume)

**Message Handling (via messageCommandMap):**

- `ready` → Send initial state with model options and templates
- `selectFile` → Execute `flightpath.selectPromptFile`
- `appendFile` → Execute `flightpath.appendFromDashboard`
- `editFile` → Execute `flightpath.editCurrentPromptFile`
- `run` → Execute `flightpath.run`
- `pause/resume/stop` → Execute corresponding commands
- `newWorkflow` → Load templates and open modal
- `templateSelected` → Create workflow from template with variable substitution
- `requestCompletions` → Provide autocomplete for `@file` and `#file` references
- `openFile` → Open file in VS Code editor with optional line selection
- `executePrompt` → Execute single prompt from editor
- `updatePrompt` → Update existing prompt in queue
- `selectPromptForEdit` → Load prompt into editor
- `deletePrompt` → Remove prompt from queue
- `exportOutput` → Save CLI output to markdown file

**Responsive Layout:**

- Adaptive three-panel layout: Prompts + Output + Editor
- Layout modes: Vertical stack (default) or horizontal stack
- Collapsible sections with chevron buttons and icons
- Swap panels feature to reverse output/editor positions
- All controlled via CSS classes and flexbox
  </dashboardProvider>

<webviewFiles>
**dashboard.html** - HTML structure template
- Uses multiple `{{placeholders}}` for all resource URIs
- Loaded at runtime and placeholders replaced with actual webview URIs
- Three-panel layout: Prompts + Output + Editor
- Modal dialog for template-based workflow creation
- Property drawer for prompt configuration
- Single source template (not inline in TypeScript)

**shared.css** - Shared base styles

- VS Code theme integration (`--vscode-*` CSS variables)
- Common spacing, colors, and component styles
- Loaded first in all FlightPath webviews
- Defines base button, input, and form control styles

**dashboard.css** - Dashboard-specific styling

- Extends shared.css with layout-specific rules
- Responsive three-panel layout with flexbox
- Layout modes: vertical stack, horizontal stack, swapped
- Collapsible sections with animations
- State-based styling (execution states, step statuses)
- Syntax highlighting for CLI output (blue prompts, green responses)
- Modal dialog styling
- Property drawer slide-in panel

**custom-icons.css** - Custom icon definitions

- Auto-generated from SVG files in `src/ui/icons/`
- Icons embedded as data URIs for CSP compliance
- Includes custom icons like "append" that aren't in codicons

**dashboard.js** - UI logic and state management

- Imports MESSAGE_TYPES, EXECUTION_STATES from FlightPathConstants
- State management for file selection, execution progress, CLI outputs, editor state
- DOM manipulation for real-time updates
- Event handlers for user interactions (Run, Pause, Stop, Select, Edit, etc.)
- Autoscroll functionality for output section
- Modal dialog logic for template selection
- Property drawer controls for prompt configuration
- CodeMirror editor integration

**codemirror-editor.js** - CodeMirror prompt editor

- Modern text editor with autocomplete, spell check, and link navigation
- VS Code theme integration for seamless appearance
- Custom autocomplete for `@file` and `#file` references
- Ctrl+Click link navigation to open files
- Typo.js spell checking with en_US dictionary

**codemirror-loader.js** - CodeMirror bundle loader

- Dynamically loads CodeMirror modules
- Exposes CM global for editor initialization
- Prevents bundle size bloat in main dashboard.js

**DashboardConstants.ts** - Shared constants

- MESSAGE_TYPES: Communication protocol between extension and webview
- EXECUTION_STATES: Workflow execution states (idle, running, paused, etc.)
- STEP_STATUS: Individual prompt statuses (pending, running, completed, failed)
- PROVIDER_IDS: Provider identifiers (copilot-cli, copilot-chat, claude-cli, codex-cli)
- PROMPT_PROPERTIES: Property names for prompts (model, provider, agent, etc.)
- END_CONDITION_PROPERTIES: End condition field names
- Compiled separately to avoid VS Code API dependency in webview context
  </webviewFiles>

<settingsProvider>
**FlightPathSettingsProvider** - Settings panel in FlightPath container

**Responsibilities:**

- Provider and model selection (separate from main Dashboard)
- Dynamic Queue toggle
- Settings persistence to VS Code configuration
- Cross-view synchronization via configuration change events

**Architecture:**

- **HTML Template**: `src/ui/webview/settings.html`
- **CSS**: `src/ui/webview/settings.css` (VS Code theme variables)
- **JavaScript**: `src/ui/webview/settings.js` (UI logic, model options per provider)
- Uses same DashboardConstants.ts for MESSAGE_TYPES

**Multi-View Panel Layout:**

- Dashboard and Settings views display side-by-side in bottom panel
- Each view has native VS Code collapsible header (`>` / `∨` toggle)
- Views are registered as separate webview views in same container

**Model Selection Per Provider:**

- Copilot CLI: Uses `flightpath.copilotCliModel` setting
- Copilot Chat: Uses `flightpath.copilotChatModel` setting
- Claude CLI: Uses `flightpath.claudeCliModel` setting
- Model dropdown updates options dynamically when provider changes

**Cross-View Sync:**

- Settings changes update VS Code configuration
- Dashboard listens to `vscode.workspace.onDidChangeConfiguration`
- Both views stay in sync via configuration events (not direct messages)

**Order of Precedence:**

1. `model` field in `.prompt.json` or `.flightpath.json` file
2. Settings view selection (backed by VS Code setting)
   </settingsProvider>

<importantContext>
**Progress calculation:**
- `calculateProgress()` returns `{ current, total, percentage }`
- Current = prompts completed (not prompts sent)
- Total = all prompts in queue (can grow with dynamic queue)
- Displayed as "N/M" counter in header and prompt section

**Auto-hide behavior:**

- Success message shows for 5 seconds then reverts to idle
- Prevents status bar clutter after workflow completes
- Error messages do NOT auto-hide (user must acknowledge)

**Build process:**

- `copyWebviewPlugin` in esbuild.js copies all `src/ui/webview/*` to `out/ui/webview/`
- HTML template must be present in output directory for runtime loading
- Constants compiled separately as standalone bundle (no VS Code imports)
- Custom icons CSS auto-generated from SVG sources during build
- CodeMirror bundle pre-built and copied to output

**Icon system:**

- NEVER use raw emoji characters (🔄, ✅, ❌, 📁, etc.) in dashboard HTML/CSS/JS
- Emojis cannot be styled or colored to match VS Code themes
- ALWAYS use codicons for icons - they inherit VS Code theme colors perfectly
- Codicon usage:
  - Include codicon.css via `{{codiconsUri}}` placeholder in HTML template
  - Use `<i class="codicon codicon-{name}"></i>` for icons
  - Status icons: `codicon-circle-outline` (pending), `codicon-play` (running), `codicon-pass` (completed), `codicon-error` (failed)
  - Actions: `codicon-refresh` (retry), `codicon-arrow-right` (path/arrow)
  - Layout: `codicon-split-vertical`, `codicon-split-horizontal`, `codicon-arrow-swap`
  - See https://microsoft.github.io/vscode-codicons/dist/codicon.html for full icon list
- Text symbols (→, ↻, etc.) are acceptable for CSS ::before/::after content where codicons cannot be used
- Custom icons (append, etc.) use data URI embedded CSS from `custom-icons.css`

**Editor state persistence:**

- Editor text and properties saved to VS Code memento
- Debounced saves (500ms) to avoid excessive writes
- State restored when dashboard reloads
- Cleared when new file loaded

**Template management:**

- Templates loaded from `src/templates/workflows/` and `.flightpath/templates/`
- Manifest file (`manifest.json`) defines metadata and variable schemas
- Variable substitution with `{placeholder}` syntax
- Default template preference stored in VS Code settings

**Completion provider:**

- Integrated with CompletionHelpers.ts for file and selection autocomplete
- Triggers on `@` and `#file:` in CodeMirror editor
- Provides workspace files, current file selections, and common patterns

**Session restoration:**

- CLI mode supports session resume after crashes/restarts
- Dashboard calls `updateSessionRestored()` with full state
- Restores prompts, outputs, execution state, and current step
- User can continue from where they left off

**Dynamic queue support:**

- Copilot can extend queue by modifying `.flightpath.yaml` or `.flightpath.json`
- Dashboard notified via `updatePromptsExtended()` message
- Shows notification and updates prompt counter
- New prompts appended to existing queue during execution
  </importantContext>

<relatedFiles>
- `../flightpath/FlightPathManager.ts` - Updates dashboard on queue state changes, calls update methods
- `../flightpath/PromptQueue.ts` - Emits state change events
- `../flightpath/TemplateManager.ts` - Provides workflow templates and variable substitution
- `../completions/CompletionHelpers.ts` - Provides autocomplete suggestions for CodeMirror
- `../types/FlightPathTypes.ts` - QueueState interface defines status values
- `../types/DashboardConstants.ts` - Shared constants between extension and webview
- `../utils/ModelRegistry.ts` - Provides available model options per provider
- `../utils/ConfigurationUtils.ts` - Settings access for dashboard state
</relatedFiles>
