import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import {
  MESSAGE_TYPES,
  LOG_LEVELS,
  EXECUTION_STATES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  STEP_STATUS,
  STATUS_MESSAGE_SEVERITY,
  StatusMessageSeverity,
  DEFAULT_MODELS,
  QUEUE_POSITION,
  type HarnessStatusString,
  type WebviewLogLevel,
} from "../types/DashboardConstants";
import { CliEvent, CliOutputData } from "../types/WebviewMessageTypes";
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
import { Harness } from "../types/FlightPathTypes";
import { DashboardOutput } from "../flightpath/cli/shared/CliOutputFormatter";
import { AgentDiscovery, AgentInfo } from "../utils/AgentDiscovery";
import { OutputHistoryManager } from "../flightpath/orchestration/OutputHistoryManager";
import { ContextExpander } from "../utils/ContextExpander";
import { encode } from "gpt-tokenizer";

// Re-export CliOutputData for external use
export type { CliOutputData } from "../types/WebviewMessageTypes";

/**
 * Harness availability status
 */
interface HarnessStatus {
  available: boolean;
  status: HarnessStatusString;
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
  private outputHistoryManager?: OutputHistoryManager;
  private templateManager: TemplateManager;
  private configChangeDisposable?: vscode.Disposable;
  private modelsLoadedDisposable?: vscode.Disposable;

  // Discovered agents
  private availableAgents: AgentInfo[] = [];

  // Current workflow name (cached from queue)
  private currentWorkflowName: string | undefined;

  // Harness availability status
  private harnessStatus: Record<string, HarnessStatus> = {
    [HARNESS_IDS.COPILOT_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.COPILOT_CHAT]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.CLAUDE_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
    [HARNESS_IDS.CODEX_CLI]: {
      available: false,
      status: HARNESS_STATUS_STRINGS.CHECKING,
    },
  };

  // Pending workflow properties (set before workflow is created)
  private pendingWorkflowProperties: {
    harness?: string;
    model?: string;
    agent?: string;
    resumeSession?: boolean;
    sessionId?: string | number;
    allowDynamicExtension?: boolean;
    endCondition?: any;
  } = {};

  // Validation constants
  private static readonly VALID_HARNESSES = [
    HARNESS_IDS.COPILOT_CLI,
    HARNESS_IDS.COPILOT_CHAT,
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.CODEX_CLI,
  ] as const;

  private static readonly VALID_EXECUTION_MODES = [
    "interactive",
    "headless",
  ] as const;

  /**
   * Get the webview-react directory URI
   */
  private get webviewReactUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      "out",
      "ui",
      "webview-react"
    );
  }

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
          this.sendGlobalSettingsUpdate();
        }
      }
    );

    // Discover available agents in background
    this.discoverAgents();

    // Harness availability is driven by FlightPathManager via notifyHarnessAvailability()
    // (subscribes to onDidChangeStatus on all integrations — single source of truth).
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
        this.webviewReactUri,
        vscode.Uri.joinPath(this.context.extensionUri, "images"),
      ],
    };

    const html = this._getHtmlForWebview(webviewView.webview);
    webviewView.webview.html = html;

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message);
    });

    Log.info("resolveWebviewView() complete — view is now set");

    // Best-effort early INIT: VS Code buffers postMessage until the
    // webview iframe loads, but React's message listener may not be
    // attached yet. The READY handler sends INIT again as a
    // guaranteed fallback once React confirms it is listening.
    this.sendInitialState();
  }

  /**
   * Load built React app HTML and inject webview URIs
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.webviewReactUri, "index.html");

    let html = fsSync.readFileSync(htmlPath.fsPath, "utf-8");

    // Get base URI for webview resources
    const webviewRootUri = webview.asWebviewUri(this.webviewReactUri);

    // Replace all relative paths with webview URIs
    // Vite outputs: /assets/index-[hash].js, /assets/index-[hash].css, etc.
    html = html.replace(/\/assets\//g, `${webviewRootUri}/assets/`);

    // Replace placeholder URIs with actual webview resource URIs
    const typoJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.webviewReactUri, "typo.js")
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.webviewReactUri, "codicons", "codicon.css")
    );
    const customIconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.webviewReactUri, "custom-icons.css")
    );
    const affUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.webviewReactUri,
        "dictionaries",
        "en_US",
        "en_US.aff"
      )
    );
    const dicUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.webviewReactUri,
        "dictionaries",
        "en_US",
        "en_US.dic"
      )
    );
    html = html.replace(/\{\{typoUri\}\}/g, typoJsUri.toString());
    html = html.replace(/\{\{codiconsUri\}\}/g, codiconsUri.toString());
    html = html.replace(/\{\{customIconsUri\}\}/g, customIconsUri.toString());

    // Inject logo URI for background display
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "images",
        "flightpath-icon.svg"
      )
    );
    html = html.replace(/\{\{logoUri\}\}/g, logoUri.toString());

    // Inject dictionary URIs as data attributes on <body> for Typo.js spell checking
    html = html.replace(
      "<body>",
      `<body data-aff-uri="${affUri}" data-dic-uri="${dicUri}" data-logo-uri="${logoUri}">`
    );

    // Inject VS Code API capture script BEFORE any other scripts
    // acquireVsCodeApi() can only be called once, so we capture it and make it globally available
    // This must run before the React module script loads
    const vscodeApiScript = `<script>
window.vscodeApi = acquireVsCodeApi();
</script>`;

    // Inject AFTER typo.js script tag but BEFORE the module scripts
    html = html.replace(
      /<script type="module"/,
      `${vscodeApiScript}\n    <script type="module"`
    );

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
          Log.info("Received READY from React — sending INIT");
          // Guaranteed delivery: React's message listener is now attached.
          // The early INIT from resolveWebviewView() may have been lost
          // if it arrived before React mounted.
          this.sendInitialState();
          // Trigger auto-load of recent session now that React is mounted.
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
          await this.handleCompletionRequest(
            message.trigger,
            message.prefix,
            message.position
          );
          break;

        case MESSAGE_TYPES.OPEN_FILE:
          this.handleOpenFile(message.path, message.lineStart, message.lineEnd);
          break;

        case MESSAGE_TYPES.REQUEST_ATTACHMENT_TOKEN_COUNTS:
          await this.handleAttachmentTokenCountRequest(message.references);
          break;

        // ============================================================================
        // Output History Messages
        // ============================================================================
        case MESSAGE_TYPES.LOAD_RUN_HISTORY:
          await this.handleLoadRunHistory(message.runIndex);
          break;

        case MESSAGE_TYPES.CLEAR_RUN_HISTORY:
          await this.handleClearRunHistory();
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
        // Settings Messages - Harness & Model Selection
        // ============================================================================
        case MESSAGE_TYPES.CHANGE_HARNESS:
          this.handleHarnessChange(message.harness);
          break;

        case MESSAGE_TYPES.CHANGE_MODEL:
          this.handleModelChange(message.model);
          break;

        case MESSAGE_TYPES.CHANGE_AGENT:
          this.handleAgentChange(message.agent);
          break;

        case MESSAGE_TYPES.CHANGE_EXECUTION_MODE:
          this.handleExecutionModeChange(message.executionMode);
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
            message.harness
          );
          break;

        case MESSAGE_TYPES.GET_CONFIG:
          this.handleGetConfig(message.key);
          break;

        case MESSAGE_TYPES.UPDATE_CONFIG:
          this.handleUpdateConfig(message.key, message.value);
          break;

        case MESSAGE_TYPES.LOG_MESSAGE:
          this.handleWebviewLog(message.level, message.message);
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

  public updateExecutionStarted(
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.EXECUTION_STARTED,
      fileName,
      totalSteps,
      ...(isContinuation ? { isContinuation: true, preserveStepCount } : {}),
    });
  }

  public notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.RUN_HISTORY_UPDATED,
      runCount,
      runTimestamps,
      runStates,
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
   * Set OutputHistoryManager reference (called after construction)
   */
  public setOutputHistoryManager(manager: OutputHistoryManager): void {
    this.outputHistoryManager = manager;
  }

  /**
   * Load and send the most recent output history for a workflow to the webview.
   * Called after session restore when autoLoadRecentSession is enabled.
   * Reads available runs directly from disk — the .history/ directory is the
   * single source of truth, not anything stored in the working file.
   *
   * @param workingFilePath Absolute path to the working file
   */
  public async loadOutputHistoryForWorkflow(
    workingFilePath: string
  ): Promise<void> {
    if (!this.outputHistoryManager) {
      return;
    }

    if (!ConfigurationUtils.shouldAutoLoadRecentSession()) {
      return;
    }

    try {
      const workflowId =
        this.outputHistoryManager.extractWorkflowId(workingFilePath);
      const runs =
        await this.outputHistoryManager.getRunsForWorkflow(workflowId);
      if (!runs.length) {
        return;
      }

      const historyPath = this.outputHistoryManager.getHistoryFilePath(
        workflowId,
        runs[0]
      );

      const history = await this.outputHistoryManager.loadHistory(historyPath);
      const [runTimestamps, runStates] = await Promise.all([
        this.outputHistoryManager.getRunTimestamps(workflowId),
        this.outputHistoryManager.getRunStates(workflowId),
      ]);
      Log.info(
        `[FlightPathWebviewProvider] loadOutputHistoryForWorkflow: sending ${runs.length} runs, timestamps: ${JSON.stringify(runTimestamps)}`
      );

      this.postMessage({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history,
        availableRuns: runs.length,
        currentRunIndex: 0,
        runTimestamps,
        runStates,
      });
    } catch (error) {
      Log.warn("Failed to load output history for workflow:", error);
    }
  }

  /**
   * Update a single harness availability status and push the change to the UI.
   * Called by FlightPathManager after initialization completes so that the
   * authoritative retry-based check overrides the quick no-retry check that
   * runs during construction.
   */
  public notifyHarnessAvailability(
    harnessId: string,
    available: boolean
  ): void {
    this.harnessStatus[harnessId] = {
      available,
      status: available
        ? HARNESS_STATUS_STRINGS.AVAILABLE
        : HARNESS_STATUS_STRINGS.UNAVAILABLE,
    };
    this.sendHarnessStatusUpdate();
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
      Log.info("sendInitialState() skipped — view not set");
      return;
    }

    const harnessStatuses = Object.entries(this.harnessStatus)
      .map(([id, s]) => `${id}=${s.status}`)
      .join(", ");
    Log.info(
      `sendInitialState() — harness: [${harnessStatuses}], agents: ${this.availableAgents.length}`
    );

    // Get current workflow state from FlightPathManager
    const workflowState = this.getCurrentState();

    // Get global settings
    const harness = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForHarness(harness);
    const agent = ConfigurationUtils.getCustomAgent();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;
    const respectGitignore =
      ConfigurationUtils.shouldRespectGitignoreForCompletions();

    const harnessDefaultModels = {
      [HARNESS_IDS.COPILOT_CLI]: this.getModelForHarness(Harness.CopilotCli),
      [HARNESS_IDS.COPILOT_CHAT]: this.getModelForHarness(Harness.CopilotChat),
      [HARNESS_IDS.CLAUDE_CLI]: this.getModelForHarness(Harness.ClaudeCli),
      [HARNESS_IDS.CODEX_CLI]: this.getModelForHarness(Harness.CodexCli),
    };

    const globalSettings = {
      harness,
      model,
      harnessDefaultModels,
      agent,
      executionMode,
      resumeSession: resumeExistingSession,
      allowDynamicExtension: dynamicQueueEnabled,
      respectGitignore,
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
        harnessStatus: this.harnessStatus,
        availableAgents: this.availableAgents,
      },
    });
  }

  /**
   * Send only global settings to the webview without workflow data.
   * Used for configuration changes to avoid resetting the output panel.
   */
  private sendGlobalSettingsUpdate(): void {
    if (!this.view) {
      return;
    }

    const harness = ConfigurationUtils.getIntegrationMode();
    const model = this.getModelForHarness(harness);
    const agent = ConfigurationUtils.getCustomAgent();
    const executionMode = ConfigurationUtils.getCliExecutionMode();
    const resumeExistingSession =
      ConfigurationUtils.shouldResumeExistingSession();
    const dynamicQueueEnabled =
      ConfigurationUtils.getDynamicQueueConfig().enabled;
    const respectGitignore =
      ConfigurationUtils.shouldRespectGitignoreForCompletions();

    const harnessDefaultModels = {
      [HARNESS_IDS.COPILOT_CLI]: this.getModelForHarness(Harness.CopilotCli),
      [HARNESS_IDS.COPILOT_CHAT]: this.getModelForHarness(Harness.CopilotChat),
      [HARNESS_IDS.CLAUDE_CLI]: this.getModelForHarness(Harness.ClaudeCli),
      [HARNESS_IDS.CODEX_CLI]: this.getModelForHarness(Harness.CodexCli),
    };

    this.postMessage({
      type: MESSAGE_TYPES.GLOBAL_SETTINGS_UPDATED,
      globalSettings: {
        harness,
        model,
        harnessDefaultModels,
        agent,
        executionMode,
        resumeSession: resumeExistingSession,
        allowDynamicExtension: dynamicQueueEnabled,
        respectGitignore,
      },
      modelOptions: this.buildModelOptions(),
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
   * Build model options for all harnesses
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
      [HARNESS_IDS.COPILOT_CLI]: copilotCliOptions,
      [HARNESS_IDS.COPILOT_CHAT]: copilotChatOptions,
      [HARNESS_IDS.CLAUDE_CLI]: claudeCliOptions,
      [HARNESS_IDS.CODEX_CLI]: codexCliOptions,
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

  private sendHarnessStatusUpdate(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
      data: { harnessStatus: this.harnessStatus },
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
        harness: workingFile.harness,
        model: workingFile.model,
        agent: workingFile.agent,
        resumeSession: workingFile.resumeSession,
        sessionId: workingFile.sessionId,
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

  public handleClearWorkflow(): void {
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
    // Build a readable export name from the workflow filename
    // e.g. "my-workflow.flightpath.yaml" → "my-workflow.md"
    let baseName = fileName || "flightpath-output";
    baseName = baseName
      .replace(/\.flightpath\.(ya?ml|json)$/i, "")
      .replace(/\.prompt\.md$/i, "");
    if (!baseName.endsWith(".md")) {
      baseName += ".md";
    }

    // Default to .flightpath/output/ in the workspace
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let defaultUri: vscode.Uri;
    if (workspaceRoot) {
      const outputDir = path.join(workspaceRoot, ".flightpath", "output");
      await fs.mkdir(outputDir, { recursive: true });
      defaultUri = vscode.Uri.file(path.join(outputDir, baseName));
    } else {
      defaultUri = vscode.Uri.file(baseName);
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri,
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
    position: number
  ): Promise<void> {
    Log.info(
      `[Dashboard] handleCompletionRequest: trigger="${trigger}", prefix="${prefix}", position=${position}`
    );

    try {
      // Get completion items based on trigger (@file or #file)
      const items = await this.getCompletionItems(trigger, prefix);

      Log.info(
        `[Dashboard] Sending ${items.length} completion items for trigger="${trigger}"`
      );

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
      Log.error("Failed to get completions:", error);
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

    Log.info(
      `[Dashboard] getCompletionItems: trigger="${trigger}", filterText="${filterText}"`
    );

    if (trigger === "@") {
      // Get file and directory completions
      Log.info("[Dashboard] Calling getFileCompletions...");
      const completions = await getFileCompletions(filterText);
      Log.info(
        `[Dashboard] getFileCompletions returned ${completions.length} items`
      );
      return completions;
    } else if (trigger === "#") {
      // Get selection and symbol completions
      Log.info("[Dashboard] Calling getHashCompletions...");
      const completions = await getHashCompletions(filterText);
      Log.info(
        `[Dashboard] getHashCompletions returned ${completions.length} items`
      );
      return completions;
    }

    Log.warn(`[Dashboard] Unknown trigger: "${trigger}"`);
    return [];
  }

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

  /**
   * Handle request to count tokens for attachment references.
   * Uses ContextExpander to expand each raw reference to its actual content,
   * then counts tokens in the attachment XML only (excluding the reference text itself).
   * Results are cached by the webview keyed on the raw reference string.
   *
   * @param references Array of raw reference strings as they appear in the prompt
   *   (e.g. ["@src/foo.ts", "#file:src/bar.ts:10-20", "#sym:src/baz.ts:MyClass:42"])
   */
  private async handleAttachmentTokenCountRequest(
    references: string[]
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot || !references || references.length === 0) {
      this.postMessage({
        type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
        counts: {},
      });
      return;
    }

    const counts: Record<string, number> = {};

    await Promise.all(
      references.map(async (rawRef) => {
        try {
          // Each ContextExpander instance has its own deduplication state,
          // so create a fresh one per reference to get correct per-ref token count.
          const expander = new ContextExpander(workspaceRoot);
          const expanded = await expander.expandContext(rawRef);

          if (expanded === rawRef) {
            // No attachment was generated (reference not found or not expandable)
            counts[rawRef] = 0;
            return;
          }

          // expanded = "<attachment ...>...</attachment>\n\n<rawRef>"
          // Extract only the attachment content (everything before "\n\n<rawRef>")
          const attachmentContent = expanded.slice(
            0,
            expanded.lastIndexOf(`\n\n${rawRef}`)
          );
          counts[rawRef] = encode(attachmentContent).length;
        } catch (error) {
          Log.warn(`Failed to count tokens for reference "${rawRef}":`, error);
          counts[rawRef] = 0;
        }
      })
    );

    this.postMessage({
      type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
      counts,
    });
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
      await ConfigurationUtils.setDefaultWorkflowTemplate(templateId);

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

    try {
      await this.flightPathManager?.loadWorkingFile(filePath);
    } catch (error) {
      Log.error("Failed to load workflow:", error);
      vscode.window.showErrorMessage(
        `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
      const historyDir = path.join(workspaceRoot, ".flightpath", ".history");

      try {
        const files = await fs.readdir(queueDir);
        const workflowFiles = files.filter((f) =>
          f.endsWith(".flightpath.json")
        );

        for (const file of workflowFiles) {
          await fs.unlink(path.join(queueDir, file));
        }

        // Also delete the entire .history directory (all workflow output history)
        try {
          await fs.rm(historyDir, { recursive: true, force: true });
        } catch (historyError) {
          Log.warn("Failed to delete history directory:", historyError);
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

  /**
   * Handle LOAD_RUN_HISTORY: load a specific historical run and send to webview.
   * runIndex 0 = most recent, 1 = second most recent, etc.
   */
  private async handleLoadRunHistory(runIndex: number): Promise<void> {
    if (!this.outputHistoryManager) {
      return;
    }

    try {
      const workingFilePath =
        this.flightPathManager?.getQueueState().workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      // Read available runs directly from disk — single source of truth
      const workflowId =
        this.outputHistoryManager.extractWorkflowId(workingFilePath);
      const runs =
        await this.outputHistoryManager.getRunsForWorkflow(workflowId);
      if (!runs.length) {
        return;
      }

      const fileName = runs[runIndex];
      if (!fileName) {
        Log.warn(`No history file at run index ${runIndex}`);
        return;
      }

      const historyPath = this.outputHistoryManager.getHistoryFilePath(
        workflowId,
        fileName
      );

      const history = await this.outputHistoryManager.loadHistory(historyPath);
      const [runTimestamps, runStates] = await Promise.all([
        this.outputHistoryManager.getRunTimestamps(workflowId),
        this.outputHistoryManager.getRunStates(workflowId),
      ]);

      this.postMessage({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history,
        availableRuns: runs.length,
        currentRunIndex: runIndex,
        runTimestamps,
        runStates,
      });
    } catch (error) {
      Log.error("Failed to load run history:", error);
    }
  }

  /**
   * Handle CLEAR_RUN_HISTORY: delete all history files for the current workflow.
   * Deletes the .history/<workflow-id>/ directory and notifies the webview.
   * No working file changes needed — disk is the single source of truth.
   */
  private async handleClearRunHistory(): Promise<void> {
    if (!this.outputHistoryManager) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      "Delete all output history for this workflow?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return;
    }

    try {
      const workingFilePath =
        this.flightPathManager?.getQueueState().workingFilePath ?? "";
      if (!workingFilePath) {
        return;
      }

      const workflowId =
        this.outputHistoryManager.extractWorkflowId(workingFilePath);
      // Build path to workflow's history directory: .history/<workflow-id>/
      const workflowHistoryDir = path.join(
        this.outputHistoryManager.historyBaseDir,
        workflowId
      );

      // Delete the history directory for this workflow (disk is source of truth)
      try {
        await fs.rm(workflowHistoryDir, { recursive: true, force: true });
      } catch (error) {
        Log.warn("Failed to delete history directory:", error);
      }

      // Notify webview that history was cleared
      this.postMessage({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history: null,
        availableRuns: 0,
        currentRunIndex: 0,
      });

      vscode.window.showInformationMessage("Output history cleared.");
    } catch (error) {
      Log.error("Failed to clear run history:", error);
      vscode.window.showErrorMessage(
        `Failed to clear run history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================================================
  // Private Methods - Message Handlers (Settings)
  // ============================================================================

  private async handleHarnessChange(harness: string): Promise<void> {
    if (!FlightPathWebviewProvider.VALID_HARNESSES.includes(harness as any)) {
      Log.error(`Invalid harness: ${harness}`);
      return;
    }

    await ConfigurationUtils.setIntegrationMode(harness as Harness);
  }

  private async handleModelChange(model: string): Promise<void> {
    const harness = ConfigurationUtils.getIntegrationMode();
    await ConfigurationUtils.setModelForHarness(harness, model);
  }

  private async handleAgentChange(agent: string): Promise<void> {
    await ConfigurationUtils.setCustomAgent(agent);
  }

  private async handleExecutionModeChange(mode: string): Promise<void> {
    if (
      !FlightPathWebviewProvider.VALID_EXECUTION_MODES.includes(mode as any)
    ) {
      Log.error(`Invalid execution mode: ${mode}`);
      return;
    }

    await ConfigurationUtils.setCliExecutionMode(mode);
  }

  private async handleResumeSessionChange(enabled: boolean): Promise<void> {
    await ConfigurationUtils.setResumeExistingSession(enabled);
  }

  private async handleDynamicQueueChange(enabled: boolean): Promise<void> {
    await ConfigurationUtils.setEnableDynamicQueue(enabled);
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
    // Store in pending properties if NO WORKING FILE exists yet
    // Check for actual working file existence instead of just FlightPathManager
    const hasWorkingFile =
      this.flightPathManager?.getQueueState()?.workingFilePath;

    if (!hasWorkingFile) {
      // Store in pending properties until working file exists
      if (value === undefined) {
        delete (this.pendingWorkflowProperties as any)[property];
      } else {
        (this.pendingWorkflowProperties as any)[property] = value;
      }

      // Send back confirmation with pending properties
      this.postMessage({
        type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
        workflowProperties: this.pendingWorkflowProperties,
      });
      return;
    }

    // Working file exists: Update it directly
    // Use updateWorkingFileProperties() which persists to disk
    if (this.flightPathManager) {
      await this.flightPathManager.updateWorkingFileProperties(
        { [property]: value },
        { allowDeletes: value === undefined }
      );

      this.sendWorkflowPropertiesToSettings();
    }
  }

  private async handleSetAsDefault(
    property: string,
    value: any,
    harness?: string
  ): Promise<void> {
    if (property === "model" && harness) {
      await ConfigurationUtils.setModelForHarness(harness as Harness, value);
    } else {
      await ConfigurationUtils.updateSetting(property, value);
    }
  }

  private async handleGetConfig(key: string): Promise<void> {
    const value = ConfigurationUtils.getConfigValue(key);

    this.postMessage({
      type: MESSAGE_TYPES.CONFIG_VALUE,
      key,
      value,
    });
  }

  private async handleUpdateConfig(key: string, value: any): Promise<void> {
    await ConfigurationUtils.updateSetting(key, value);
  }

  private handleWebviewLog(level: WebviewLogLevel, message: string): void {
    const prefixed = `[Webview] ${message}`;
    switch (level) {
      case LOG_LEVELS.DEBUG:
        Log.debug(prefixed);
        break;
      case LOG_LEVELS.WARN:
        Log.warn(prefixed);
        break;
      case LOG_LEVELS.ERROR:
        Log.error(prefixed);
        break;
      default:
        Log.info(prefixed);
        break;
    }
  }

  // ============================================================================
  // Private Methods - Utilities
  // ============================================================================

  private getModelForHarness(harness: string): string {
    return (
      ConfigurationUtils.getModelForHarness(harness as Harness) ||
      (DEFAULT_MODELS as any)[harness] ||
      "claude-sonnet-4.5"
    );
  }

  async applyPendingWorkflowProperties(): Promise<void> {
    if (Object.keys(this.pendingWorkflowProperties).length === 0) {
      return;
    }

    if (!this.flightPathManager) {
      return;
    }

    // Use updateWorkingFileProperties() which persists to disk
    await this.flightPathManager.updateWorkingFileProperties(
      this.pendingWorkflowProperties,
      { ensureHarnessAndModel: true }
    );

    this.pendingWorkflowProperties = {};
    this.sendWorkflowPropertiesToSettings();
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
