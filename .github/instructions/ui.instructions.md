---
applyTo: "src/ui/**"
---

<purpose>
User interface components for status display and workflow monitoring.
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

- WebView lifecycle management (registration, HTML generation)
- Message routing between extension and webview
- State synchronization (file selection, execution progress, CLI output)
- Template-based HTML rendering

**Architecture:**

- **HTML Template**: `src/ui/webview/dashboard.html` (copied to `out/ui/webview/`)
- **CSS**: `src/ui/webview/dashboard.css` (VS Code theme variables)
- **JavaScript**: `src/ui/webview/dashboard.js` (UI logic, state management)
- **Constants**: Shared via `DashboardConstants.ts` (MESSAGE_TYPES, EXECUTION_STATES)

**Template System:**

- HTML template uses `{{placeholders}}` for URI injection
- `getHtmlContent()` loads template from file and replaces placeholders
- CSP (Content Security Policy) configured via `{{cspSource}}`
- Fallback error HTML if template fails to load

**Message Flow:**

- Extension → Webview: `postMessage()` with typed messages (MESSAGE_TYPES)
- Webview → Extension: `vscode.postMessage()` triggering VS Code commands
- State updates: File selection, execution state, step status, CLI output, retry attempts

**Update Methods:**

- `updateFileSelected()` - Prompt file loaded
- `updateExecutionStarted()` - Workflow begins
- `updateProgress()` - Current/total step counter
- `updateExecutionState()` - Running/paused/completed/error
- `updateStepStatus()` - Individual prompt state changes
- `updateRetryAttempt()` - Retry counter for failed validations
- `updateCliOutput()` - CLI prompt/response with token stats
- `updateStatusMessage()` - Status text for current step

**Responsive Layout:**

- Wide (>= 800px): Side-by-side prompts and output
- Narrow (< 800px): Stacked vertical layout
- Flexbox-based with CSS media queries
  </dashboardProvider>

<webviewFiles>
**dashboard.html** - HTML structure template
- Uses `{{constantsUri}}`, `{{scriptUri}}`, `{{styleUri}}`, `{{cspSource}}` placeholders
- Loaded at runtime and placeholders replaced with actual webview URIs
- Single source template (not inline in TypeScript)

**dashboard.css** - Styling

- VS Code theme integration (`--vscode-*` CSS variables)
- Responsive grid layout with media queries
- State-based styling (execution states, step statuses)
- Syntax highlighting for CLI output (blue prompts, green responses)

**dashboard.js** - UI logic

- Imports MESSAGE_TYPES, EXECUTION_STATES from FlightPathConstants
- State management for file selection, execution progress, CLI outputs
- DOM manipulation for real-time updates
- Event handlers for user interactions (Run, Pause, Stop, Select)
- Autoscroll functionality for output section

**DashboardConstants.ts** - Shared constants

- MESSAGE_TYPES: Communication protocol between extension and webview
- EXECUTION_STATES: Workflow execution states (idle, running, paused, etc.)
- STEP_STATUS: Individual prompt statuses (pending, running, completed, failed)
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
- Current = items completed (not items sent)
- Total = all items in queue
- Percentage for future progress bar visualization

**Auto-hide behavior:**

- Success message shows for 5 seconds then reverts to idle
- Prevents status bar clutter after workflow completes
- Error messages do NOT auto-hide (user must acknowledge)

**Build process:**

- `copyWebviewPlugin` in esbuild.js copies all `src/ui/webview/*` to `out/ui/webview/`
- HTML template must be present in output directory for runtime loading
- Constants compiled separately as standalone bundle (no VS Code imports)

**Emoji and icon policy:**

- NEVER use raw emoji characters (🔄, ✅, ❌, 📁, etc.) in dashboard HTML/CSS/JS
- Emojis cannot be styled or colored to match VS Code themes
- ALWAYS use text symbols or Unicode characters instead:
  - Status icons: ○ (pending), ▶ (running), ✓ (completed), ✗ (failed)
  - Actions: ↻ (retry/restart), → (arrow/path), ⏸ (pause), ⏹ (stop)
- These symbols inherit VS Code theme colors and maintain visual consistency
- Use codicons via CSS classes when available for VS Code native icons
  </importantContext>

<relatedFiles>
- `../flightpath/FlightPathManager.ts` - Updates status bar on queue state changes
- `../flightpath/PromptQueue.ts` - Emits state change events
- `../types/FlightPathTypes.ts` - QueueState interface defines status values
</relatedFiles>
