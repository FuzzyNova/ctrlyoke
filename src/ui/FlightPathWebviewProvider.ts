import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  PROVIDER_IDS,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  StatusMessageSeverity,
  DEFAULT_MODELS,
  QUEUE_POSITION,
} from "../types/DashboardConstants";
import { CliEvent } from "../types/CliOutputTypes";
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
  isRegistryInitialized,
} from "../utils/ModelRegistry";
import {
  getModelDisplayName,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODEL_LABELS,
} from "../utils/ModelConstants";
import { FlightPathManager } from "../flightpath/FlightPathManager";
import { Provider } from "../types/FlightPathTypes";
import { DashboardOutput } from "../flightpath/cli/shared/CliOutputFormatter";
import { AgentDiscovery, AgentInfo } from "../utils/AgentDiscovery";

const execAsync = promisify(exec);

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

/**
 * Provider availability status
 */
interface ProviderStatus {
  available: boolean;
  status: "checking" | "available" | "unavailable";
  message?: string;
}

/**
 * Unified FlightPath WebviewViewProvider (React UI)
 * Combines functionality from FlightPathDashboardProvider and FlightPathSettingsProvider
 * Manages communication between extension and React webview
 */
export class FlightPathWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private flightPathManager?: FlightPathManager;
  private templateManager: TemplateManager;
  private configChangeDisposable?: vscode.Disposable;
  private modelsLoadedDisposable?: vscode.Disposable;

  // Discovered agents
  private availableAgents: AgentInfo[] = [];

  // Current workflow name (cached from queue)
  private currentWorkflowName: string | undefined;

  // Provider availability status
  private providerStatus: Record<string, ProviderStatus> = {
    [PROVIDER_IDS.COPILOT_CLI]: { available: false, status: "checking" },
    [PROVIDER_IDS.COPILOT_CHAT]: { available: false, status: "checking" },
    [PROVIDER_IDS.CLAUDE_CLI]: { available: false, status: "checking" },
    [PROVIDER_IDS.CODEX_CLI]: { available: false, status: "checking" },
  };

  // Pending workflow properties (set before workflow is created)
  private pendingWorkflowProperties: {
    provider?: string;
    model?: string;
    agent?: string;
    resumeSession?: boolean;
    allowDynamicExtension?: boolean;
    endCondition?: any;
  } = {};

  // Setting keys for each provider's model
  private static readonly MODEL_SETTING_MAP: Record<string, string> = {
    [PROVIDER_IDS.COPILOT_CLI]: "copilotCliModel",
    [PROVIDER_IDS.COPILOT_CHAT]: "copilotChatModel",
    [PROVIDER_IDS.CLAUDE_CLI]: "claudeCliModel",
    [PROVIDER_IDS.CODEX_CLI]: "codexCliModel",
  };

  // Validation constants
  private static readonly VALID_PROVIDERS = [
    PROVIDER_IDS.COPILOT_CLI,
    PROVIDER_IDS.COPILOT_CHAT,
    PROVIDER_IDS.CLAUDE_CLI,
    PROVIDER_IDS.CODEX_CLI,
  ] as const;

  private static readonly VALID_EXECUTION_MODES = [
    "interactive",
    "headless",
  ] as const;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.templateManager = new TemplateManager(context);

    // Listen for model registry updates
    this.modelsLoadedDisposable = onModelsLoaded(() => {
      this.sendModelOptionsUpdate();
    });

    // Listen for configuration changes to sync settings view
    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("flightpath")) {
          this.sendInitialState();
        }
      }
    );

    // Discover available agents in background
    this.discoverAgents();

    // Check provider availability in background
    this.checkProviderAvailability();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    console.log("FlightPath: resolveWebviewView called");
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(
          this.context.extensionUri,
          "out",
          "ui",
          "webview-react"
        ),
        vscode.Uri.joinPath(this.context.extensionUri, "images"),
      ],
    };

    const html = this._getHtmlForWebview(webviewView.webview);
    console.log("FlightPath: Generated HTML length:", html.length);
    console.log("FlightPath: HTML preview:", html.substring(0, 500));

    // Write full HTML to debug file for inspection
    const fs = require("fs");
    const path = require("path");
    const debugPath = path.join(
      this.context.extensionPath,
      "out",
      "debug-webview.html"
    );
    try {
      fs.writeFileSync(debugPath, html, "utf8");
      console.log("FlightPath: Full HTML written to:", debugPath);
    } catch (err) {
      console.error("FlightPath: Failed to write debug HTML:", err);
    }

    webviewView.webview.html = html;

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      console.log("FlightPath: Received message from webview:", message.type);
      this.handleWebviewMessage(message);
    });

    console.log("FlightPath: Webview initialized, waiting for READY message");
  }

  /**
   * Load built React app HTML and inject webview URIs
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "out",
      "ui",
      "webview-react",
      "index.html"
    );

    let html = fsSync.readFileSync(htmlPath.fsPath, "utf-8");

    // Get base URI for webview resources
    const webviewRootUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react"
      )
    );

    // Replace all relative paths with webview URIs
    // Vite outputs: /assets/index-[hash].js, /assets/index-[hash].css, etc.
    html = html.replace(/\/assets\//g, `${webviewRootUri}/assets/`);

    // Replace placeholder URIs with actual webview resource URIs
    const typoJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react",
        "typo.js"
      )
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react",
        "codicons",
        "codicon.css"
      )
    );
    const customIconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react",
        "custom-icons.css"
      )
    );
    const affUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react",
        "dictionaries",
        "en_US",
        "en_US.aff"
      )
    );
    const dicUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "ui",
        "webview-react",
        "dictionaries",
        "en_US",
        "en_US.dic"
      )
    );
    html = html.replace(/\{\{typoUri\}\}/g, typoJsUri.toString());
    html = html.replace(/\{\{codiconsUri\}\}/g, codiconsUri.toString());
    html = html.replace(/\{\{customIconsUri\}\}/g, customIconsUri.toString());

    // Inject dictionary URIs as data attributes on <body> for Typo.js spell checking
    html = html.replace(
      "<body>",
      `<body data-aff-uri="${affUri}" data-dic-uri="${dicUri}">`
    );

    // Inject VS Code API capture script BEFORE any other scripts
    // acquireVsCodeApi() can only be called once, so we capture it and make it globally available
    // This must run before the React module script loads
    const vscodeApiScript = `<script>
window.vscodeApi = acquireVsCodeApi();
console.log("FlightPath: VS Code API captured:", !!window.vscodeApi);
</script>`;

    // Inject AFTER typo.js script tag but BEFORE the module scripts
    const beforeReplace = html;
    html = html.replace(
      /<script type="module"/,
      `${vscodeApiScript}\n    <script type="module"`
    );

    if (html === beforeReplace) {
      console.log(
        "FlightPath: WARNING - Failed to inject VS Code API script (no module script found)"
      );
    } else {
      console.log("FlightPath: Injected VS Code API capture script");
      console.log("FlightPath: Injected script content:", vscodeApiScript);
    }

    // Replace CSP meta tag with correct policy for VS Code webview
    // - script-src: Allow VS Code webview scripts (for acquireVsCodeApi)
    // - style-src: Allow inline styles (Tailwind uses style tags)
    // - font-src: Allow webview fonts
    // - img-src: Allow webview images and data URIs
    // - connect-src: Allow source map loading in dev tools
    const cspContent = `default-src 'none'; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:; connect-src ${webview.cspSource};`;

    // Replace existing CSP meta tag — regex handles multi-line tags and both /> and > closings
    const htmlBeforeCsp = html;
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
      `<meta http-equiv="Content-Security-Policy" content="${cspContent}" />`
    );
    if (html === htmlBeforeCsp) {
      // No existing CSP tag found, add one before </head>
      html = html.replace(
        "</head>",
        `    <meta http-equiv="Content-Security-Policy" content="${cspContent}" />\n  </head>`
      );
    }

    return html;
  }

  /**
   * Handle messages from webview (React UI)
   */
  private async handleWebviewMessage(message: any): Promise<void> {
    try {
      switch (message.type) {
        // ============================================================================
        // Lifecycle Messages
        // ============================================================================
        case MESSAGE_TYPES.READY:
          this.sendInitialState();
          // Notify FlightPathManager that dashboard is ready (triggers deferred auto-load)
          if (this.flightPathManager) {
            await this.flightPathManager.setDashboardReady();
          }
          break;

        // ============================================================================
        // Dashboard Messages - Workflow Control
        // ============================================================================
        case MESSAGE_TYPES.NEW_PROMPT:
          vscode.commands.executeCommand("flightpath.createDraftPrompt");
          break;

        case MESSAGE_TYPES.SELECT_FILE:
          vscode.commands.executeCommand("flightpath.selectPromptFile");
          break;

        case MESSAGE_TYPES.APPEND_FILE:
          vscode.commands.executeCommand("flightpath.appendFromDashboard");
          break;

        case MESSAGE_TYPES.EDIT_FILE:
          vscode.commands.executeCommand("flightpath.editCurrentPromptFile");
          break;

        case MESSAGE_TYPES.CLEAR_WORKFLOW:
          this.handleClearWorkflow();
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

        case MESSAGE_TYPES.EXPORT_OUTPUT:
          this.handleExportOutput(message.content, message.fileName);
          break;

        // ============================================================================
        // Dashboard Messages - Prompt Editor
        // ============================================================================
        case MESSAGE_TYPES.EXECUTE_PROMPT:
          this.handleExecutePrompt(message);
          break;

        case MESSAGE_TYPES.UPDATE_PROMPT:
          this.handleUpdatePrompt(message);
          break;

        case MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT:
          this.handleSelectPromptForEdit(message);
          break;

        case MESSAGE_TYPES.DELETE_PROMPT:
          this.handleDeletePrompt(message);
          break;

        // ============================================================================
        // Dashboard Messages - CodeMirror Editor
        // ============================================================================
        case MESSAGE_TYPES.REQUEST_COMPLETIONS:
          this.handleCompletionRequest(
            message.trigger,
            message.prefix,
            message.position
          );
          break;

        case MESSAGE_TYPES.OPEN_FILE:
          this.handleOpenFile(message.path, message.lineStart, message.lineEnd);
          break;

        // ============================================================================
        // Dashboard Messages - New Workflow Modal
        // ============================================================================
        case MESSAGE_TYPES.NEW_WORKFLOW:
          this.handleNewWorkflow();
          break;

        case MESSAGE_TYPES.TEMPLATE_SELECTED:
          this.handleTemplateSelected(message.templateId);
          break;

        case MESSAGE_TYPES.SET_DEFAULT_TEMPLATE:
          this.handleSetDefaultTemplate(message.templateId);
          break;

        case MESSAGE_TYPES.CREATE_WORKFLOW:
          this.handleCreateWorkflow(message);
          break;

        case MESSAGE_TYPES.CREATE_NEW_TEMPLATE:
          this.handleCreateNewTemplate();
          break;

        // ============================================================================
        // Dashboard Messages - Workflow Status
        // ============================================================================
        case MESSAGE_TYPES.UPDATE_WORKFLOW_NAME:
          this.handleUpdateWorkflowName(message);
          break;

        case MESSAGE_TYPES.GET_RECENT_WORKFLOWS:
          this.handleGetRecentWorkflows();
          break;

        case MESSAGE_TYPES.LOAD_WORKFLOW:
          this.handleLoadWorkflow(message);
          break;

        case MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY:
          this.handleClearWorkflowHistory();
          break;

        // ============================================================================
        // Settings Messages - Provider & Model Selection
        // ============================================================================
        case MESSAGE_TYPES.CHANGE_PROVIDER:
          this.handleProviderChange(message.provider);
          break;

        case MESSAGE_TYPES.CHANGE_MODEL:
          this.handleModelChange(message.model);
          break;

        case MESSAGE_TYPES.CHANGE_AGENT:
          this.handleAgentChange(message.agent);
          break;

        case MESSAGE_TYPES.CHANGE_EXECUTION_MODE:
          this.handleExecutionModeChange(message.mode);
          break;

        case MESSAGE_TYPES.CHANGE_RESUME_SESSION:
          this.handleResumeSessionChange(message.enabled);
          break;

        case MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE:
          this.handleDynamicQueueChange(message.enabled);
          break;

        case MESSAGE_TYPES.OPEN_SETTINGS:
          this.handleOpenSettings();
          break;

        // ============================================================================
        // Settings Messages - Workflow Properties
        // ============================================================================
        case MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY:
          this.handleUpdateWorkflowProperty(message.property, message.value);
          break;

        case MESSAGE_TYPES.SET_AS_DEFAULT:
          this.handleSetAsDefault(
            message.property,
            message.value,
            message.provider
          );
          break;

        case MESSAGE_TYPES.GET_CONFIG:
          this.handleGetConfig(message.key);
          break;

        case MESSAGE_TYPES.UPDATE_CONFIG:
          this.handleUpdateConfig(message.key, message.value);
          break;

        default:
          Log.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Log.error(`Error handling webview message (${message.type}):`, errorMsg);
    }
  }

  // ============================================================================
  // Public API - FlightPathManager -> Webview Updates
  // ============================================================================

  /**
   * Update dashboard when a workflow file is selected
   */
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

  /**
   * Update dashboard when session is restored from working file
   */
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
      prompts,
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
    this.postMessage({ type: MESSAGE_TYPES.CLI_OUTPUT, stepIndex, output });
  }

  public updateCliStreamingChunk(stepIndex: number, chunk: string): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_STREAMING_CHUNK,
      stepIndex,
      chunk,
    });
  }

  public updateCliStreamingEvents(stepIndex: number, events: CliEvent[]): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_STREAMING_EVENTS,
      stepIndex,
      events,
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
    this.postMessage({
      type: MESSAGE_TYPES.PROMPTS_EXTENDED,
      prompts,
    });
  }

  public updatePromptDeleted(fileName: string, prompts: any[]): void {
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

  public updateWorkflowName(workflowName: string): void {
    this.postMessage({
      type: MESSAGE_TYPES.WORKFLOW_NAME_UPDATED,
      workflowName,
    });
  }

  /**
   * Set FlightPathManager reference (called after construction to avoid circular dependency)
   */
  public setFlightPathManager(manager: any): void {
    this.flightPathManager = manager;
  }

  /**
   * Open new workflow modal in the webview
   */
  public openNewWorkflowModal(): void {
    this.postMessage({
      type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
    });
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.configChangeDisposable?.dispose();
    this.modelsLoadedDisposable?.dispose();
  }

  // ============================================================================
  // Private Methods - Message Sending
  // ============================================================================

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private sendInitialState(): void {
    if (!this.view) {
      return;
    }

    // Get current workflow state from FlightPathManager
    const workflowState = this.getCurrentState();

    // Get global settings
    const provider = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForProvider(provider);
    const agent = ConfigurationUtils.getCustomAgent();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;

    const globalSettings = {
      provider,
      model,
      agent,
      executionMode,
      resumeSession: resumeExistingSession,
      allowDynamicExtension: dynamicQueueEnabled,
    };

    // Build dynamic model options from ModelRegistry
    const modelOptions = this.buildModelOptions();

    this.postMessage({
      type: MESSAGE_TYPES.INIT,
      data: {
        ...workflowState,
        globalSettings,
        workflowProperties: {},
        modelOptions,
        providerStatus: this.providerStatus,
        availableAgents: this.availableAgents,
      },
    });
  }

  private getCurrentState(): any {
    // Get actual state from FlightPathManager if available
    if (this.flightPathManager) {
      const queueState = this.flightPathManager.getQueueState();
      const currentFile = this.flightPathManager.getCurrentPromptFile();
      // Get workflow name from queue state (not from FlightPathManager which doesn't have getWorkflowName)
      const workflowName = queueState.workflowName;
      // Update cached workflow name
      this.currentWorkflowName = workflowName;

      return {
        fileName: currentFile || "",
        workflowName: workflowName || "",
        prompts: queueState.prompts || [],
        executionState: queueState.status || EXECUTION_STATES.IDLE,
        currentIndex: queueState.currentIndex || 0,
        results: queueState.results || [],
      };
    }

    // Default state
    return {
      fileName: "",
      workflowName: "",
      prompts: [],
      executionState: EXECUTION_STATES.IDLE,
      currentIndex: 0,
      results: [],
    };
  }

  /**
   * Build model options for all providers
   */
  private buildModelOptions(): Record<
    string,
    Array<{ value: string; label: string }>
  > {
    const chatModels = getAvailableModelsSync();
    const cliModelIds = getCliSupportedModelIdsSync();
    const hiddenModels = new Set(["copilot-fast"]);

    const copilotChatOptions = chatModels
      .filter((m) => !hiddenModels.has(m.id))
      .map((m) => ({
        value: m.id,
        label: getModelDisplayName(m.id),
      }));

    const copilotCliOptions = cliModelIds
      .filter((id) => !hiddenModels.has(id))
      .map((id) => ({
        value: id,
        label: getModelDisplayName(id),
      }));

    const claudeCliOptions = Object.entries(CLAUDE_CLI_MODEL_LABELS).map(
      ([value, label]) => ({ value, label })
    );

    const codexCliOptions = Object.entries(CODEX_CLI_MODEL_LABELS).map(
      ([value, label]) => ({ value, label })
    );

    return {
      [PROVIDER_IDS.COPILOT_CLI]: copilotCliOptions,
      [PROVIDER_IDS.COPILOT_CHAT]: copilotChatOptions,
      [PROVIDER_IDS.CLAUDE_CLI]: claudeCliOptions,
      [PROVIDER_IDS.CODEX_CLI]: codexCliOptions,
    };
  }

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

  private sendProviderStatusUpdate(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.PROVIDER_STATUS_UPDATE,
      data: { providerStatus: this.providerStatus },
    });
  }

  private sendAgentsUpdate(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.AGENTS_UPDATE,
      data: { availableAgents: this.availableAgents },
    });
  }

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
        resumeSession: workingFile.resumeSession,
        allowDynamicExtension: workingFile.allowDynamicExtension,
        endCondition: workingFile.endCondition,
      };

      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
        workflowProperties,
      });

      // Also send WORKFLOW_LOADED to enable settings UI
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_LOADED,
      });
    } catch (error) {
      Log.error("Failed to send workflow properties to settings:", error);
    }
  }

  private sendWorkflowUnloadedToSettings(): void {
    this.postMessage({
      type: MESSAGE_TYPES.WORKFLOW_UNLOADED,
    });
  }

  // ============================================================================
  // Private Methods - Message Handlers (Dashboard)
  // ============================================================================

  private handleClearWorkflow(): void {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    this.sendWorkflowUnloadedToSettings();
    this.flightPathManager.clearWorkflow();
    this.updateFileSelected("New Workflow", [], undefined);
    Log.info("Workflow cleared, ready for new prompts");
  }

  private async handleExportOutput(
    content: string,
    fileName?: string
  ): Promise<void> {
    const defaultFileName = fileName || "flightpath-output.md";
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultFileName),
      filters: {
        "Markdown Files": ["md"],
        "Text Files": ["txt"],
        "All Files": ["*"],
      },
    });

    if (uri) {
      await fs.writeFile(uri.fsPath, content, "utf-8");
      vscode.window.showInformationMessage(`Output exported to ${uri.fsPath}`);
    }
  }

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

  private handleSelectPromptForEdit(message: any): void {
    // Just echo back to webview - handled by React state
    this.postMessage({
      type: MESSAGE_TYPES.SELECT_PROMPT_FOR_EDIT,
      index: message.index,
    });
  }

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

  private async handleCompletionRequest(
    trigger: string,
    prefix: string,
    position: { line: number; character: number }
  ): Promise<void> {
    try {
      let completions: Array<{ label: string; detail?: string }> = [];

      if (trigger === "@") {
        completions = await getFileCompletions(prefix);
      } else if (trigger === "#") {
        completions = await getHashCompletions(prefix);
      }

      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        completions,
        trigger,
      });
    } catch (error) {
      Log.error("Failed to get completions:", error);
      this.postMessage({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        completions: [],
        trigger,
      });
    }
  }

  private async handleOpenFile(
    path: string,
    lineStart?: number,
    lineEnd?: number
  ): Promise<void> {
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      if (lineStart !== undefined) {
        const start = new vscode.Position(lineStart - 1, 0);
        const end = new vscode.Position(
          lineEnd !== undefined ? lineEnd - 1 : lineStart - 1,
          0
        );
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(
          new vscode.Range(start, end),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (error) {
      Log.error("Failed to open file:", error);
      vscode.window.showErrorMessage(`Failed to open file: ${path}`);
    }
  }

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

  private async handleTemplateSelected(templateId: string): Promise<void> {
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      this.postMessage({
        type: MESSAGE_TYPES.TEMPLATE_INFO,
        template,
      });
    } catch (error) {
      Log.error("Failed to load template:", error);
    }
  }

  private async handleSetDefaultTemplate(templateId: string): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration("flightpath")
        .update("defaultWorkflowTemplate", templateId, true);

      this.postMessage({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        templateId,
      });
    } catch (error) {
      Log.error("Failed to set default template:", error);
    }
  }

  private async handleCreateWorkflow(message: any): Promise<void> {
    try {
      const { templateId, fileName, variables } = message;
      // TODO: Implement createWorkflowFromTemplate in WorkflowCommandHandler
      // For now, show not implemented message
      vscode.window.showWarningMessage(
        "Creating workflows from templates is not yet implemented. Please use 'FlightPath: Create Prompt File' command."
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to create workflow: ${errorMsg}`);
    }
  }

  private handleCreateNewTemplate(): void {
    vscode.commands.executeCommand("flightpath.createPromptFile");
  }

  private async handleUpdateWorkflowName(message: any): Promise<void> {
    if (!this.flightPathManager) {
      Log.error("FlightPathManager not initialized");
      return;
    }

    const { workflowName } = message;
    await this.flightPathManager.updateWorkflowName?.(workflowName);
    this.updateWorkflowName(workflowName);
  }

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

  private async handleLoadWorkflow(message: any): Promise<void> {
    const { filePath } = message;
    vscode.commands.executeCommand("flightpath.selectPromptFile", filePath);
  }

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

        vscode.window.showInformationMessage(
          `Deleted ${workflowFiles.length} workflow history files`
        );

        // Refresh recent workflows list
        this.postMessage({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
      } catch (error) {
        Log.error("Failed to delete workflow files:", error);
        vscode.window.showErrorMessage(
          `Failed to delete workflow history: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      Log.error("Failed to clear workflow history:", error);
    }
  }

  // ============================================================================
  // Private Methods - Message Handlers (Settings)
  // ============================================================================

  private async handleProviderChange(provider: string): Promise<void> {
    if (!FlightPathWebviewProvider.VALID_PROVIDERS.includes(provider as any)) {
      Log.error(`Invalid provider: ${provider}`);
      return;
    }

    await vscode.workspace
      .getConfiguration("flightpath")
      .update("provider", provider, true);

    this.sendInitialState();
  }

  private async handleModelChange(model: string): Promise<void> {
    const provider = ConfigurationUtils.getIntegrationMode();
    const settingKey =
      FlightPathWebviewProvider.MODEL_SETTING_MAP[provider] ||
      "copilotCliModel";

    await vscode.workspace
      .getConfiguration("flightpath")
      .update(settingKey, model, true);

    this.sendInitialState();
  }

  private async handleAgentChange(agent: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update("customAgent", agent, true);

    this.sendInitialState();
  }

  private async handleExecutionModeChange(mode: string): Promise<void> {
    if (
      !FlightPathWebviewProvider.VALID_EXECUTION_MODES.includes(mode as any)
    ) {
      Log.error(`Invalid execution mode: ${mode}`);
      return;
    }

    await vscode.workspace
      .getConfiguration("flightpath")
      .update("cliExecutionMode", mode, true);

    this.sendInitialState();
  }

  private async handleResumeSessionChange(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update("resumeExistingSession", enabled, true);

    this.sendInitialState();
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update("enableDynamicQueue", enabled, true);

    this.sendInitialState();
  }

  private handleOpenSettings(): void {
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:flightpath"
    );
  }

  private async handleUpdateWorkflowProperty(
    property: string,
    value: any
  ): Promise<void> {
    if (!this.flightPathManager) {
      // Store in pending properties if workflow not loaded yet
      (this.pendingWorkflowProperties as any)[property] = value;
      return;
    }

    await this.flightPathManager.updateWorkflowPropertyInQueue(property, value);
    this.sendWorkflowPropertiesToSettings();
  }

  private async handleSetAsDefault(
    property: string,
    value: any,
    provider?: string
  ): Promise<void> {
    let settingKey = property;

    // Map property to setting key
    if (property === "model" && provider) {
      settingKey =
        FlightPathWebviewProvider.MODEL_SETTING_MAP[provider] ||
        "copilotCliModel";
    }

    await vscode.workspace
      .getConfiguration("flightpath")
      .update(settingKey, value, true);

    this.sendInitialState();
  }

  private async handleGetConfig(key: string): Promise<void> {
    const value = vscode.workspace.getConfiguration("flightpath").get(key);

    this.postMessage({
      type: MESSAGE_TYPES.CONFIG_VALUE,
      key,
      value,
    });
  }

  private async handleUpdateConfig(key: string, value: any): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update(key, value, true);

    this.sendInitialState();
  }

  // ============================================================================
  // Private Methods - Utilities
  // ============================================================================

  private getModelForProvider(provider: string): string {
    const settingKey =
      FlightPathWebviewProvider.MODEL_SETTING_MAP[provider] ||
      "copilotCliModel";
    const model = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>(settingKey);
    return model || (DEFAULT_MODELS as any)[provider] || "claude-sonnet-4.5";
  }

  private async applyPendingWorkflowProperties(): Promise<void> {
    if (Object.keys(this.pendingWorkflowProperties).length === 0) {
      return;
    }

    if (!this.flightPathManager) {
      return;
    }

    for (const [property, value] of Object.entries(
      this.pendingWorkflowProperties
    )) {
      await this.flightPathManager.updateWorkflowPropertyInQueue(
        property,
        value
      );
    }

    this.pendingWorkflowProperties = {};
    this.sendWorkflowPropertiesToSettings();
  }

  private async checkProviderAvailability(): Promise<void> {
    await this.checkCliAvailability(PROVIDER_IDS.COPILOT_CLI, "copilot");
    await this.checkCliAvailability(PROVIDER_IDS.CLAUDE_CLI, "claude");
    await this.checkCliAvailability(PROVIDER_IDS.CODEX_CLI, "codex");
    await this.checkCopilotChatAvailability();

    this.sendProviderStatusUpdate();
  }

  private async checkCliAvailability(
    providerId: string,
    command: string
  ): Promise<void> {
    try {
      const { stdout } = await execAsync(`${command} --version`, {
        timeout: 5000,
      });
      this.providerStatus[providerId] = {
        available: true,
        status: "available",
        message: stdout.trim(),
      };
    } catch {
      this.providerStatus[providerId] = {
        available: false,
        status: "unavailable",
        message: "Not installed or not in PATH",
      };
    }
  }

  private async checkCopilotChatAvailability(): Promise<void> {
    try {
      const copilotExtension = vscode.extensions.getExtension("GitHub.copilot");
      const copilotChatExtension = vscode.extensions.getExtension(
        "GitHub.copilot-chat"
      );

      const hasExtension = !!(copilotExtension || copilotChatExtension);

      if (!hasExtension) {
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
          available: false,
          status: "unavailable",
          message: "GitHub Copilot extension not installed",
        };
        return;
      }

      const commands = await vscode.commands.getCommands();
      const hasChatSubmit = commands.includes("workbench.action.chat.submit");
      const hasChatPanel = commands.includes(
        "workbench.panel.chat.view.copilot.focus"
      );

      if (hasChatSubmit && hasChatPanel) {
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
          available: true,
          status: "available",
          message: "GitHub Copilot Chat",
        };
      } else {
        this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
          available: false,
          status: "unavailable",
          message: "Copilot Chat commands not available",
        };
      }
    } catch (error) {
      this.providerStatus[PROVIDER_IDS.COPILOT_CHAT] = {
        available: false,
        status: "unavailable",
        message: "Error checking Copilot Chat availability",
      };
    }
  }

  private async discoverAgents(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
      }

      // Pass WorkspaceFolder object, not just the path string
      this.availableAgents = await AgentDiscovery.discoverAgents(
        workspaceFolders[0]
      );

      this.sendAgentsUpdate();
    } catch (error) {
      Log.error("Failed to discover agents:", error);
    }
  }
}
