---
applyTo: "src/ui/webview/**"
---

<purpose>
WebView-based dashboard UI for real-time workflow visualization, execution control, and CLI output monitoring.
</purpose>

<architecture>
**Three-part system:**
1. **FlightPathDashboardProvider** (TypeScript) - VS Code WebView provider, message routing, state management
2. **dashboard.js** (Client-side JavaScript) - DOM manipulation, state rendering, VS Code API communication
3. **dashboard.css** (Styles) - Responsive layout with VS Code theme integration

**Communication flow:**

- Extension → WebView: `postMessage()` with typed message objects
- WebView → Extension: `vscode.postMessage()` triggering command execution
- State synchronization: Bidirectional updates for file selection, execution progress, CLI output
  </architecture>

<flightPathDashboardProvider>
**Responsibilities:**
- Implements `vscode.WebviewViewProvider` for sidebar integration
- HTML generation with secure CSP and local resource URIs
- Message routing between WebView and extension commands
- State updates via public methods called by FlightPathManager
- Initial state hydration on webview ready

**Key public methods (called by FlightPathManager):**

```typescript
updateFileSelected(fileName, prompts); // File selection with prompt list
updateExecutionStarted(fileName, totalSteps); // Workflow start
updateProgress(current, total); // Progress bar updates
updateStepStatus(stepIndex, status, details); // Individual prompt status
updateCliOutput(stepIndex, output); // Complete CLI response
updateCliStreamingChunk(stepIndex, chunk); // Real-time streaming chunks
updateExecutionCompleted(); // Workflow completion
```

**Message handling:**

- `ready` → Send initial state
- `selectFile` → Execute `flightpath.selectPromptFile`
- `run` → Execute `flightpath.run`
- `pause/resume/stop` → Execute corresponding commands
- `showOutput` → Execute `flightpath.showOutputPanel`

**Security:**

- `enableScripts: true` for interactive UI
- `localResourceRoots` restricted to `out/ui/webview/`
- CSP headers via `webview.asWebviewUri()` for script/style loading
  </flightPathDashboardProvider>

<dashboardJS>
**Client-side state management:**
```javascript
state = {
  fileName: string | null,
  prompts: Array<{index, text, status, details}>,
  executionState: 'idle' | 'running' | 'completed',
  currentStep: number,
  totalSteps: number,
  cliOutputs: { [stepIndex]: output }
}
```

**Message handlers:**

- `init` → Hydrate initial state
- `fileSelected` → Update file, prompts, reset execution state
- `executionStarted` → Show progress bar, update state
- `progressUpdate` → Update progress percentage
- `stepStatusChanged` → Update prompt item status/details
- `cliOutput` → Store and render complete CLI response
- `cliStreamingChunk` → Append chunk to response, render if current step
- `executionCompleted` → Update state, enable re-run button

**Rendering functions:**

- `render()` → Top-level orchestrator
- `renderPromptsList()` → Prompt items with status icons, details
- `renderCliOutput(output)` → CLI prompt/response with syntax highlighting intent
- `updateControls()` → Enable/disable buttons based on state

**Status icons:**

- Pending: ⏸️
- Running: ▶️
- Completed: ✅
- Failed: ❌

**Controls logic:**

- Run button: Enabled if file selected AND (not running OR completed)
- Re-run mode: Show ↻ icon and "Re-run" tooltip when completed
- Pause/Stop: Enabled only when running

**CLI output rendering:**

- Show prompt text (blue-tinted background)
- Show response text (green-tinted background)
- Show token statistics (if available)
- Show elapsed time
- Streaming indicator: `⬤ Streaming...` during active streaming
- Auto-scroll during streaming
- Empty state: "CLI output will appear here during execution"

**Important behaviors:**

- File selection resets execution state and progress (prevents stale data)
- CLI output only renders for `currentStep - 1` (most recently completed step)
- Streaming chunks accumulate in `cliOutputs[stepIndex].response`
  </dashboardJS>

<dashboardCSS>
**Responsive layout:**
- Wide (≥800px): Side-by-side layout, prompts (350px fixed) + output (flexible)
- Narrow (<800px): Stacked layout, both sections flexible height

**VS Code theme integration:**

```css
--bg-primary: var(--vscode-editor-background)
  --bg-secondary: var(--vscode-sideBar-background)
  --fg-primary: var(--vscode-editor-foreground)
  --status-success: var(--vscode-testing-iconPassed)
  --status-error: var(--vscode-testing-iconFailed)
  --status-running: var(--vscode-progressBar-background);
```

**Layout structure:**

```
#app (flexbox column, 100vh)
├── #header (fixed height, file info + controls)
├── #progress-container (fixed height, conditionally shown)
└── #main-content (flex:1, responsive split)
    ├── #prompts-section (scrollable list)
    └── #output-section (scrollable CLI output)
```

**Key styling patterns:**

- Scrollable sections: `flex:1` + `min-height:0` + `overflow-y:auto`
- Status colors: Applied via `.status-{completed|failed|running|pending}` classes
- Progress bar: Animated `transition: width 0.3s ease`
- CLI output: `pre-wrap` + `word-wrap` for long text handling
- Border-left indicators: 3px colored bars for prompt/response differentiation

**Re-run button styling:**

- Uses `.btn-rerun` class with primary button colors
- Larger font (16px) and bold weight for ↻ icon
- Same hover states as primary buttons
  </dashboardCSS>

<integrationWithFlightPathManager>
**Dashboard lifecycle:**
1. FlightPathManager registers dashboard provider in `extension.ts`
2. User opens FlightPath sidebar view (or it auto-opens)
3. WebView sends `ready` message → Provider sends initial state
4. User selects file → Manager calls `updateFileSelected()`
5. User clicks Run → WebView sends `run` message → Manager executes workflow
6. During execution:
   - Manager calls `updateExecutionStarted()` before first prompt
   - Manager calls `updateStepStatus()` when prompt starts/completes/fails
   - Manager calls `updateProgress()` after each step completes
   - Manager calls `updateCliOutput()` OR `updateCliStreamingChunk()` for CLI responses
   - Manager calls `updateExecutionCompleted()` after final prompt
7. WebView renders updates in real-time

**CLI output flow (streaming):**

```
CopilotCommandLineIntegration streams chunk
→ FlightPathManager receives chunk in onResponseChunk
→ Manager calls dashboardProvider.updateCliStreamingChunk(stepIndex, chunk)
→ DashboardProvider sends { type: 'cliStreamingChunk', stepIndex, chunk }
→ dashboard.js appends chunk to state.cliOutputs[stepIndex].response
→ If current step, renderCliOutput() updates display with accumulated text
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

**State synchronization:**

- Dashboard state is derived from FlightPathManager state
- No independent state mutations (single source of truth in Manager)
- WebView never sends state updates, only command triggers
  </integrationWithFlightPathManager>

<futureEnhancements>
- Multi-step CLI output history (currently shows only current step)
- Execution history with replay capability
- Log filtering and search
- Export execution reports
- Prompt editing within dashboard
- Retry failed steps from UI
- Syntax highlighting for code blocks in responses
- Collapsible prompt details
- Keyboard shortcuts for controls
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

**Debugging tips:**

- WebView console: Right-click webview → "Open WebView Developer Tools"
- Message flow: Add `console.log()` in both provider and dashboard.js
- State inspection: Use `vscode.postMessage({ type: 'debug', state })` pattern

**Performance considerations:**

- Streaming chunks: Batch renders to avoid excessive DOM updates (consider debouncing)
- Large responses: Consider virtual scrolling for very long CLI outputs
- History: Limit stored CLI outputs to prevent memory bloat

**Accessibility:**

- Ensure all buttons have proper `title` attributes
- Use semantic HTML for screen reader support
- Maintain keyboard navigation (tab order)
- Status colors should have text fallbacks (not color-only indication)
  </importantContext>
