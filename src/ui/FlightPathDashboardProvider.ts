import * as vscode from "vscode";
import * as path from "path";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../types/DashboardConstants";

export class FlightPathDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private flightPathManager?: any; // Reference to manager (set after construction to avoid circular dependency)

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
      case MESSAGE_TYPES.READY:
        this.sendInitialState();
        break;
      case MESSAGE_TYPES.SELECT_FILE:
        vscode.commands.executeCommand("flightpath.selectPromptFile");
        break;
      case MESSAGE_TYPES.EDIT_FILE:
        vscode.commands.executeCommand("flightpath.editCurrentPromptFile");
        break;
      case MESSAGE_TYPES.RUN:
        vscode.commands.executeCommand("flightpath.run");
        break;
      case MESSAGE_TYPES.PAUSE:
        vscode.commands.executeCommand("flightpath.pause");
        break;
      case MESSAGE_TYPES.RESUME:
        vscode.commands.executeCommand("flightpath.resume");
        break;
      case MESSAGE_TYPES.STOP:
        vscode.commands.executeCommand("flightpath.stop");
        break;
      case MESSAGE_TYPES.SHOW_OUTPUT:
        vscode.commands.executeCommand("flightpath.showOutputPanel");
        break;
    }
  }

  // Public methods to send updates from FlightPathManager
  public updateFileSelected(fileName: string, prompts: any[]): void {
    this.postMessage({ type: MESSAGE_TYPES.FILE_SELECTED, fileName, prompts });
  }

  public updateExecutionStarted(fileName: string, totalSteps: number): void {
    this.postMessage({
      type: MESSAGE_TYPES.EXECUTION_STARTED,
      fileName,
      totalSteps,
    });
  }

  public updateProgress(current: number, total: number): void {
    this.postMessage({ type: MESSAGE_TYPES.PROGRESS_UPDATE, current, total });
  }

  public updateExecutionState(state: string): void {
    this.postMessage({ type: MESSAGE_TYPES.EXECUTION_STATE_CHANGED, state });
  }

  public updateStepStatus(stepIndex: number, status: any, details?: any): void {
    this.postMessage({
      type: MESSAGE_TYPES.STEP_STATUS_CHANGED,
      stepIndex,
      status,
      details,
    });
  }

  public updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED,
      stepIndex,
      currentRetry,
      maxRetries,
    });
  }

  public updateCliOutput(stepIndex: number, output: any): void {
    console.log(
      `📊 DashboardProvider: Sending CLI output for step ${stepIndex}`,
      output
    );
    this.postMessage({ type: MESSAGE_TYPES.CLI_OUTPUT, stepIndex, output });
  }

  public updateCliStreamingChunk(stepIndex: number, chunk: string): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_STREAMING_CHUNK,
      stepIndex,
      chunk,
    });
  }

  public updateStatusMessage(stepIndex: number, message: string): void {
    this.postMessage({
      type: MESSAGE_TYPES.STATUS_MESSAGE,
      stepIndex,
      message,
    });
  }

  public updateExecutionCompleted(): void {
    this.postMessage({ type: MESSAGE_TYPES.EXECUTION_COMPLETED });
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Set FlightPathManager reference (called after construction to avoid circular dependency)
   */
  public setFlightPathManager(manager: any): void {
    this.flightPathManager = manager;
  }

  private sendInitialState(): void {
    // Get current state from FlightPathManager and send to webview
    this.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: this.getCurrentState(),
    });
  }

  private getCurrentState(): any {
    // Get actual state from FlightPathManager if available
    if (this.flightPathManager) {
      const queueState = this.flightPathManager.getQueueState();
      const currentFile = this.flightPathManager.getCurrentPromptFile();

      return {
        fileName: currentFile ? currentFile.fileName : null,
        prompts: currentFile ? currentFile.prompts : [],
        executionState: queueState.status,
        currentStep: queueState.currentIndex,
        totalSteps: queueState.prompts.length,
      };
    }

    // Fallback if manager not set yet
    return {
      fileName: null,
      prompts: [],
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
      totalSteps: 0,
    };
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const constantsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview",
        "DashboardConstants.js"
      )
    );
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
        <div class="file-buttons">
          <button id="select-file" class="btn-secondary btn-small" title="Select a different prompt file">Select</button>
          <button id="edit-file" class="btn-secondary btn-small" title="Open current prompt file in editor" disabled>Edit</button>
        </div>
      </div>
      <div id="execution-state" class="execution-state-idle"></div>
      <div id="controls">
        <button id="btn-run" class="btn-primary" title="Run">▶</button>
        <button id="btn-pause" class="btn-secondary" title="Pause" disabled>⏸</button>
        <button id="btn-stop" class="btn-secondary" title="Stop" disabled>⏹</button>
      </div>
    </div>

    <div id="main-content">
      <div id="prompts-section">
        <div class="section-header">
          <h3>Prompts</h3>
          <span id="prompt-counter" class="prompt-counter"></span>
        </div>
        <div id="prompts-list"></div>
      </div>

      <div id="output-section">
        <div class="section-header">
          <h3>Output</h3>
          <label class="autoscroll-toggle">
            <input type="checkbox" id="autoscroll-checkbox" checked>
            <span>Autoscroll</span>
          </label>
        </div>
        <div id="output-content"></div>
      </div>
    </div>
  </div>

  <!-- Load constants first (SINGLE SOURCE OF TRUTH) -->
  <script src="${constantsUri}"></script>
  <!-- Then load main dashboard code that depends on constants -->
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
