import * as vscode from "vscode";
import * as path from "path";
import * as fsSync from "fs";
import {
  DEFAULT_WORKFLOW_NAME,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  type StatusMessageSeverity,
  type StepStatus,
  type FinalStepPhase,
  PANEL_CLIENT_ID,
} from "../types/DashboardConstants";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "../flightpath/harness/PtyProcessManager";
import type {
  CliEvent,
  CliOutput,
  UndoExecutionTarget,
  UndoResult,
  UndoPromptResultMessage,
  UndoRecordUpdatedMessage,
} from "../types/WebviewMessageTypes";
import type {
  WorkspaceSnapshot,
  WorkflowOutputHistory,
  StepOutput,
  UndoRecord,
  OutputExecutionTarget,
} from "../types/OutputHistoryTypes";
import type { WorkflowStep } from "../types/FlightPathTypes";
import { TemplateManager } from "../flightpath/TemplateManager";
import { Log } from "../utils/Log";
import { onModelsLoaded } from "../utils/ModelRegistry";
import { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { WorkflowSummary } from "../types/FlightPathTypes";
import { PostMessageDashboardSink } from "./PostMessageDashboardSink";
import { workflowDisplayStep } from "../types/FlightPathTypes";
import { OutputHistoryManager } from "../flightpath/orchestration/OutputHistoryManager";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { configService } from "../config/FlightPathConfigService";
import { WebviewSettingsSync } from "./WebviewSettingsSync";
import { WorkflowSerializer } from "./WorkflowSerializer";
import { WebviewMessageRouter } from "./WebviewMessageRouter";
import type { IDashboardProvider } from "./IDashboardProvider";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { PostMessageFn } from "./WebviewSettingsSync";
import { DashboardBroadcastHub } from "./DashboardBroadcastHub";

// Re-export CliOutput for external use
export type { CliOutput } from "../types/WebviewMessageTypes";

// Re-export HarnessStatus for external consumers
export type { HarnessStatus } from "./WebviewSettingsSync";

/**
 * Unified FlightPath WebviewViewProvider (React UI)
 *
 * Lifecycle & HTML generation, public update API, and coordination hub.
 * Message routing delegated to WebviewMessageRouter.
 * Settings/config management delegated to WebviewSettingsSync.
 * Save/export/template/history delegated to WorkflowSerializer.
 */
export class FlightPathWebviewProvider
  implements vscode.WebviewViewProvider, IDashboardProvider, IDashboardSink
{
  private view?: vscode.WebviewView;
  private _pendingActiveWorkflowId: string | undefined;
  private workflowOrchestrator?: WorkflowOrchestrator;
  private outputHistoryManager?: OutputHistoryManager;
  private hub?: DashboardBroadcastHub;
  private modelsLoadedDisposable?: vscode.Disposable;
  private configServiceUnsubscribe?: () => void;
  private runningServerUrl?: string;

  // Delegate classes
  private readonly settingsSync: WebviewSettingsSync;
  private readonly serializer: WorkflowSerializer;
  private readonly router: WebviewMessageRouter;
  // IDashboardSink message shapes are single-sourced here. Pure sink methods
  // delegate to it; methods with extra VS Code logic call it then do more work.
  private readonly sink = new PostMessageDashboardSink((msg) =>
    this.postMessage(msg)
  );

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
    const templateManager = new TemplateManager(context);

    // Bind postMessage to use the view reference
    const postMessage = (message: any) => this.postMessage(message);
    const getOrchestrator = () => this.workflowOrchestrator;
    const getOutputHistoryManager = () => this.outputHistoryManager;

    // Create delegate classes
    this.settingsSync = new WebviewSettingsSync(postMessage, getOrchestrator);
    this.serializer = new WorkflowSerializer(
      postMessage,
      templateManager,
      getOrchestrator,
      getOutputHistoryManager
    );
    this.router = new WebviewMessageRouter(
      postMessage,
      this.settingsSync,
      this.serializer,
      getOrchestrator,
      {
        handleClearWorkflow: () => this.handleClearWorkflow(),
        updateWorkflowName: (name: string) => this.updateWorkflowName(name),
        getServerUrl: () => this.runningServerUrl,
      }
    );

    // Listen for model registry updates
    this.modelsLoadedDisposable = onModelsLoaded(() => {
      if (this.view) {
        this.settingsSync.sendModelOptionsUpdate();
      }
    });

    // Listen for file-based config changes (configService) to keep all clients in sync.
    // When the hub is available (after orchestrator init), broadcast to panel + all browser
    // tabs. Before the hub is wired up (early startup), fall back to panel-only.
    this.configServiceUnsubscribe = configService.subscribe(() => {
      if (this.view) {
        this.settingsSync.sendGlobalSettingsUpdate(
          this.hub ? (msg) => this.hub!.postMessage(msg) : undefined
        );
      }
    });

    // Discover available agents and skills in background
    this.settingsSync.discoverAgents();
    this.settingsSync.discoverSkills();

    // Harness availability is driven by WorkflowOrchestrator via notifyHarnessAvailability()
    // (subscribes to onDidChangeStatus on all integrations — single source of truth).
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
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
      void this.routeMessage(message);
    });

    Log.debug("resolveWebviewView() complete — view is now set");

    // Best-effort early INIT: VS Code buffers postMessage until the
    // webview iframe loads, but React's message listener may not be
    // attached yet. The READY handler sends INIT again as a
    // guaranteed fallback once React confirms it is listening.
    this.settingsSync.sendInitialState();

    if (this._pendingActiveWorkflowId !== undefined) {
      this.notifyActiveWorkflowChanged(this._pendingActiveWorkflowId);
      this._pendingActiveWorkflowId = undefined;
    }
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

    // Generate a nonce for CSP script-src (replaces 'unsafe-inline')
    const nonce = this.getNonce();

    // Inject VS Code API capture script BEFORE any other scripts
    // acquireVsCodeApi() can only be called once, so we capture it and make it globally available
    // This must run before the React module script loads
    const vscodeApiScript = `<script nonce="${nonce}">
window.vscodeApi = acquireVsCodeApi();
</script>`;

    // Inject AFTER typo.js script tag but BEFORE the module scripts
    html = html.replace(
      /<script type="module"/,
      `${vscodeApiScript}\n    <script type="module" nonce="${nonce}"`
    );

    // Add nonce to any remaining script tags (e.g., typo.js)
    html = html.replace(
      /<script(?!\s+nonce=)([^>]*>)/g,
      `<script nonce="${nonce}"$1`
    );

    // Replace CSP meta tag with correct policy for VS Code webview
    // - script-src: Nonce-based (no 'unsafe-inline') for security
    // - style-src: Allow inline styles (Tailwind uses style tags)
    // - font-src: Allow webview fonts
    // - img-src: Allow webview images and data URIs
    // - connect-src: Allow source map loading in dev tools
    const cspContent = `default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:; connect-src ${webview.cspSource};`;

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

  // ============================================================================
  // Public API - WorkflowOrchestrator -> Webview Updates
  // ============================================================================

  /**
   * Update dashboard when a workflow file is selected
   */
  public async updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowId?: string
  ): Promise<void> {
    await this.sink.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId
    );
    await this.settingsSync.sendWorkflowPropertiesToSettings(
      undefined,
      PANEL_CLIENT_ID
    );
  }

  public async updateSessionRestored(
    fileName: string,
    steps: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalStep?: WorkflowStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    },
    workflowId?: string
  ): Promise<void> {
    await this.sink.updateSessionRestored(
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId
    );
    await this.settingsSync.sendWorkflowPropertiesToSettings(
      undefined,
      PANEL_CLIENT_ID
    );
  }

  public updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean
  ): void {
    this.sink.updateExecutionStarted(
      workflowId,
      fileName,
      totalSteps,
      isContinuation,
      preserveStepCount,
      isInjectMode
    );
  }
  public notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[],
    workflowId?: string
  ): void {
    this.sink.notifyRunHistoryUpdated(
      runCount,
      runTimestamps,
      runStates,
      workflowId
    );
  }
  public updateProgress(
    current: number,
    total: number,
    workflowId?: string
  ): void {
    this.sink.updateProgress(current, total, workflowId);
  }
  public updateExecutionState(state: string, workflowId?: string): void {
    this.sink.updateExecutionState(state, workflowId);
  }
  public updateStepStatus(
    stepIndex: number,
    status: {
      state: StepStatus;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>,
    workflowId?: string
  ): void {
    this.sink.updateStepStatus(stepIndex, status, details, workflowId);
  }
  public updateRetryAttempt(
    stepIndex: number,
    currentRetry: number,
    maxRetries: number,
    workflowId?: string
  ): void {
    this.sink.updateRetryAttempt(
      stepIndex,
      currentRetry,
      maxRetries,
      workflowId
    );
  }
  public updateCliOutput(
    stepIndex: number,
    output: CliOutput,
    workflowId?: string
  ): void {
    this.sink.updateCliOutput(stepIndex, output, workflowId);
  }
  public updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.sink.updateCliStreamingChunk(stepIndex, chunk, workflowId);
  }
  public updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void {
    this.sink.updateCliStreamingEvents(stepIndex, events, workflowId);
  }
  public updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string
  ): void {
    this.sink.updateStatusMessage(stepIndex, message, severity, workflowId);
  }
  public updateExecutionCompleted(workflowId?: string): void {
    this.sink.updateExecutionCompleted(workflowId);
  }

  /** Notify webview that a terminal PTY session started */
  public notifyTerminalStarted(
    workflowId: string,
    sessionId: string,
    stepName: string,
    kind: string
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.TERMINAL_STARTED,
      workflowId,
      sessionId,
      stepName,
      kind,
    });
  }

  /** Stream PTY output bytes to the webview terminal */
  public notifyTerminalOutput(
    workflowId: string,
    sessionId: string,
    data: string
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.TERMINAL_OUTPUT,
      workflowId,
      sessionId,
      data,
    });
  }

  /** Notify webview that a PTY session ended */
  public notifyTerminalEnded(
    workflowId: string,
    sessionId: string,
    kind: string,
    exitCode: number
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.TERMINAL_ENDED,
      workflowId,
      sessionId,
      kind,
      exitCode,
    });
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

  public updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    workflowId?: string
  ): void {
    this.sink.updateStepsExtended(steps, finalStep, executionState, workflowId);
  }
  public updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void {
    this.sink.updatePromptDeleted(fileName, steps, finalStep);
  }
  public updateFinalStep(
    finalStep: WorkflowStep | null,
    workflowId?: string
  ): void {
    this.sink.updateFinalStep(finalStep, workflowId);
  }
  public updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStatus(status, loopCount, phase, workflowId);
  }
  public updateFinalStepOutput(
    loopIndex: number,
    output: CliOutput,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepOutput(loopIndex, output, workflowId);
  }
  public updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStreamingChunk(loopIndex, chunk, workflowId);
  }
  public updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStreamingEvents(loopIndex, events, workflowId);
  }
  /** Only resets prompt statuses and execution state — does not touch CLI outputs or run history. */
  public notifyWorkflowStateReset(steps: any[], workflowId?: string): void {
    this.sink.notifyWorkflowStateReset(steps, workflowId);
  }
  public notifyStartPositionSet(
    steps: WorkflowStep[],
    currentIndex: number,
    workflowId?: string
  ): void {
    this.sink.notifyStartPositionSet(steps, currentIndex, workflowId);
  }
  public notifyPromptsReordered(
    steps: WorkflowStep[],
    workflowId?: string
  ): void {
    this.sink.notifyPromptsReordered(steps, workflowId);
  }
  public notifyUndoRedoSynced(): void {
    this.sink.notifyUndoRedoSynced();
  }

  /**
   * Called when a CLI-managed workflow dynamically extends its queue.
   * Includes the workflowId so the webview can ignore updates for inactive workflows.
   */
  public notifyCliPromptsExtended(workflowId: string, steps: any[]): void {
    this.postMessage({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      workflowId,
      steps,
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

  public updateWorkflowName(name: string, workflowId?: string): void {
    this.sink.updateWorkflowName(name, workflowId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-workflow coordination notifications (called by WorkflowOrchestrator)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a live CLI output update to the webview for a CLI-managed workflow.
   * Called by WorkflowOrchestrator when CliWatchSession.onOutput fires.
   */
  public notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
      workflowId,
      stepIndex,
      output,
    });
  }

  /** Notify webview that a new workflow was loaded into the registry. */
  public notifyWorkflowAdded(summary: WorkflowSummary): void {
    Log.debug(
      `[notifyWorkflowAdded] inst:${summary.id.slice(0, 8)} name="${summary.workflowName || "(empty)"}" state=${summary.executionState} ` +
        `step=${workflowDisplayStep(summary)}/${summary.totalSteps} fp=${summary.filePath ? path.basename(summary.filePath) : "?"} ` +
        `wfp=${summary.workingFilePath ? path.basename(summary.workingFilePath) : "?"}`
    );
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }

  /** Notify webview that a workflow was dismissed from the registry. */
  public notifyWorkflowDismissed(workflowId: string): void {
    Log.debug(`[notifyWorkflowDismissed] inst:${workflowId.slice(0, 8)}`);
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId });
  }

  /** Notify webview that the active (displayed) workflow changed. */
  public notifyActiveWorkflowChanged(workflowId: string): void {
    Log.debug(`[notifyActiveWorkflowChanged] inst:${workflowId.slice(0, 8)}`);
    if (!this.view) {
      this._pendingActiveWorkflowId = workflowId;
      return;
    }
    this._pendingActiveWorkflowId = undefined;
    this.postMessage({
      type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
      workflowId,
    });
  }

  /** Notify webview that a workflow's execution summary was updated (state/progress changed). */
  public notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    this.postMessage({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });
  }

  /** Send workspace snapshot data for a completed prompt step to the webview. */
  public sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void {
    this.sink.sendStepUndoDataUpdated(target, workspaceSnapshot);
  }

  /** Notify webview that an undo record was created or updated for a step. */
  public sendUndoRecordUpdated(
    target: OutputExecutionTarget,
    undoRecord: UndoRecord
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
      target,
      undoRecord,
    } as UndoRecordUpdatedMessage);
  }

  /**
   * Send all undo-related data for a history to the webview.
   * Iterates all StepOutputs and sends STEP_UNDO_DATA_UPDATED for snapshots
   * and UNDO_RECORD_UPDATED for undoRecords.
   */
  public sendHistoryUndoData(history: WorkflowOutputHistory): void {
    const sendForOutput = (
      target: OutputExecutionTarget,
      stepOutput: StepOutput
    ) => {
      if (stepOutput.workspaceSnapshot) {
        this.sendStepUndoDataUpdated(target, stepOutput.workspaceSnapshot);
      }
      if (stepOutput.undoRecord) {
        this.sendUndoRecordUpdated(target, stepOutput.undoRecord);
      }
    };

    for (const [idx, stepOutput] of Object.entries(history.promptOutputs)) {
      sendForOutput(
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: Number(idx) },
        stepOutput
      );
    }
    if (history.finalStepOutputs) {
      for (const [idx, stepOutput] of Object.entries(
        history.finalStepOutputs
      )) {
        sendForOutput(
          { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: Number(idx) },
          stepOutput
        );
      }
    }
  }

  /** Send the result of an undo operation back to the webview. */
  public sendUndoPromptResult(
    requestId: string,
    target: UndoExecutionTarget,
    result: UndoResult
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
      data: {
        requestId,
        target,
        restoredFiles: result.restoredFiles,
        failedFiles: result.failedFiles,
      },
    } as UndoPromptResultMessage);
  }

  // ============================================================================
  // Public API - External Wiring
  // ============================================================================

  /**
   * Set WorkflowOrchestrator reference (called after construction to avoid circular dependency)
   */
  public setWorkflowOrchestrator(manager: WorkflowOrchestrator): void {
    this.workflowOrchestrator = manager;
  }

  /**
   * Unregister a browser WebSocket client from the viewer registry.
   * Called by FlightPathHostedServer when a WebSocket connection closes so
   * retired instances are freed when no clients are viewing them.
   */
  public unregisterBrowserClient(clientId: string): void {
    this.workflowOrchestrator?.unregisterClient(clientId);
    // Release controller ownership for any sessions this client was controlling.
    // This lets another viewer claim control after the browser tab closes.
    const ptyManager = getPtyProcessManager();
    if (ptyManager) {
      const released = ptyManager.releaseControllerForClient(clientId);
      for (const session of released) {
        ptyPostMessage({
          type: MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED,
          workflowId: session.workflowId,
          sessionId: session.id,
          controllerClientId: undefined,
        });
      }
    }
  }

  public async routeMessage(message: any): Promise<void> {
    await this.router.route(message);
  }

  public async routeExternalMessage(
    message: any,
    postMessage: PostMessageFn,
    clientTag?: string
  ): Promise<void> {
    await this.router.route(message, { postMessage, clientTag });
  }

  /**
   * Set OutputHistoryManager reference (called after construction)
   */
  public setOutputHistoryManager(manager: OutputHistoryManager): void {
    this.outputHistoryManager = manager;
  }

  /**
   * Set DashboardBroadcastHub reference so config-change notifications
   * broadcast to all clients (panel + browser tabs), not just the panel.
   */
  public setHub(hub: DashboardBroadcastHub): void {
    this.hub = hub;
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
    workingFilePath: string,
    workflowInstanceId?: string
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
      Log.debug(
        `[FlightPathWebviewProvider] loadOutputHistoryForWorkflow: sending ${runs.length} runs, timestamps: ${JSON.stringify(runTimestamps)}`
      );

      this.postMessage({
        type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
        history,
        availableRuns: runs.length,
        currentRunIndex: 0,
        runTimestamps,
        runStates,
        ...(workflowInstanceId !== undefined
          ? { workflowId: workflowInstanceId }
          : {}),
      });
    } catch (error) {
      Log.warn("Failed to load output history for workflow:", error);
    }
  }

  /**
   * Update a single harness availability status and push the change to the UI.
   * Called by WorkflowOrchestrator after initialization completes so that the
   * authoritative retry-based check overrides the quick no-retry check that
   * runs during construction.
   */
  public notifyHarnessAvailability(
    harnessId: string,
    available: boolean
  ): void {
    this.settingsSync.notifyHarnessAvailability(harnessId, available);
  }

  /**
   * Expose the settings sync instance for in-process callers (e.g. LM Tools).
   */
  public getSettingsSync(): WebviewSettingsSync {
    return this.settingsSync;
  }

  /**
   * Track the running server URL so READY reconnects the webview when it reloads
   * while the server is up. Pass undefined when the server stops.
   */
  public setRunningServerUrl(url: string | undefined): void {
    this.runningServerUrl = url;
  }

  /**
   * Wire up a callback for when the webview captures CSS theme vars.
   * Used by FlightPathHostedServer to forward theme vars to browser clients.
   */
  public setThemeVarsCapturedCallback(
    cb: ((vars: Record<string, string>) => void) | undefined
  ): void {
    this.router.setThemeVarsCapturedCallback(cb);
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
   * Clear the current workflow. Public because it's called by extension commands.
   */
  public async handleClearWorkflow(): Promise<void> {
    if (!this.workflowOrchestrator) {
      Log.error("WorkflowOrchestrator not initialized");
      return;
    }

    this.settingsSync.sendWorkflowUnloadedToSettings();
    await this.workflowOrchestrator.clearWorkflow();
    this.updateFileSelected(DEFAULT_WORKFLOW_NAME, [], undefined);
    Log.info("Workflow cleared, ready for new prompts");
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.modelsLoadedDisposable?.dispose();
    this.configServiceUnsubscribe?.();
  }

  // ============================================================================
  // Private Methods - Utilities
  // ============================================================================

  /** Generate a random nonce string for CSP script-src */
  private getNonce(): string {
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
      nonce += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return nonce;
  }

  public postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  /** Returns a scoped send function targeting this panel's webview. */
  getPanelScopedSend(): (msg: unknown) => void {
    return (msg) => this.postMessage(msg);
  }

  /** Public postMessage for use by PtyProcessManager (terminal output routing) */
  public postMessagePublic(message: unknown): void {
    this.view?.webview.postMessage(message);
  }
}
