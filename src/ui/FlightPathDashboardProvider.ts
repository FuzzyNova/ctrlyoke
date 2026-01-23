import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs"; // For synchronous file operations
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  PROVIDER_IDS,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  StatusMessageSeverity,
  DEFAULT_MODELS,
} from "../types/DashboardConstants";
import { TemplateManager, TemplateInfo } from "../flightpath/TemplateManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
} from "../completions/CompletionHelpers";
import {
  getAvailableModelsSync,
  getCliSupportedModelIdsSync,
  onModelsLoaded,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import { FlightPathManager } from "../flightpath/FlightPathManager";
import { FlightPathSettingsProvider } from "./FlightPathSettingsProvider";
import { Provider } from "../types/FlightPathTypes";
import { DashboardOutput } from "../flightpath/cli/shared/CliOutputFormatter";

/**
 * Output data for CLI execution, sent to dashboard for display.
 */
export interface CliOutputData {
  /** The prompt text that was sent */
  prompt: string;
  /** Plain text response for backward compatibility */
  response: string;
  /** Structured output with tool calls, thinking blocks, and metadata (CLI only) */
  structured?: DashboardOutput;
  /** Execution time in seconds */
  elapsed: number;
  /** Token usage statistics */
  tokens?: { prompt: number; completion: number };
  /** Whether the response is still streaming */
  isStreaming: boolean;
  /** The CLI command executed (for debugging) */
  cliCommand?: string;
  /** The working directory where the command was executed (for terminal-style display) */
  workingDirectory?: string;
}

export class FlightPathDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private flightPathManager?: FlightPathManager;
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

  // Reference to settings provider for workflow property coordination
  private settingsProvider?: FlightPathSettingsProvider;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.templateManager = new TemplateManager(context);

    // Listen for model registry updates
    onModelsLoaded(() => {
      this.sendModelOptionsUpdate();
    });
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
      localResourceRoots: [
        this.getWebviewPath(),
        vscode.Uri.joinPath(this.context.extensionUri, "images"),
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

  private async handleWebviewMessage(message: any): Promise<void> {
    // Handle export specially since it needs message data
    if (message.type === MESSAGE_TYPES.EXPORT_OUTPUT) {
      this.handleExportOutput(message.content, message.fileName);
      return;
    }

    // Handle clear workflow
    if (message.type === MESSAGE_TYPES.CLEAR_WORKFLOW) {
      this.handleClearWorkflow();
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

    // Handle workflow status messages
    if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_NAME) {
      this.handleUpdateWorkflowName(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.GET_RECENT_WORKFLOWS) {
      this.handleGetRecentWorkflows();
      return;
    }
    if (message.type === MESSAGE_TYPES.LOAD_WORKFLOW) {
      this.handleLoadWorkflow(message);
      return;
    }
    if (message.type === MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY) {
      this.handleClearWorkflowHistory();
      return;
    }
    if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY) {
      this.handleUpdateWorkflowProperty(message);
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
  public async updateFileSelected(
    fileName: string,
    prompts: any[],
    workflowName?: string
  ): Promise<void> {
    this.postMessage({
      type: MESSAGE_TYPES.FILE_SELECTED,
      fileName,
      prompts,
      workflowName,
    });

    // Apply any pending workflow properties (set before workflow creation)
    await this.applyPendingWorkflowProperties();

    // Extract and send workflow properties to settings panel
    this.sendWorkflowPropertiesToSettings();
  }

  public updateSessionRestored(
    fileName: string,
    prompts: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.SESSION_RESTORED,
      fileName,
      prompts, // Send full prompt objects with all properties
      results,
      executionState,
      currentIndex,
      workflowName,
    });

    // Extract and send workflow properties to settings panel
    this.sendWorkflowPropertiesToSettings();
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

  public updateCliOutput(stepIndex: number, output: CliOutputData): void {
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

  public updateStatusMessage(
    stepIndex: number,
    message: string,
    severity: StatusMessageSeverity = STATUS_MESSAGE_SEVERITY.INFO
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.STATUS_MESSAGE,
      stepIndex,
      message,
      severity,
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
      prompts, // Send full prompt objects with all properties
    });
  }

  public updatePromptDeleted(fileName: string, prompts: any[]): void {
    console.log(
      `🗑️ DashboardProvider.updatePromptDeleted: ${prompts.length} prompts remaining`
    );
    this.postMessage({
      type: MESSAGE_TYPES.PROMPT_DELETED,
      fileName,
      prompts,
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

  /**
   * Handle clear workflow request from dashboard
   * Clears all workflow state (prompts, working file, current file reference)
   */
  private handleClearWorkflow(): void {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    // Notify settings panel that workflow is unloaded
    this.sendWorkflowUnloadedToSettings();

    // Clear workflow state in FlightPathManager
    this.flightPathManager.clearWorkflow();

    // Update dashboard to show empty state
    this.updateFileSelected("New Workflow", [], undefined);

    Log.info("Workflow cleared, ready for new prompts");
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

        // Apply pending workflow properties (if any were set before workflow creation)
        await this.applyPendingWorkflowProperties();

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

  /**
   * Build model options for all providers
   * Returns a map of provider ID to array of {value, label} options
   */
  private buildModelOptions(): Record<
    string,
    Array<{ value: string; label: string }>
  > {
    // Get all chat models (superset - includes models not available in CLI)
    const chatModels = getAvailableModelsSync();

    // Get CLI-supported model IDs
    const cliModelIds = getCliSupportedModelIdsSync();

    // Models to hide from the UI (non-functional or internal)
    const hiddenModels = new Set(["copilot-fast"]);

    // Format chat models for dropdown (filter out hidden models)
    const copilotChatOptions = chatModels
      .filter((m) => !hiddenModels.has(m.id))
      .map((m) => ({
        value: m.id,
        label: getModelDisplayName(m.id),
      }));

    // Format CLI models for dropdown (only CLI-supported ones, filter hidden)
    const copilotCliOptions = cliModelIds
      .filter((id) => !hiddenModels.has(id))
      .map((id) => ({
        value: id,
        label: getModelDisplayName(id),
      }));

    // Claude CLI uses static list with friendly labels from ModelConstants
    const claudeCliOptions = Object.entries(CLAUDE_CLI_MODEL_LABELS).map(
      ([value, label]) => ({
        value,
        label,
      })
    );

    // Codex CLI uses static list with friendly labels from ModelConstants
    const codexCliOptions = Object.entries(CODEX_CLI_MODEL_LABELS).map(
      ([value, label]) => ({
        value,
        label,
      })
    );

    return {
      [PROVIDER_IDS.COPILOT_CLI]: copilotCliOptions,
      [PROVIDER_IDS.COPILOT_CHAT]: copilotChatOptions,
      [PROVIDER_IDS.CLAUDE_CLI]: claudeCliOptions,
      [PROVIDER_IDS.CODEX_CLI]: codexCliOptions,
    };
  }

  /**
   * Send updated model options to the webview
   * Called when model registry finishes loading
   */
  private sendModelOptionsUpdate(): void {
    if (!this.view) {
      return;
    }

    const modelOptions = this.buildModelOptions();
    this.view.webview.postMessage({
      type: MESSAGE_TYPES.MODEL_OPTIONS_UPDATE,
      data: { modelOptions },
    });
  }

  private sendInitialState(): void {
    // Get current state from FlightPathManager and send to webview
    const state = this.getCurrentState();

    // Build dynamic model options from ModelRegistry
    const modelOptions = this.buildModelOptions();

    this.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: {
        ...state,
        modelOptions,
      },
    });
  }

  private getCurrentState(): any {
    // Get actual state from FlightPathManager if available
    if (this.flightPathManager) {
      const queueState = this.flightPathManager.getQueueState();
      const currentFile = this.flightPathManager.getCurrentPromptFile();

      return {
        fileName: currentFile ? currentFile.fileName : null,
        workflowName: queueState.workflowName || null, // Include workflow name
        prompts: currentFile ? currentFile.prompts : [],
        executionState: queueState.status,
        currentStep: queueState.currentIndex,
        totalSteps: queueState.prompts.length,
      };
    }

    // Fallback if manager not set yet
    return {
      fileName: null,
      workflowName: null,
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
    const gptTokenizerUri = webview.asWebviewUri(
      this.getWebviewPath("gpt-tokenizer.js")
    );
    const diffUri = webview.asWebviewUri(this.getWebviewPath("diff.js"));
    const scriptUri = webview.asWebviewUri(this.getWebviewPath("dashboard.js"));
    const styleUri = webview.asWebviewUri(this.getWebviewPath("dashboard.css"));
    const sharedStyleUri = webview.asWebviewUri(
      this.getWebviewPath("shared.css")
    );
    // Get codicon CSS from copied files in webview directory
    const codiconsUri = webview.asWebviewUri(
      this.getWebviewPath("codicons", "codicon.css")
    );
    // Get custom icons CSS (auto-generated from SVG files)
    const customIconsUri = webview.asWebviewUri(
      this.getWebviewPath("custom-icons.css")
    );
    // Get typo.js and CodeMirror URIs (KEEP Typo.js for spell checking)
    const typoUri = webview.asWebviewUri(this.getWebviewPath("typo.js"));
    const codemirrorLoaderUri = webview.asWebviewUri(
      this.getWebviewPath("codemirror-loader.js")
    );
    const codemirrorEditorUri = webview.asWebviewUri(
      this.getWebviewPath("codemirror-editor.js")
    );
    // FlightPath module URIs (modular architecture)
    const utilitiesUri = webview.asWebviewUri(
      this.getWebviewPath("utilities.js")
    );
    const stateManagerUri = webview.asWebviewUri(
      this.getWebviewPath("state-manager.js")
    );
    const outputManagerUri = webview.asWebviewUri(
      this.getWebviewPath("output-manager.js")
    );
    const workflowManagerUri = webview.asWebviewUri(
      this.getWebviewPath("workflow-manager.js")
    );
    const editorManagerUri = webview.asWebviewUri(
      this.getWebviewPath("editor-manager.js")
    );
    const promptsManagerUri = webview.asWebviewUri(
      this.getWebviewPath("prompts-manager.js")
    );
    const messageRouterUri = webview.asWebviewUri(
      this.getWebviewPath("message-router.js")
    );
    // Get dictionary file URIs (pass individual files, not directory)
    const affUri = webview
      .asWebviewUri(this.getWebviewPath("dictionaries", "en_US", "en_US.aff"))
      .toString();
    const dicUri = webview
      .asWebviewUri(this.getWebviewPath("dictionaries", "en_US", "en_US.dic"))
      .toString();
    // Get logo URI from images folder (for background watermark)
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "images",
        "flightpath-sidebar-icon.svg"
      )
    );

    // Read HTML template and replace placeholders
    const htmlPath = this.getWebviewFsPath("dashboard.html");

    let html: string;
    try {
      html = fsSync.readFileSync(htmlPath, "utf8");
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
      .replace(/\{\{gptTokenizerUri\}\}/g, gptTokenizerUri.toString())
      .replace(/\{\{diffUri\}\}/g, diffUri.toString())
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
      .replace(/\{\{styleUri\}\}/g, styleUri.toString())
      .replace(/\{\{sharedStyleUri\}\}/g, sharedStyleUri.toString())
      .replace(/\{\{codiconsUri\}\}/g, codiconsUri.toString())
      .replace(/\{\{customIconsUri\}\}/g, customIconsUri.toString())
      .replace(/\{\{typoUri\}\}/g, typoUri.toString())
      .replace(/\{\{codemirrorLoaderUri\}\}/g, codemirrorLoaderUri.toString())
      .replace(/\{\{codemirrorEditorUri\}\}/g, codemirrorEditorUri.toString())
      .replace(/\{\{utilitiesUri\}\}/g, utilitiesUri.toString())
      .replace(/\{\{stateManagerUri\}\}/g, stateManagerUri.toString())
      .replace(/\{\{outputManagerUri\}\}/g, outputManagerUri.toString())
      .replace(/\{\{workflowManagerUri\}\}/g, workflowManagerUri.toString())
      .replace(/\{\{editorManagerUri\}\}/g, editorManagerUri.toString())
      .replace(/\{\{promptsManagerUri\}\}/g, promptsManagerUri.toString())
      .replace(/\{\{messageRouterUri\}\}/g, messageRouterUri.toString())
      .replace(/\{\{affUri\}\}/g, affUri)
      .replace(/\{\{dicUri\}\}/g, dicUri)
      .replace(/\{\{logoUri\}\}/g, logoUri.toString())
      .replace(/\{\{cspSource\}\}/g, webview.cspSource);

    return html;
  }

  /**
   * Handle EXECUTE_PROMPT message from webview
   * Creates ephemeral prompt and executes it (Run/Queue with optional position)
   */
  private async handleExecutePrompt(message: any): Promise<void> {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { text, properties, action, promptName, forceNewWorkflow } = message;

    try {
      await this.flightPathManager.executeEphemeralPrompt(
        text,
        properties,
        action,
        promptName,
        forceNewWorkflow
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
    console.log(
      "🗑️ DashboardProvider.handleDeletePrompt: Received delete request for index:",
      message.index
    );

    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { index } = message;

    try {
      console.log(
        "🗑️ DashboardProvider.handleDeletePrompt: Calling FlightPathManager.deletePromptFromQueue"
      );
      await this.flightPathManager.deletePromptFromQueue(index);
      console.log(
        "🗑️ DashboardProvider.handleDeletePrompt: Delete completed successfully"
      );
    } catch (error) {
      Log.error("Failed to delete prompt:", error);
      console.error("🗑️ DashboardProvider.handleDeletePrompt: Error:", error);
      vscode.window.showErrorMessage(
        `Failed to delete prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle REQUEST_COMPLETIONS message from CodeMirror editor
   * Provides autocomplete suggestions for @file and #file references
   */
  private async handleCompletionRequest(
    trigger: string,
    prefix: string,
    position: number
  ): Promise<void> {
    Log.info(
      `[Dashboard] handleCompletionRequest: trigger="${trigger}", prefix="${prefix}", position=${position}`
    );

    try {
      const items = await this.getCompletionItems(trigger, prefix);

      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: items.map((item) => ({
          label: item.label,
          kind: item.kind,
          insertText: item.insertText,
          detail: item.detail,
          documentation: item.documentation,
          sortText: item.sortText,
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
   * Uses shared CompletionHelpers for code reuse with PromptCompletionProvider
   */
  private async getCompletionItems(
    trigger: string,
    prefix: string
  ): Promise<any[]> {
    // Remove trigger character from prefix to get filter text
    const filterText = prefix.substring(1); // Remove @ or #

    if (trigger === "@") {
      // Get file and directory completions
      const completions = await getFileCompletions(filterText);
      return completions;
    } else if (trigger === "#") {
      // Get selection and symbol completions
      const completions = await getHashCompletions(filterText);
      return completions;
    }

    return [];
  }

  /**
   * Handle OPEN_FILE message from CodeMirror editor
   * Opens a file when user Ctrl+Clicks on #file: link
   */
  private async handleOpenFile(
    relativePath: string,
    lineStart?: number,
    lineEnd?: number
  ): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        Log.warn("No workspace folder open");
        return;
      }

      const normalizedPath = relativePath.replace(/\\/g, "/");
      const isDirectory = normalizedPath.endsWith("/");
      const trimmedPath = isDirectory
        ? normalizedPath.replace(/\/+$/, "")
        : normalizedPath;

      const segments = trimmedPath.split("/").filter(Boolean);
      const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...segments);

      if (isDirectory) {
        // Match PromptLinkProvider behavior (reveal directory)
        // Prefer revealInExplorer, fall back to revealFileInOS
        try {
          await vscode.commands.executeCommand("revealInExplorer", targetUri);
        } catch {
          await vscode.commands.executeCommand("revealFileInOS", targetUri);
        }
        return;
      }

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

      await vscode.window.showTextDocument(targetUri, options);
    } catch (error) {
      Log.error("Error opening file:", error);
      vscode.window.showErrorMessage(`Failed to open: ${relativePath}`);
    }
  }

  // ============================================================================
  // WORKFLOW STATUS HANDLERS
  // ============================================================================

  /**
   * Handle UPDATE_WORKFLOW_NAME message
   * Update workflow name in working file
   */
  private async handleUpdateWorkflowName(message: any): Promise<void> {
    const { workflowName } = message;

    try {
      await this.flightPathManager?.updateWorkflowName(workflowName);

      // Confirm update
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_NAME_UPDATED,
        workflowName,
      });
    } catch (error) {
      Log.error("Failed to update workflow name:", error);
      vscode.window.showErrorMessage(
        `Failed to update workflow name: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle GET_RECENT_WORKFLOWS message
   * Get recent workflows from .flightpath/.queue
   */
  private async handleGetRecentWorkflows(): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");

      // Check if queue directory exists
      try {
        await fs.access(queueDir);
      } catch {
        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      // Read all .flightpath.json files
      const files = await fs.readdir(queueDir);
      const workflowFiles = files.filter((f) => f.endsWith(".flightpath.json"));

      // Parse each file and extract metadata
      const workflows = await Promise.all(
        workflowFiles.map(async (file) => {
          const filePath = path.join(queueDir, file);

          try {
            const content = await fs.readFile(filePath, "utf8");
            const workingFile = JSON.parse(content);

            // Use lastModifiedAt if available, fall back to startedAt
            const lastModified =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

            return {
              filePath,
              workflowName:
                workingFile.workflowName ||
                file.replace(".flightpath.json", ""),
              executionState: workingFile._runtime?.executionState || "IDLE",
              startedAt: workingFile.startedAt || 0,
              lastModifiedAt: lastModified,
            };
          } catch (error) {
            Log.warn(`Failed to parse workflow file ${file}:`, error);
            return null;
          }
        })
      );

      // Filter out nulls and sort by most recent modification
      const validWorkflows = workflows
        .filter((w) => w !== null)
        .sort((a, b) => b!.lastModifiedAt - a!.lastModifiedAt);

      this.postMessage({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: validWorkflows,
      });
    } catch (error) {
      Log.error("Failed to get recent workflows:", error);
      this.postMessage({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
    }
  }

  /**
   * Handle LOAD_WORKFLOW message
   * Load workflow from file path
   */
  private async handleLoadWorkflow(message: any): Promise<void> {
    const { filePath } = message;

    try {
      await this.flightPathManager?.loadWorkingFile(filePath);
    } catch (error) {
      Log.error("Failed to load workflow:", error);
      vscode.window.showErrorMessage(
        `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle CLEAR_WORKFLOW_HISTORY message
   * Clear workflow history
   */
  private async handleClearWorkflowHistory(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "Delete all workflow history files from .flightpath/.queue?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return;
    }

    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return;
      }

      const queueDir = path.join(workspaceRoot, ".flightpath", ".queue");

      try {
        const files = await fs.readdir(queueDir);
        const workflowFiles = files.filter((f) =>
          f.endsWith(".flightpath.json")
        );

        for (const file of workflowFiles) {
          await fs.unlink(path.join(queueDir, file));
        }

        vscode.window.showInformationMessage("Workflow history cleared");

        // Refresh recent workflows
        await this.handleGetRecentWorkflows();
      } catch (error) {
        // Queue directory might not exist
        Log.info("No workflow history to clear");
      }
    } catch (error) {
      Log.error("Failed to clear workflow history:", error);
      vscode.window.showErrorMessage(
        `Failed to clear history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle UPDATE_WORKFLOW_PROPERTY message from settings panel
   * Update workflow property in working file
   */
  private async handleUpdateWorkflowProperty(message: any): Promise<void> {
    const { property, value } = message;

    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    try {
      // Get current working file path
      const workingFilePath =
        this.flightPathManager.getQueueState()?.workingFilePath;
      if (!workingFilePath) {
        // No working file yet - pending properties are managed by SettingsProvider
        Log.debug(
          `No working file yet, property '${property}' stored in pending by SettingsProvider`
        );
        return;
      }

      const updates: Record<string, unknown> = {
        [property]: value,
      };

      const result = await this.flightPathManager.updateWorkingFileProperties(
        updates,
        { ensureProviderAndModel: true, allowDeletes: true }
      );

      if (!result) {
        Log.warn(
          `Failed to update workflow property '${property}' - no working file result`
        );
        return;
      }

      Log.info(
        `Updated workflow property '${property}' in working file: ${workingFilePath}`
      );

      // Send updated properties back to settings panel (confirmation)
      this.sendWorkflowPropertiesToSettings();
    } catch (error) {
      Log.error("Failed to update workflow property:", error);
      vscode.window.showErrorMessage(
        `Failed to update workflow property: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Apply pending workflow properties to the current working file
   * Called after a workflow is created to inject user-configured properties
   *
   * Precedence:
   * 1. Properties from loaded file (highest priority - never overwritten)
   * 2. Pending workflow properties (fill in undefined properties)
   * 3. VS Code global settings (fallback - handled by PropertyResolver)
   */
  public async applyPendingWorkflowProperties(): Promise<void> {
    if (!this.flightPathManager || !this.settingsProvider) {
      return;
    }

    try {
      const workingFilePath =
        this.flightPathManager.getQueueState()?.workingFilePath;
      if (!workingFilePath) {
        Log.warn("No working file to apply pending properties to");
        return;
      }

      // Get pending properties from settings provider (without clearing yet)
      const pendingProperties = this.settingsProvider.getPendingProperties();

      // Check if there are any pending properties
      const hasPendingProperties = Object.keys(pendingProperties).some(
        (key) => pendingProperties[key] !== undefined
      );

      if (!hasPendingProperties) {
        Log.debug("No pending workflow properties to apply");
        return;
      }

      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(pendingProperties)) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }

      if (Object.keys(updates).length === 0) {
        Log.debug("No pending workflow properties to apply");
        return;
      }

      const result = await this.flightPathManager.updateWorkingFileProperties(
        updates,
        { onlyIfUndefined: true, ensureProviderAndModel: true }
      );

      if (!result) {
        Log.warn("Failed to apply pending workflow properties");
        return;
      }

      const appliedProperties = result.appliedKeys;
      if (appliedProperties.length > 0) {
        for (const key of appliedProperties) {
          const value = pendingProperties[key];
          Log.info(
            `Applied pending workflow property '${key}': ${JSON.stringify(value)} (file had no value)`
          );
        }

        // Send updated properties to settings panel
        this.sendWorkflowPropertiesToSettings();

        Log.info(
          `Applied ${appliedProperties.length} pending properties to working file (${appliedProperties.join(", ")})`
        );
      } else {
        Log.debug(
          "No pending properties applied - file already has all values"
        );
      }

      // Clear pending properties only after a successful apply attempt
      this.settingsProvider.clearPendingProperties();
      Log.info(
        `Returning pending properties: ${JSON.stringify(pendingProperties)} (cleared)`
      );
    } catch (error) {
      Log.error("Failed to apply pending workflow properties:", error);
    }
  }

  /**
   * Extract workflow properties from working file and send to settings panel
   */
  private sendWorkflowPropertiesToSettings(): void {
    if (!this.flightPathManager) {
      return;
    }

    try {
      const workingFilePath =
        this.flightPathManager.getQueueState()?.workingFilePath;
      if (!workingFilePath) {
        return;
      }

      // Read working file synchronously (we need properties immediately)
      const workingFileContent = fsSync.readFileSync(workingFilePath, "utf-8");
      const workingFile = JSON.parse(workingFileContent);

      // Extract workflow-level properties
      const workflowProperties = {
        provider: workingFile.provider,
        model: workingFile.model,
        agent: workingFile.agent,
        newChatSession: workingFile.newChatSession,
        allowDynamicExtension: workingFile.allowDynamicExtension,
        endCondition: workingFile.endCondition,
      };

      // Send WORKFLOW_LOADED message to settings panel
      this.sendMessageToSettings({
        type: MESSAGE_TYPES.WORKFLOW_LOADED,
        data: { workflowProperties },
      });

      Log.info("Sent workflow properties to settings panel");
    } catch (error) {
      Log.error("Failed to send workflow properties to settings:", error);
    }
  }

  /**
   * Send WORKFLOW_UNLOADED message to settings panel
   */
  private sendWorkflowUnloadedToSettings(): void {
    this.sendMessageToSettings({
      type: MESSAGE_TYPES.WORKFLOW_UNLOADED,
    });
    Log.info("Sent workflow unloaded to settings panel");
  }

  /**
   * Send message to settings panel webview
   */
  private sendMessageToSettings(message: any): void {
    if (this.settingsProvider) {
      (this.settingsProvider as any).postMessageToWebview(message);
    }
  }

  /**
   * Get model for a provider
   */
  private getModelForProvider(provider: Provider): string {
    const config = vscode.workspace.getConfiguration("flightpath");

    switch (provider) {
      case Provider.CopilotCli:
        return (
          config.get<string>("copilotCliModel") || DEFAULT_MODELS["copilot-cli"]
        );
      case Provider.CopilotChat:
        return (
          config.get<string>("copilotChatModel") ||
          DEFAULT_MODELS["copilot-chat"]
        );
      case Provider.ClaudeCli:
        return (
          config.get<string>("claudeCliModel") || DEFAULT_MODELS["claude-cli"]
        );
      case Provider.CodexCli:
        return (
          config.get<string>("codexCliModel") || DEFAULT_MODELS["codex-cli"]
        );
      default:
        return DEFAULT_MODELS["copilot-cli"];
    }
  }

  /**
   * Set settings provider reference (called from extension.ts)
   */
  public setSettingsProvider(provider: FlightPathSettingsProvider): void {
    this.settingsProvider = provider;
  }
}
