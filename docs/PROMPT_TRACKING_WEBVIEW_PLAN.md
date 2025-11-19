# FlightPath WebView Dashboard - Implementation Plan

**Status**: ✅ Implemented  
**Design**: WebView Panel with Rich Execution Dashboard  
**Target**: Bottom panel (alongside Terminal, Output, etc.)

---

## 🎯 Core Requirements

Build a WebView-based tracking UI that provides:

1. **Prompt file selection** - Browse `.prompt.json`, `.flightpath.json`, `.prompt.md` files ✅
2. **Execution controls** - Run, pause, resume, stop buttons ✅
3. **Real-time progress** - Visual progress bars, step indicators ✅
4. **CLI output display** - Show prompts/responses/statistics inline ✅
5. **Status visualization** - Icons, colors, expandable details per prompt step ✅

**Key Constraint**: NO prompt editing in UI - users edit files in main VS Code editor.

---

## 📐 UI Layout

**Wide Panel (>= 800px)** - Side-by-side layout:

````
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ FlightPath                                              [CLI ▼] [▶][⏸][⏹]           │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 🚀 test-workflow.flightpath.json                                       [Change] │ │
│ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2/5 (40%)                 │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│ ┌─ Prompts ────────────────────┬─ CLI Output (Live) ──────────────────────────────┐ │
│ │ ✅ 1. Analyze codebase       │ [Prompt 2] Generate improvement suggestions      │ │
│ │    End condition: ✓ Passed   │                                                  │ │
│ │    Duration: 12.3s           │ Based on the analysis, here are key improvements:│ │
│ │                              │ 1. Refactor FlightPathManager to reduce          │ │
│ │ ▶️ 2. Generate improvements  │    coupling...                                   │ │
│ │    Status: In Progress...    │ 2. Extract validation logic to separate module...│ │
│ │    Elapsed: 5.8s             │ 3. Implement event-driven communication pattern  │ │
│ │                              │                                                  │ │
│ │ ⏸️ 3. Review generated code  │ Here's how to refactor the FlightPathManager:    │ │
│ │ ⏸️ 4. Apply fixes            │ ```typescript                                    │ │
│ │ ⏸️ 5. Generate documentation │ class ValidationService {                        │ │
│ │                              │   validate(data) { ... }                         │ │
│ │                              │ }                                                │ │
│ │                              │ ```                                              │ │
│ │                              │                                                  │ │
│ │                              │ ⏱️ Response time: 5.8s                            │ │
│ │                              │ 📊 Tokens: 1,234 prompt / 2,456 completion       │ │
│ └──────────────────────────────┴──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
````

**Narrow Panel (< 800px)** - Stacked layout:

```
┌─────────────────────────────────────────────────────────────────┐
│ FlightPath                                    [CLI ▼] [▶][⏸][⏹] │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🚀 test-workflow.flightpath.json                   [Change] │ │
│ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2/5 (40%)                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ Prompts ──────────────────────────────────────────────────┐ │
│ │ ✅ 1. Analyze codebase structure                           │ │
│ │    End condition: ✓ Passed (check_analysis.py)            │ │
│ │    Duration: 12.3s                                         │ │
│ │                                                            │ │
│ │ ▶️ 2. Generate improvement suggestions [In Progress]       │ │
│ │    Status: Waiting for Copilot response...                │ │
│ │    Elapsed: 5.8s                                           │ │
│ │                                                            │ │
│ │ ⏸️ 3. Review generated code                                │ │
│ │ ⏸️ 4. Apply fixes                                          │ │
│ │ ⏸️ 5. Generate documentation                               │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ CLI Output (Live) ────────────────────────────────────────┐ │
│ │ [Prompt 2] Generate improvement suggestions                │ │
│ │                                                            │ │
│ │ Based on the analysis, here are key improvements:         │ │
│ │ 1. Refactor FlightPathManager to reduce coupling...       │ │
│ │ 2. Extract validation logic to separate module...         │ │
│ │                                                            │ │
│ │ ⏱️ Response time: 5.8s                                      │ │
│ │ 📊 Tokens: 1,234 prompt / 2,456 completion                 │ │
│ └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Architecture

### Components to Create

1. **`src/ui/FlightPathDashboardProvider.ts`** - WebviewViewProvider implementation
2. **`src/ui/webview/dashboard.html`** - HTML template
3. **`src/ui/webview/dashboard.css`** - Styles with VS Code theme variables
4. **`src/ui/webview/dashboard.js`** - Client-side logic
5. **Update `package.json`** - Register view container and view
6. **Update `extension.ts`** - Register provider on activation

### Message Protocol (Extension ↔ WebView)

**Extension → WebView** (State updates):

```typescript
type MessageToWebview =
  | { type: "init"; data: DashboardState }
  | { type: "fileSelected"; fileName: string; prompts: PromptStep[] }
  | { type: "executionStarted"; fileName: string; totalSteps: number }
  | { type: "progressUpdate"; current: number; total: number }
  | {
      type: "stepStatusChanged";
      stepIndex: number;
      status: StepStatus;
      details?: StepDetails;
    }
  | { type: "cliOutput"; stepIndex: number; output: CliOutputData };

interface StepStatus {
  state: "pending" | "running" | "completed" | "failed";
  message?: string;
  duration?: number;
  endConditionResult?: EndConditionResult;
}

interface CliOutputData {
  prompt: string;
  response?: string;
  tokens?: { prompt: number; completion: number };
  elapsed: number;
}
```

**WebView → Extension** (User actions):

```typescript
type MessageToExtension =
  | { type: "selectFile" }
  | { type: "run" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "showOutput"; stepIndex: number }
  | { type: "ready" }; // Webview loaded
```

---

## 📝 Implementation Steps

### Step 1: Package.json Configuration

Add view container and view registration:

```json
{
  "contributes": {
    "viewsContainers": {
      "panel": [
        {
          "id": "flightpath",
          "title": "FlightPath",
          "icon": "$(rocket)"
        }
      ]
    },
    "views": {
      "flightpath": [
        {
          "type": "webview",
          "id": "flightpath.dashboard",
          "name": "Dashboard"
        }
      ]
    }
  }
}
```

### Step 2: FlightPathDashboardProvider

Create `src/ui/FlightPathDashboardProvider.ts`:

```typescript
import * as vscode from "vscode";
import * as path from "path";

export class FlightPathDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out", "ui", "webview"),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });

    // Send initial state when webview is ready
    this.sendInitialState();
  }

  private handleWebviewMessage(message: any): void {
    switch (message.type) {
      case "ready":
        this.sendInitialState();
        break;
      case "selectFile":
        vscode.commands.executeCommand("flightpath.selectPromptFile");
        break;
      case "run":
        vscode.commands.executeCommand("flightpath.run");
        break;
      case "pause":
        vscode.commands.executeCommand("flightpath.pause");
        break;
      case "resume":
        vscode.commands.executeCommand("flightpath.resume");
        break;
      case "stop":
        vscode.commands.executeCommand("flightpath.stop");
        break;
      case "showOutput":
        vscode.commands.executeCommand("flightpath.showOutputPanel");
        break;
    }
  }

  // Public methods to send updates from FlightPathManager
  public updateFileSelected(fileName: string, prompts: any[]): void {
    this.postMessage({ type: "fileSelected", fileName, prompts });
  }

  public updateExecutionStarted(fileName: string, totalSteps: number): void {
    this.postMessage({ type: "executionStarted", fileName, totalSteps });
  }

  public updateProgress(current: number, total: number): void {
    this.postMessage({ type: "progressUpdate", current, total });
  }

  public updateStepStatus(stepIndex: number, status: any, details?: any): void {
    this.postMessage({ type: "stepStatusChanged", stepIndex, status, details });
  }

  public updateCliOutput(stepIndex: number, output: any): void {
    this.postMessage({ type: "cliOutput", stepIndex, output });
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private sendInitialState(): void {
    // Get current state from FlightPathManager and send to webview
    this.postMessage({ type: "init", data: this.getCurrentState() });
  }

  private getCurrentState(): any {
    // TODO: Integrate with FlightPathManager to get actual state
    return {
      fileName: null,
      prompts: [],
      executionState: "idle",
      currentStep: 0,
      totalSteps: 0,
    };
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview",
        "dashboard.js"
      )
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview",
        "dashboard.css"
      )
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>FlightPath Dashboard</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <div id="file-info">
        <span id="file-name">No file selected</span>
        <button id="change-file" class="btn-secondary">Change</button>
      </div>
      <div id="controls">
        <button id="btn-run" class="btn-primary" title="Run">▶</button>
        <button id="btn-pause" class="btn-secondary" title="Pause" disabled>⏸</button>
        <button id="btn-stop" class="btn-secondary" title="Stop" disabled>⏹</button>
      </div>
    </div>

    <div id="progress-container" style="display: none;">
      <div id="progress-bar">
        <div id="progress-fill"></div>
        <span id="progress-text">0/0 (0%)</span>
      </div>
    </div>

    <div id="main-content">
      <div id="prompts-section">
        <h3>Prompts</h3>
        <div id="prompts-list"></div>
      </div>

      <div id="output-section" style="display: none;">
        <h3>CLI Output (Live)</h3>
        <div id="output-content"></div>
      </div>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
```

### Step 3: WebView Client Script

Create `src/ui/webview/dashboard.js`:

```javascript
(function () {
  const vscode = acquireVsCodeApi();

  // State management
  let state = {
    fileName: null,
    prompts: [],
    executionState: "idle",
    currentStep: 0,
    totalSteps: 0,
    cliOutputs: {},
  };

  // DOM elements
  const elements = {
    fileName: document.getElementById("file-name"),
    changeFileBtn: document.getElementById("change-file"),
    runBtn: document.getElementById("btn-run"),
    pauseBtn: document.getElementById("btn-pause"),
    stopBtn: document.getElementById("btn-stop"),
    progressContainer: document.getElementById("progress-container"),
    progressFill: document.getElementById("progress-fill"),
    progressText: document.getElementById("progress-text"),
    promptsList: document.getElementById("prompts-list"),
    outputSection: document.getElementById("output-section"),
    outputContent: document.getElementById("output-content"),
  };

  // Event listeners
  elements.changeFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "selectFile" });
  });

  elements.runBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "run" });
  });

  elements.pauseBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "pause" });
  });

  elements.stopBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "stop" });
  });

  // Message handler
  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case "init":
        handleInit(message.data);
        break;
      case "fileSelected":
        handleFileSelected(message.fileName, message.prompts);
        break;
      case "executionStarted":
        handleExecutionStarted(message.fileName, message.totalSteps);
        break;
      case "progressUpdate":
        handleProgressUpdate(message.current, message.total);
        break;
      case "stepStatusChanged":
        handleStepStatusChanged(
          message.stepIndex,
          message.status,
          message.details
        );
        break;
      case "cliOutput":
        handleCliOutput(message.stepIndex, message.output);
        break;
    }
  });

  function handleInit(data) {
    state = { ...state, ...data };
    render();
  }

  function handleFileSelected(fileName, prompts) {
    state.fileName = fileName;
    state.prompts = prompts.map((p, i) => ({
      index: i,
      text: p.prompt || p,
      status: "pending",
      details: {},
    }));
    render();
  }

  function handleExecutionStarted(fileName, totalSteps) {
    state.executionState = "running";
    state.totalSteps = totalSteps;
    state.currentStep = 0;
    updateControls();
    elements.progressContainer.style.display = "block";
  }

  function handleProgressUpdate(current, total) {
    state.currentStep = current;
    state.totalSteps = total;

    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    elements.progressFill.style.width = `${percentage}%`;
    elements.progressText.textContent = `${current}/${total} (${percentage}%)`;
  }

  function handleStepStatusChanged(stepIndex, status, details) {
    if (state.prompts[stepIndex]) {
      state.prompts[stepIndex].status = status.state;
      state.prompts[stepIndex].details = { ...status, ...details };
      renderPromptsList();
    }
  }

  function handleCliOutput(stepIndex, output) {
    state.cliOutputs[stepIndex] = output;
    if (stepIndex === state.currentStep) {
      renderCliOutput(output);
    }
  }

  function render() {
    elements.fileName.textContent = state.fileName || "No file selected";
    renderPromptsList();
    updateControls();
  }

  function renderPromptsList() {
    if (state.prompts.length === 0) {
      elements.promptsList.innerHTML =
        '<p class="empty-state">No prompts loaded</p>';
      return;
    }

    elements.promptsList.innerHTML = state.prompts
      .map((prompt) => {
        const icon = getStatusIcon(prompt.status);
        const statusClass = `prompt-item status-${prompt.status}`;

        let detailsHtml = "";
        if (prompt.details.duration) {
          detailsHtml += `<div class="prompt-detail">Duration: ${prompt.details.duration}s</div>`;
        }
        if (prompt.details.endConditionResult) {
          const result = prompt.details.endConditionResult;
          const resultIcon = result.passed ? "✓" : "✗";
          detailsHtml += `<div class="prompt-detail">End condition: ${resultIcon} ${result.message || ""}</div>`;
        }
        if (prompt.details.message) {
          detailsHtml += `<div class="prompt-status-msg">${prompt.details.message}</div>`;
        }

        return `
        <div class="${statusClass}">
          <div class="prompt-header">
            <span class="prompt-icon">${icon}</span>
            <span class="prompt-text">${prompt.index + 1}. ${truncate(prompt.text, 60)}</span>
          </div>
          ${detailsHtml}
        </div>
      `;
      })
      .join("");
  }

  function renderCliOutput(output) {
    elements.outputSection.style.display = "block";

    let html = `<div class="cli-output-item">`;
    html += `<div class="output-header">[Prompt ${state.currentStep + 1}]</div>`;

    if (output.prompt) {
      html += `<div class="output-prompt">${escapeHtml(output.prompt)}</div>`;
    }

    if (output.response) {
      html += `<div class="output-response">${escapeHtml(output.response)}</div>`;
    }

    if (output.tokens) {
      html += `<div class="output-stats">📊 Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion</div>`;
    }

    html += `<div class="output-stats">⏱️ ${output.elapsed}s</div>`;
    html += `</div>`;

    elements.outputContent.innerHTML = html;
  }

  function updateControls() {
    const isRunning = state.executionState === "running";
    const hasFile = state.fileName !== null;

    elements.runBtn.disabled = !hasFile || isRunning;
    elements.pauseBtn.disabled = !isRunning;
    elements.stopBtn.disabled = !isRunning;
  }

  function getStatusIcon(status) {
    const icons = {
      pending: "⏸️",
      running: "▶️",
      completed: "✅",
      failed: "❌",
    };
    return icons[status] || "⏸️";
  }

  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Signal ready
  vscode.postMessage({ type: "ready" });
})();
```

### Step 4: WebView Styles

Create `src/ui/webview/dashboard.css`:

```css
:root {
  --bg-primary: var(--vscode-editor-background);
  --bg-secondary: var(--vscode-sideBar-background);
  --fg-primary: var(--vscode-editor-foreground);
  --fg-secondary: var(--vscode-descriptionForeground);
  --border-color: var(--vscode-panel-border);
  --status-success: var(--vscode-testing-iconPassed);
  --status-error: var(--vscode-testing-iconFailed);
  --status-pending: var(--vscode-descriptionForeground);
  --status-running: var(--vscode-progressBar-background);
}

body {
  margin: 0;
  padding: 12px;
  color: var(--fg-primary);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

#app {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

#header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

#file-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

#file-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#controls {
  display: flex;
  gap: 6px;
}

button {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  font-size: 14px;
}

button:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

#progress-container {
  padding: 0 12px;
}

#progress-bar {
  position: relative;
  height: 24px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow: hidden;
}

#progress-fill {
  position: absolute;
  height: 100%;
  background: var(--status-running);
  transition: width 0.3s ease;
}

#progress-text {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-weight: 600;
  z-index: 1;
}

/* Responsive main content area */
#main-content {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

/* Wide layout: side-by-side (>= 800px) */
@media (min-width: 800px) {
  #main-content {
    flex-wrap: nowrap;
  }

  #prompts-section {
    flex: 0 0 350px;
    min-width: 300px;
  }

  #output-section {
    flex: 1;
    min-width: 400px;
  }
}

/* Narrow layout: stacked (< 800px) */
@media (max-width: 799px) {
  #main-content {
    flex-direction: column;
  }

  #prompts-section,
  #output-section {
    flex: 1;
    width: 100%;
  }
}

#prompts-section,
#output-section {
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-secondary);
}

#prompts-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prompt-item {
  padding: 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

.prompt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.prompt-icon {
  font-size: 16px;
}

.prompt-detail {
  margin-top: 6px;
  font-size: 12px;
  color: var(--fg-secondary);
  padding-left: 24px;
}

.prompt-status-msg {
  margin-top: 6px;
  font-size: 12px;
  font-style: italic;
  padding-left: 24px;
}

.status-completed .prompt-icon {
  color: var(--status-success);
}

.status-failed .prompt-icon {
  color: var(--status-error);
}

.status-running .prompt-icon {
  color: var(--status-running);
}

.status-pending .prompt-icon {
  color: var(--status-pending);
}

.empty-state {
  text-align: center;
  color: var(--fg-secondary);
  font-style: italic;
  padding: 20px;
}

#output-content {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}

.cli-output-item {
  background: var(--bg-primary);
  padding: 12px;
  border-radius: 4px;
}

.output-header {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--fg-secondary);
}

.output-prompt,
.output-response {
  padding: 8px;
  margin: 8px 0;
  border-left: 3px solid var(--border-color);
  white-space: pre-wrap;
  word-wrap: break-word;
}

.output-prompt {
  background: rgba(100, 100, 255, 0.1);
  border-left-color: rgb(100, 100, 255);
}

.output-response {
  background: rgba(100, 255, 100, 0.1);
  border-left-color: rgb(100, 255, 100);
}

.output-stats {
  font-size: 11px;
  color: var(--fg-secondary);
  margin-top: 4px;
}
```

### Step 5: Extension Registration

Update `src/extension.ts`:

```typescript
import { FlightPathDashboardProvider } from "./ui/FlightPathDashboardProvider";

export function activate(context: vscode.ExtensionContext) {
  // ... existing code ...

  // Register dashboard provider
  const dashboardProvider = new FlightPathDashboardProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "flightpath.dashboard",
      dashboardProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Make provider accessible to FlightPathManager for updates
  // Option 1: Store in context
  context.subscriptions.push({
    dispose: () => {},
    dashboardProvider, // Custom property
  } as any);

  // Option 2: Pass to FlightPathManager constructor
  // const manager = new FlightPathManager(context, dashboardProvider);
}
```

### Step 6: Build Configuration

Update `esbuild.js` to copy webview assets:

```javascript
// Add to esbuild.js
const fs = require("fs");
const path = require("path");

// After main build, copy webview files
fs.mkdirSync("out/ui/webview", { recursive: true });
fs.copyFileSync(
  "src/ui/webview/dashboard.html",
  "out/ui/webview/dashboard.html"
);
fs.copyFileSync("src/ui/webview/dashboard.css", "out/ui/webview/dashboard.css");
fs.copyFileSync("src/ui/webview/dashboard.js", "out/ui/webview/dashboard.js");
```

### Step 7: Integration with FlightPathManager

Update `FlightPathManager` to send state updates to dashboard:

```typescript
export class FlightPathManager {
  private dashboardProvider?: FlightPathDashboardProvider;

  constructor(
    context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathDashboardProvider
  ) {
    this.dashboardProvider = dashboardProvider;
  }

  async executePromptFile(filePath: string) {
    const prompts = await this.parser.parse(filePath);

    // Notify dashboard
    this.dashboardProvider?.updateFileSelected(
      path.basename(filePath),
      prompts
    );
    this.dashboardProvider?.updateExecutionStarted(
      path.basename(filePath),
      prompts.length
    );

    // Execute each prompt
    for (let i = 0; i < prompts.length; i++) {
      this.dashboardProvider?.updateProgress(i + 1, prompts.length);
      this.dashboardProvider?.updateStepStatus(i, { state: "running" });

      try {
        const result = await this.executePrompt(prompts[i]);

        // Update with CLI output
        this.dashboardProvider?.updateCliOutput(i, {
          prompt: prompts[i].prompt,
          response: result.response,
          tokens: result.tokens,
          elapsed: result.duration,
        });

        this.dashboardProvider?.updateStepStatus(i, {
          state: "completed",
          duration: result.duration,
        });
      } catch (error) {
        this.dashboardProvider?.updateStepStatus(i, {
          state: "failed",
          message: error.message,
        });
      }
    }
  }
}
```

---

## 🎨 Theme Integration

Use VS Code CSS variables for automatic theme support:

- `--vscode-editor-background` - Main background
- `--vscode-sideBar-background` - Secondary background
- `--vscode-editor-foreground` - Text color
- `--vscode-descriptionForeground` - Muted text
- `--vscode-panel-border` - Borders
- `--vscode-testing-iconPassed` - Success green
- `--vscode-testing-iconFailed` - Error red
- `--vscode-progressBar-background` - Running blue
- `--vscode-button-background` - Primary button
- `--vscode-button-secondaryBackground` - Secondary button

---

## ✅ Testing Checklist

- [ ] Dashboard loads without errors
- [ ] File selection updates UI
- [ ] Run/pause/stop buttons trigger correct commands
- [ ] Progress bar updates in real-time
- [ ] Prompt status icons change correctly
- [ ] CLI output displays for active prompt
- [ ] Theme changes reflect immediately
- [ ] Webview persists state when hidden (`retainContextWhenHidden`)
- [ ] Message protocol handles all state transitions
- [ ] No console errors in webview developer tools

---

## 🔧 Integration Points

**FlightPathManager** must call these methods:

- `updateFileSelected(fileName, prompts)` - When file is loaded
- `updateExecutionStarted(fileName, totalSteps)` - When execution begins
- `updateProgress(current, total)` - After each step
- `updateStepStatus(stepIndex, status, details)` - On status changes
- `updateCliOutput(stepIndex, output)` - When CLI response received

**Commands to implement**:

- `flightpath.selectPromptFile` - Show quick pick for prompt files
- `flightpath.run` - Start execution
- `flightpath.pause` - Pause execution
- `flightpath.resume` - Resume execution
- `flightpath.stop` - Stop execution
- `flightpath.showOutputPanel` - Open full Output panel

---

## 📊 Performance Considerations

- **Webview retention**: Use `retainContextWhenHidden: true` to preserve state
- **Message batching**: Batch frequent updates (e.g., token streaming) to avoid overwhelming postMessage
- **Output truncation**: Limit CLI output display to last N characters for large responses
- **Lazy rendering**: Only render visible prompts if list becomes very long
- **Responsive layout**: CSS media queries handle layout changes without JavaScript overhead (800px breakpoint)

---

## 🚀 Future Enhancements

- **Syntax highlighting**: Use Monaco editor for CLI output
- **Collapsible sections**: Expand/collapse prompt details
- **Copy to clipboard**: Copy prompt/response text
- **Export results**: Save execution results to JSON
- **Search/filter**: Filter prompts by status
- **Keyboard shortcuts**: Navigate prompts with arrow keys
- **Dark/light mode toggle**: Manual theme override

---

## 📚 Reference Documentation

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [WebviewViewProvider](https://code.visualstudio.com/api/references/vscode-api#WebviewViewProvider)
- [VS Code Theme Colors](https://code.visualstudio.com/api/references/theme-color)
- [Webview Messaging](https://code.visualstudio.com/api/extension-guides/webview#passing-messages-from-an-extension-to-a-webview)

---

**Implementation Time Estimate**: 8-12 hours  
**Priority**: High - Core UX feature for FlightPath  
**Dependencies**: FlightPathManager integration required for live updates
