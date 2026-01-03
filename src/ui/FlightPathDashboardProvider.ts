import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../types/DashboardConstants";
import { TemplateManager, TemplateInfo } from "../flightpath/TemplateManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";

export class FlightPathDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private flightPathManager?: any; // Reference to manager (set after construction to avoid circular dependency)
  private templateManager: TemplateManager;

  // Webview path segments
  private static readonly WEBVIEW_PATH_SEGMENTS = ["out", "ui", "webview"];

  // Command mapping for message handling
  private readonly messageCommandMap = new Map<string, string>([
    [MESSAGE_TYPES.READY, "flightpath.ready"],
    [MESSAGE_TYPES.NEW_PROMPT, "flightpath.createDraftPrompt"],
    [MESSAGE_TYPES.SELECT_FILE, "flightpath.selectPromptFile"],
    [MESSAGE_TYPES.APPEND_FILE, "flightpath.appendFromDashboard"],
    [MESSAGE_TYPES.EDIT_FILE, "flightpath.editCurrentPromptFile"],
    [MESSAGE_TYPES.RUN, "flightpath.run"],
    [MESSAGE_TYPES.PAUSE, "flightpath.pause"],
    [MESSAGE_TYPES.RESUME, "flightpath.resume"],
    [MESSAGE_TYPES.STOP, "flightpath.stop"],
    [MESSAGE_TYPES.SHOW_OUTPUT, "flightpath.showOutputPanel"],
  ]);

  constructor(private readonly context: vscode.ExtensionContext) {
    this.templateManager = new TemplateManager(context);
  }

  /**
   * Get the webview directory path
   */
  private getWebviewPath(...segments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      ...FlightPathDashboardProvider.WEBVIEW_PATH_SEGMENTS,
      ...segments
    );
  }

  /**
   * Get the webview directory filesystem path
   */
  private getWebviewFsPath(...segments: string[]): string {
    return path.join(
      this.context.extensionUri.fsPath,
      ...FlightPathDashboardProvider.WEBVIEW_PATH_SEGMENTS,
      ...segments
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.getWebviewPath()],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });

    // Send initial state when webview is ready
    this.sendInitialState();
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    // Handle export specially since it needs message data
    if (message.type === MESSAGE_TYPES.EXPORT_OUTPUT) {
      this.handleExportOutput(message.content, message.fileName);
      return;
    }

    // Handle editor messages
    if (message.type === MESSAGE_TYPES.EXECUTE_PROMPT) {
      this.handleExecutePrompt(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.UPDATE_PROMPT) {
      this.handleUpdatePrompt(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT) {
      this.handleSelectPromptForEdit(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.DELETE_PROMPT) {
      this.handleDeletePrompt(message);
      return;
    }

    // Handle CodeMirror editor messages
    if (message.type === MESSAGE_TYPES.REQUEST_COMPLETIONS) {
      this.handleCompletionRequest(
        message.trigger,
        message.prefix,
        message.position
      );
      return;
    }
    if (message.type === MESSAGE_TYPES.OPEN_FILE) {
      this.handleOpenFile(message.path, message.lineStart, message.lineEnd);
      return;
    }

    // Handle modal messages
    if (message.type === MESSAGE_TYPES.NEW_WORKFLOW) {
      this.handleNewWorkflow();
      return;
    }
    if (message.type === MESSAGE_TYPES.TEMPLATE_SELECTED) {
      this.handleTemplateSelected(message.templateId);
      return;
    }
    if (message.type === MESSAGE_TYPES.SET_DEFAULT_TEMPLATE) {
      this.handleSetDefaultTemplate(message.templateId);
      return;
    }
    if (message.type === MESSAGE_TYPES.CREATE_WORKFLOW) {
      this.handleCreateWorkflow(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.CREATE_NEW_TEMPLATE) {
      this.handleCreateNewTemplate();
      return;
    }

    const commandId = this.messageCommandMap.get(message.type);
    if (commandId) {
      if (message.type === MESSAGE_TYPES.READY) {
        this.sendInitialState();
        // Notify FlightPathManager that dashboard is ready (triggers deferred auto-load)
        if (this.flightPathManager) {
          await this.flightPathManager.setDashboardReady();
        }
      } else {
        vscode.commands.executeCommand(commandId);
      }
    }
  }

  // Public methods to send updates from FlightPathManager
  public updateFileSelected(fileName: string, prompts: any[]): void {
    this.postMessage({ type: MESSAGE_TYPES.FILE_SELECTED, fileName, prompts });
  }

  public updateSessionRestored(
    fileName: string,
    prompts: any[],
    results: any[],
    executionState: string,
    currentIndex: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.SESSION_RESTORED,
      fileName,
      prompts: prompts.map((p) => ({ prompt: p.prompt })),
      results,
      executionState,
      currentIndex,
    });
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
    console.log(
      `🔍 DashboardProvider.updateCliStreamingChunk: stepIndex=${stepIndex}, chunk length=${chunk.length}, content (first 100 chars): ${JSON.stringify(chunk.substring(0, 100))}`
    );
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

  public notifyQueueExtended(
    addedCount: number,
    currentSize: number,
    maxSize?: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.QUEUE_EXTENDED,
      addedCount,
      currentSize,
      maxSize,
    });
  }

  public updatePromptsExtended(prompts: any[]): void {
    console.log(
      `📊 DashboardProvider.updatePromptsExtended: Sending ${prompts.length} prompts`,
      prompts.map((p) => p.prompt?.substring(0, 50))
    );
    this.postMessage({
      type: MESSAGE_TYPES.PROMPTS_EXTENDED,
      prompts: prompts.map((p) => ({ prompt: p.prompt })),
    });
  }

  public notifyQueueSizeLimitReached(
    currentSize: number,
    maxSize: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.QUEUE_SIZE_LIMIT_REACHED,
      currentSize,
      maxSize,
    });
  }

  public notifyExecutionTimeLimitReached(
    elapsedSeconds: number,
    maxSeconds: number,
    completedCount: number,
    totalCount: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.EXECUTION_TIME_LIMIT_REACHED,
      elapsedSeconds,
      maxSeconds,
      completedCount,
      totalCount,
    });
  }

  public notifyDynamicQueueEnabled(enabled: boolean): void {
    this.postMessage({
      type: enabled
        ? MESSAGE_TYPES.DYNAMIC_QUEUE_ENABLED
        : MESSAGE_TYPES.DYNAMIC_QUEUE_DISABLED,
    });
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  // ============================================================================
  // Modal Handlers - New Workflow Modal
  // ============================================================================

  /**
   * Handle request to open new workflow modal
   */
  private async handleNewWorkflow(): Promise<void> {
    try {
      const templates = await this.templateManager.getAvailableTemplates();
      const workflowsDir = ConfigurationUtils.getWorkflowsDirectory();
      const defaultTemplateId = ConfigurationUtils.getDefaultWorkflowTemplate();

      this.postMessage({
        type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          variables: t.variables,
          isBuiltIn: t.isBuiltIn,
          isAction: t.isAction,
        })),
        workflowsDir,
        defaultTemplateId,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to load templates: ${errorMsg}`);
    }
  }

  /**
   * Handle template selection in modal
   */
  private async handleTemplateSelected(templateId: string): Promise<void> {
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      if (!template) {
        return;
      }

      // For non-blank templates, extract variables from actual content
      let variables = template.variables;
      if (templateId !== "blank" && !template.isAction) {
        const content =
          await this.templateManager.getTemplateContent(templateId);
        variables = this.templateManager.extractVariables(content);
      }

      this.postMessage({
        type: MESSAGE_TYPES.TEMPLATE_INFO,
        templateId,
        description: template.description,
        variables,
      });
    } catch (error) {
      Log.error("Failed to get template info:", error);
    }
  }

  /**
   * Handle set default template request
   */
  private async handleSetDefaultTemplate(templateId: string): Promise<void> {
    try {
      await this.templateManager.setDefaultTemplateId(templateId);
      this.postMessage({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        success: true,
        templateId,
      });
    } catch (error) {
      Log.error("Failed to set default template:", error);
      this.postMessage({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        success: false,
        templateId,
      });
    }
  }

  /**
   * Handle create workflow request
   */
  private async handleCreateWorkflow(message: any): Promise<void> {
    try {
      const { templateId, variables, filename, workflowsDir, runAfter } =
        message;

      // Create the workflow file
      const filePath = await this.templateManager.createWorkflow(
        templateId,
        variables || {},
        filename,
        workflowsDir
      );

      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        success: true,
        filePath,
      });

      // Load the workflow into the dashboard
      if (this.flightPathManager) {
        await this.flightPathManager.loadPromptFile(filePath);

        // Optionally run the workflow
        if (runAfter) {
          await this.flightPathManager.executeLoadedPromptFile();
        }
      }

      // Open the file in editor
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        success: false,
        error: errorMsg,
      });
    }
  }

  /**
   * Handle create new template request
   * Triggers the createNewTemplate command flow
   */
  private async handleCreateNewTemplate(): Promise<void> {
    // Close the modal first
    this.postMessage({ type: MESSAGE_TYPES.CLOSE_MODAL });

    // Execute the create new template command
    await vscode.commands.executeCommand("flightpath.createNewTemplate");
  }

  /**
   * Open the new workflow modal (can be called from command)
   */
  public openNewWorkflowModal(): void {
    this.handleNewWorkflow();
  }

  /**
   * Handle export output request from webview
   * Shows save dialog and writes markdown content to file
   */
  private async handleExportOutput(
    content: string,
    sourceFileName: string | null
  ): Promise<void> {
    // Generate default filename with timestamp
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
    const defaultFileName = `${dateStr}-${timeStr}-flightpath-output.md`;

    // Determine default directory (.flightpath/output in workspace)
    let defaultUri: vscode.Uri | undefined;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (workspaceFolders && workspaceFolders.length > 0) {
      const outputDir = vscode.Uri.joinPath(
        workspaceFolders[0].uri,
        ".flightpath",
        "output"
      );

      // Pre-create the output directory to help VS Code honor our defaultUri
      try {
        await vscode.workspace.fs.createDirectory(outputDir);
      } catch {
        // Directory may already exist, that's fine
      }

      defaultUri = vscode.Uri.joinPath(outputDir, defaultFileName);
    }

    // Show save dialog
    // Note: VS Code may remember the last save location and override defaultUri
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        Markdown: ["md"],
        "All Files": ["*"],
      },
      saveLabel: "Export Output",
      title: "Export FlightPath Output",
    });

    if (!saveUri) {
      return; // User cancelled
    }

    try {
      // Ensure parent directory exists
      const parentDir = vscode.Uri.joinPath(saveUri, "..");
      try {
        await vscode.workspace.fs.stat(parentDir);
      } catch {
        // Directory doesn't exist, create it
        await vscode.workspace.fs.createDirectory(parentDir);
      }

      // Write content to file
      const contentBytes = new TextEncoder().encode(content);
      await vscode.workspace.fs.writeFile(saveUri, contentBytes);

      // Show success notification with option to open file
      const openAction = "Open File";
      const result = await vscode.window.showInformationMessage(
        `Output exported to ${path.basename(saveUri.fsPath)}`,
        openAction
      );

      if (result === openAction) {
        const doc = await vscode.workspace.openTextDocument(saveUri);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to export output: ${errorMsg}`);
    }
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
      this.getWebviewPath("DashboardConstants.js")
    );
    const scriptUri = webview.asWebviewUri(this.getWebviewPath("dashboard.js"));
    const styleUri = webview.asWebviewUri(this.getWebviewPath("dashboard.css"));
    const sharedStyleUri = webview.asWebviewUri(
      this.getWebviewPath("shared.css")
    );
    // Get codicon CSS from copied files in webview directory
    const codiconsUri = webview.asWebviewUri(
      this.getWebviewPath("codicons", "codicon.css")
    );
    // Get typo.js and CodeMirror URIs (KEEP Typo.js for spell checking)
    const typoUri = webview.asWebviewUri(this.getWebviewPath("typo.js"));
    const codemirrorLoaderUri = webview.asWebviewUri(
      this.getWebviewPath("codemirror-loader.js")
    );
    const codemirrorEditorUri = webview.asWebviewUri(
      this.getWebviewPath("codemirror-editor.js")
    );
    // Get dictionary file URIs (pass individual files, not directory)
    const affUri = webview
      .asWebviewUri(this.getWebviewPath("dictionaries", "en_US", "en_US.aff"))
      .toString();
    const dicUri = webview
      .asWebviewUri(this.getWebviewPath("dictionaries", "en_US", "en_US.dic"))
      .toString();

    // Read HTML template and replace placeholders
    const htmlPath = this.getWebviewFsPath("dashboard.html");

    let html: string;
    try {
      html = fs.readFileSync(htmlPath, "utf8");
    } catch (error) {
      Log.error("Failed to load dashboard.html template:", error);
      // Fallback to minimal HTML
      return `<!DOCTYPE html>
<html>
<head><title>FlightPath Dashboard</title></head>
<body><p>Error loading dashboard template</p></body>
</html>`;
    }

    // Replace template placeholders with actual URIs
    html = html
      .replace(/\{\{constantsUri\}\}/g, constantsUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{sharedStyleUri\}\}/g, sharedStyleUri.toString())
      .replace(/\{\{codiconsUri\}\}/g, codiconsUri.toString())
      .replace(/\{\{typoUri\}\}/g, typoUri.toString())
      .replace(/\{\{codemirrorLoaderUri\}\}/g, codemirrorLoaderUri.toString())
      .replace(/\{\{codemirrorEditorUri\}\}/g, codemirrorEditorUri.toString())
      .replace(/\{\{affUri\}\}/g, affUri)
      .replace(/\{\{dicUri\}\}/g, dicUri)
      .replace(/\{\{cspSource\}\}/g, webview.cspSource);

    return html;
  }

  /**
   * Handle EXECUTE_PROMPT message from webview
   * Creates ephemeral prompt and executes it (Run/Append/AppendNext)
   */
  private async handleExecutePrompt(message: any): Promise<void> {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { text, properties, action } = message;

    try {
      await this.flightPathManager.executeEphemeralPrompt(
        text,
        properties,
        action
      );
    } catch (error) {
      Log.error("Failed to execute ephemeral prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to execute prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle UPDATE_PROMPT message from webview
   * Updates an existing prompt in the queue
   */
  private async handleUpdatePrompt(message: any): Promise<void> {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { index, text, properties } = message;

    try {
      await this.flightPathManager.updatePromptInQueue(index, text, properties);
    } catch (error) {
      Log.error("Failed to update prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to update prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle SELECT_PROMPT_FOR_EDIT message from webview
   * Currently just a placeholder - selection is handled in webview
   */
  private handleSelectPromptForEdit(message: any): void {
    // Selection is handled entirely in the webview
    // This handler exists for potential future use (e.g., logging, analytics)
    Log.debug(`Prompt ${message.index} selected for editing`);
  }

  /**
   * Handle DELETE_PROMPT message from webview
   * Removes a prompt from the queue
   */
  private async handleDeletePrompt(message: any): Promise<void> {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { index } = message;

    try {
      await this.flightPathManager.deletePromptFromQueue(index);
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
      vscode.window.showErrorMessage(
        `Failed to delete prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle REQUEST_COMPLETIONS message from CodeMirror editor
   * Provides autocomplete suggestions for @file and #file references
   */
  private handleCompletionRequest(
    trigger: string,
    prefix: string,
    position: number
  ): void {
    try {
      const items = this.getCompletionItems(trigger, prefix);

      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: items.map((item) => ({
          label: item.label,
          kind: item.kind,
          insertText: item.insertText,
          detail: item.detail,
          documentation: item.documentation,
        })),
        from: position,
      });
    } catch (error) {
      Log.error("Error generating completions:", error);
      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: [],
        from: position,
      });
    }
  }

  /**
   * Get completion items based on trigger (@file or #file)
   * This is a simplified implementation - can be enhanced with PromptCompletionProvider logic
   */
  private getCompletionItems(trigger: string, prefix: string): any[] {
    const items: any[] = [];

    if (trigger === "@") {
      // Add @workspace completion
      items.push({
        label: "workspace",
        kind: "folder",
        insertText: "@workspace ",
        detail: "Reference entire workspace",
      });

      // TODO: Add file completions by scanning workspace
      // This would require implementing file scanning logic similar to PromptCompletionProvider
    } else if (trigger === "#" && prefix.startsWith("#file:")) {
      // TODO: Add #file: completions
      // This would require implementing file path completion logic
    }

    return items;
  }

  /**
   * Handle OPEN_FILE message from CodeMirror editor
   * Opens a file when user Ctrl+Clicks on #file: link
   */
  private handleOpenFile(
    path: string,
    lineStart?: number,
    lineEnd?: number
  ): void {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        Log.warn("No workspace folder open");
        return;
      }

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, path);

      const options: vscode.TextDocumentShowOptions = {
        preview: false,
      };

      if (lineStart) {
        const start = new vscode.Position(lineStart - 1, 0);
        const end = lineEnd
          ? new vscode.Position(lineEnd - 1, Number.MAX_SAFE_INTEGER)
          : start;
        options.selection = new vscode.Range(start, end);
      }

      vscode.window.showTextDocument(fileUri, options);
    } catch (error) {
      Log.error("Error opening file:", error);
      vscode.window.showErrorMessage(`Failed to open file: ${path}`);
    }
  }
}
