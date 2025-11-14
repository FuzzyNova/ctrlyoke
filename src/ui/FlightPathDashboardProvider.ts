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
