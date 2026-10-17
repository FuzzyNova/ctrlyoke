import * as vscode from "vscode";
import * as path from "path";
import * as fsSync from "fs";
import {
  DEFAULT_WORKFLOW_NAME,
  MESSAGE_TYPES,
  LOG_LEVELS,
  type StatusMessageSeverity,
  type StepStatus,
  type FinalStepPhase,
  type ExecutionPhase,
  type HarnessId,
  type ExecutionMode,
  PANEL_CLIENT_ID,
} from "../types/DashboardConstants";
import {
  getPtyProcessManager,
  ptyPostMessage,
} from "../core/harness/PtyProcessManager";
import type {
  CliEvent,
  CliOutput,
  DevDashboardAction,
  DevStatus,
  PromptEditorInsertRequest,
  BindAddressFallbackInfo,
  ServerPortFallbackInfo,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import type {
  ParallelGroupDefinition,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import { Log } from "../utils/Log";
import { secretRedactionService } from "../utils/SecretRedactionService";
import { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { WorkflowSummary } from "../types/CtrlYokeTypes";
import { PostMessageDashboardSink } from "./PostMessageDashboardSink";
import { workflowDisplayStep } from "../types/CtrlYokeTypes";
import type { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { WebviewSettingsSync } from "./WebviewSettingsSync";
import type { WorkflowSerializer } from "./WorkflowSerializer";
import type { WebviewMessageRouter } from "./WebviewMessageRouter";
import type {
  ContextReferenceValidationOptions,
  ContextReferenceValidationResult,
  IdentifiedContextReference,
} from "../utils/PromptDiagnosticRules";
import type { HarnessUsageSnapshot } from "../types/UsageTypes";
import type {
  WorkflowViewAddress,
  WorktreeRunProjection,
  CoordinationScopeSnapshot,
} from "../types/CtrlYokeTypes";
import type { PostMessageFn } from "./WebviewSettingsSync";
import type { DashboardBroadcastHub } from "./DashboardBroadcastHub";
import { IS_DEV_MODE } from "../utils/BuildConfig";
import { retryWithBackoff } from "../utils/RetryUtils";
import type { SecretRegistryService } from "./SecretRegistryService";
import type { WebviewUserInteractionPort } from "./WebviewUserInteractionPort";
import type { UserInteractionPort } from "./UserInteractionPort";
import type { ContextMenuPromptEditorInsertSink } from "../completions/ContextMenuReferenceCommands";
import type { HarnessAvailabilityReport } from "../types/WebviewMessageTypes";
import type { DashboardApplication } from "./DashboardApplication";

// Re-export CliOutput for external use
export type { CliOutput } from "../types/WebviewMessageTypes";

// Re-export HarnessStatus for external consumers
export type { HarnessStatus } from "./WebviewSettingsSync";

/** Panel HTML rebuilds allowed before a READY proves the bundle can mount. */
const MAX_PANEL_HTML_REBUILDS = 2;

/**
 * VS Code panel transport for the shared dashboard application.
 * Owns HTML generation, panel READY/reconnect, and queued editor inserts.
 */
export class CtrlYokeWebviewProvider
  implements vscode.WebviewViewProvider, ContextMenuPromptEditorInsertSink
{
  private view?: vscode.WebviewView;
  private _pendingActiveWorkflowId: string | undefined;
  private workflowOrchestrator?: WorkflowOrchestrator;
  // Incremented each time a new RECONNECT retry loop starts (resolveWebviewView)
  // or is cancelled (panel sends READY / dispose). Each retryWithBackoff closure
  // captures the session value at launch; a stale closure exits immediately when
  // the captured value no longer matches the field.
  private reconnectRetrySession = 0;
  private hub?: DashboardBroadcastHub;
  private runningServerUrl?: string;
  private runningServerAvailableIps: string[] = [];
  private runningServerPortFallback?: ServerPortFallbackInfo;
  private runningServerBindAddressFallback?: BindAddressFallbackInfo;
  private panelReady = false;
  private panelReadyWaiters: Array<() => void> = [];
  // The pageLoadId of the panel page whose READY was last accepted. Compared
  // (not just latched as a boolean) so that a READY from a *different* page
  // load or handshake — a rebuilt panel, or a watchdog's handshake retry — is
  // never mistaken for an in-page duplicate of BootstrapApp's/App.tsx's two
  // READY sends. VS Code retains the same WebviewView instance across both, so
  // panelReady alone would otherwise stay stuck true and silently drop
  // CLIENT_ID_ASSIGNED for every new handshake after the first.
  private readyPageLoadId: string | undefined;
  // Rebuilds granted since the panel last completed a READY handshake. Capped
  // so a bundle that can never mount does not rebuild the panel forever.
  private panelHtmlRebuildsWithoutReady = 0;
  private readonly pendingPromptEditorInsertQueue: PromptEditorInsertRequest[] =
    [];
  private readonly dashboardApplication: DashboardApplication;

  // Delegate classes
  private readonly settingsSync: WebviewSettingsSync;
  private readonly serializer: WorkflowSerializer;
  private readonly router: WebviewMessageRouter;
  private readonly secretRegistry: SecretRegistryService;
  private readonly interactionPort: WebviewUserInteractionPort;
  // IDashboardSink message shapes are single-sourced here. Pure sink methods
  // delegate to it; methods with extra VS Code logic call it then do more work.
  private readonly sink = new PostMessageDashboardSink((msg) =>
    this.postMessage(msg)
  );

  public updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void {
    this.sink.updateHarnessUsage(snapshots);
  }

  public updateWorktreeMerge(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    worktree: WorktreeRunProjection
  ): void {
    this.sink.updateWorktreeMerge(address, worktree);
  }

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    application: DashboardApplication
  ) {
    this.dashboardApplication = application;
    this.settingsSync = application.settingsSync;
    this.serializer = application.serializer;
    this.router = application.router;
    this.secretRegistry = application.secretRegistry;
    this.interactionPort = application.interactionPort;
  }

  /**
   * Every open workspace folder root, added to `localResourceRoots` so inline
   * image thumbnails can load — not just pasted images under `.ctrlyoke/` but
   * any image the harness references anywhere in the workspace. Returns every
   * folder of a multi-root `.code-workspace` (the `.ctrlyoke/temp` and
   * `.ctrlyoke/attachments` dirs live inside a folder, so they stay covered).
   * Empty when no workspace folder is open.
   *
   * Widening from the two `.ctrlyoke` dirs to the whole workspace is safe
   * because the webview only ever loads URIs the extension host hands back from
   * `handleFilePreviewUriRequest`, which validates every path resolves inside a
   * trusted workspace root and is an allowed image type before returning it.
   */
  private getImageResourceRoots(): vscode.Uri[] {
    return (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    this.panelReady = false;
    this.readyPageLoadId = undefined;
    this.panelHtmlRebuildsWithoutReady = 0;

    webviewView.webview.options = {
      enableScripts: true,
      // Deliberately narrow (see dev/implemented/UI_SECURITY_REVIEW.md). The two
      // .ctrlyoke image dirs are added — and ONLY those, not the workspace root —
      // so inline thumbnails can render pasted images without widening exposure.
      localResourceRoots: [
        this.webviewReactUri,
        vscode.Uri.joinPath(this.context.extensionUri, "images"),
        ...this.getImageResourceRoots(),
      ],
    };

    const html = this._getHtmlForWebview(webviewView.webview);
    webviewView.webview.html = html;

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.type === MESSAGE_TYPES.PANEL_RELOAD_REQUEST) {
        this.rebuildPanelHtml(webviewView);
        return;
      }
      if (message?.type === MESSAGE_TYPES.READY) {
        this.cancelReconnectRetry();
      }
      void this.routeMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.panelReady = false;
        this.readyPageLoadId = undefined;
        this.view = undefined;
      }
      this.dashboardApplication.disposePanelClient();
      this.resolvePanelReadyWaiters();
      this.cancelReconnectRetry();
    });

    this.startPanelReconnectRecovery(webviewView);

    // Best-effort early INIT: VS Code buffers postMessage until the
    // webview iframe loads, but React's message listener may not be
    // attached yet. The READY handler sends INIT again as a
    // guaranteed fallback once React confirms it is listening.
    void this.settingsSync.sendInitialState().catch((error) => {
      Log.warn("[CtrlYokeWebviewProvider] Failed to send early INIT:", error);
    });

    if (this._pendingActiveWorkflowId !== undefined) {
      this.notifyActiveWorkflowChanged(this._pendingActiveWorkflowId);
      this._pendingActiveWorkflowId = undefined;
    }
  }

  private startPanelReconnectRecovery(webviewView: vscode.WebviewView): void {
    // If VS Code retained the old React context instead of reloading the
    // iframe (common on extension host restart), React will never re-send
    // READY on its own. This RECONNECT nudges the retained React to re-send
    // READY so the new extension host can complete initialization.
    //
    // The first RECONNECT can be silently dropped when the webview message
    // channel is still being re-established after the restart (the inbound
    // path — webview → extension — becomes ready slightly after resolveWebviewView
    // is called). retryWithBackoff gives the channel time to fully come up.
    // Each retry closure captures `session`; incrementing reconnectRetrySession
    // in cancelReconnectRetry() causes all in-flight closures to self-terminate.
    //
    // If the panel still doesn't complete the handshake, the React-side
    // reconnect watchdog (reconnectWatchdog.ts) re-sends READY under a fresh
    // page-load id once CLIENT_ID_ASSIGNED is overdue. This avoids the "raw html
    // text" regression caused by setting webview.html a second time from the
    // extension side while the first load is still in progress.
    const session = ++this.reconnectRetrySession;

    void retryWithBackoff(
      async () => {
        if (
          this.reconnectRetrySession !== session ||
          this.view !== webviewView
        ) {
          return true; // cancelled
        }
        this.postMessage({ type: MESSAGE_TYPES.RECONNECT });
        return null; // keep retrying
      },
      {
        maxAttempts: 6,
        delays: [250, 500, 1000, 2000, 4000], // delays between retries (attempt 0 is always immediate)
      }
    );
  }

  /**
   * Load built React app HTML and inject webview URIs
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.webviewReactUri, "index.html");

    let html = fsSync.readFileSync(htmlPath.fsPath, "utf-8");
    const moduleScriptPattern = /<script\b[^>]*\btype=(["'])module\1[^>]*>/i;
    const moduleScriptWithSrcPattern =
      /<script\b(?=[^>]*\btype=(["'])module\1)(?=[^>]*\bsrc=(["'])([^"']+)\2)[^>]*>\s*<\/script>/i;
    const modulePreloadPattern =
      /<link\b[^>]*\brel=["']modulepreload["'][^>]*>\s*/gi;
    html = html.replace(modulePreloadPattern, "");

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
        "ctrlyoke-icon.svg"
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

    // Load compiled inline scripts from out/ui/webview-scripts/
    const webviewScriptsUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "out",
      "ui",
      "webview-scripts"
    );
    const bootstrapBody = fsSync.readFileSync(
      vscode.Uri.joinPath(webviewScriptsUri, "bootstrapScript.js").fsPath,
      "utf-8"
    );
    const bootstrapScript = `<script nonce="${nonce}">\nconst __cyLogMessageType__ = ${JSON.stringify(MESSAGE_TYPES.LOG_MESSAGE)};\nconst __cyLogLevels__ = ${JSON.stringify(LOG_LEVELS)};\n${bootstrapBody}</script>`;

    const moduleScriptWithSrcMatch = html.match(moduleScriptWithSrcPattern);
    const moduleScriptSrc = moduleScriptWithSrcMatch?.[3];
    let moduleLoaderScript: string | undefined;
    if (moduleScriptSrc !== undefined) {
      const loaderBody = fsSync.readFileSync(
        vscode.Uri.joinPath(webviewScriptsUri, "moduleLoaderScript.js").fsPath,
        "utf-8"
      );
      moduleLoaderScript = `<script type="module" nonce="${nonce}">\nconst __cyModuleSrc__ = ${JSON.stringify(moduleScriptSrc)};\nconst __cyPanelReloadRequestType__ = ${JSON.stringify(MESSAGE_TYPES.PANEL_RELOAD_REQUEST)};\nconst __cyLogMessageType__ = ${JSON.stringify(MESSAGE_TYPES.LOG_MESSAGE)};\nconst __cyLogLevels__ = ${JSON.stringify(LOG_LEVELS)};\n${loaderBody}</script>`;
    }

    // Inject the bootstrap BEFORE the module scripts.
    // acquireVsCodeApi() must run before the React bundle so window.vscodeApi is available
    // when React initialises.
    const hadModuleScript = moduleScriptPattern.test(html);
    if (hadModuleScript) {
      if (moduleLoaderScript && moduleScriptWithSrcMatch) {
        html = html.replace(
          moduleScriptWithSrcPattern,
          `${bootstrapScript}\n    ${moduleLoaderScript}`
        );
      } else {
        html = html.replace(moduleScriptPattern, `${bootstrapScript}\n    $&`);
      }
    } else {
      // No module script found — fall back to inserting before </head> so the
      // panel at least gets vscodeApi even if the bundle
      // tag name changed in a future Vite version.
      Log.warn(
        "[_getHtmlForWebview] No module script tag found in index.html — injecting bootstrap before </head>"
      );
      html = html.replace("</head>", `${bootstrapScript}\n  </head>`);
    }

    // Add nonce to any remaining script tags that don't already have one (e.g., typo.js)
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

    // Replace existing CSP meta tag — \s+ in the regex matches newlines so
    // multi-line meta tags (as Vite formats them) are handled correctly.
    const htmlBeforeCsp = html;
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
      `<meta http-equiv="Content-Security-Policy" content="${cspContent}" />`
    );
    if (html === htmlBeforeCsp) {
      // No existing CSP tag found — insert before </head> as fallback
      Log.warn(
        "[_getHtmlForWebview] CSP meta tag not found in index.html — inserting before </head>"
      );
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
    workflowId?: string,
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    schemaWarnings?: import("../types/CtrlYokeTypes").WorkflowValidationWarning[]
  ): Promise<void> {
    await this.sink.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId,
      workflowProperties,
      parallelGroups,
      activeStepIndices,
      schemaWarnings
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
    workflowId?: string,
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    definitionRevision?: number,
    schemaWarnings?: import("../types/CtrlYokeTypes").WorkflowValidationWarning[],
    stopReason?: import("../types/CtrlYokeTypes").WorkflowStopReason
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
      workflowId,
      workflowProperties,
      parallelGroups,
      activeStepIndices,
      definitionRevision,
      schemaWarnings,
      stopReason
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
    reusesRunningTerminal?: boolean,
    executionMode?: ExecutionMode
  ): void {
    this.sink.updateExecutionStarted(
      workflowId,
      fileName,
      totalSteps,
      isContinuation,
      preserveStepCount,
      reusesRunningTerminal,
      executionMode
    );
  }
  public updateProgress(
    current: number,
    total: number,
    workflowId?: string
  ): void {
    this.sink.updateProgress(current, total, workflowId);
  }
  public updateExecutionState(
    state: string,
    workflowId?: string,
    activeStepIndices?: number[],
    stopReason?: import("../types/CtrlYokeTypes").WorkflowStopReason
  ): void {
    this.sink.updateExecutionState(
      state,
      workflowId,
      activeStepIndices,
      stopReason
    );
  }
  public updateActiveStepIndices(
    activeStepIndices: number[],
    workflowId?: string
  ): void {
    this.sink.updateActiveStepIndices?.(activeStepIndices, workflowId);
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
    workflowId?: string,
    prompt?: string
  ): void {
    this.sink.updateCliOutput(stepIndex, output, workflowId, prompt);
  }
  public updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.sink.updateCliStreamingChunk(
      stepIndex,
      chunk,
      phase,
      workflowId,
      timestampMs,
      sequence,
      attemptIndex,
      runIndex
    );
  }
  public updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.sink.updateCliStreamingEvents(
      stepIndex,
      events,
      attemptIndex,
      runIndex,
      workflowId,
      phase,
      timestampMs,
      sequence
    );
  }
  public updateContextWindow(
    stepIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void {
    this.sink.updateContextWindow(stepIndex, used, size, workflowId);
  }
  public updateFinalStepContextWindow(
    loopIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepContextWindow(loopIndex, used, size, workflowId);
  }
  public updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string,
    timestampMs?: number
  ): void {
    this.sink.updateStatusMessage(
      stepIndex,
      message,
      severity,
      workflowId,
      timestampMs
    );
  }
  public updateExecutionCompleted(workflowId?: string): void {
    this.sink.updateExecutionCompleted(workflowId);
  }

  public updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    definitionRevision?: number,
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[],
    runtimePromotionUndoSuppressed?: boolean
  ): void {
    this.sink.updateStepsExtended(
      steps,
      finalStep,
      executionState,
      definitionRevision,
      workflowId,
      parallelGroups,
      runtimePromotionUndoSuppressed
    );
  }

  public updateStepColor(
    indices: number[],
    color: string | null,
    definitionRevision?: number,
    workflowId?: string
  ): void {
    this.sink.updateStepColor(indices, color, definitionRevision, workflowId);
  }
  public updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null,
    parallelGroups?: ParallelGroupDefinition[],
    definitionRevision?: number,
    workflowId?: string
  ): void {
    this.sink.updatePromptDeleted(
      fileName,
      steps,
      finalStep,
      parallelGroups,
      definitionRevision,
      workflowId
    );
  }
  public updateFinalStep(
    finalStep: WorkflowStep | null,
    workflowId?: string,
    definitionRevision?: number
  ): void {
    this.sink.updateFinalStep(finalStep, workflowId, definitionRevision);
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
    workflowId?: string,
    prompt?: string
  ): void {
    this.sink.updateFinalStepOutput(loopIndex, output, workflowId, prompt);
  }
  public updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    phase?: ExecutionPhase,
    workflowId?: string,
    timestampMs?: number,
    sequence?: number,
    attemptIndex?: number,
    runIndex?: number
  ): void {
    this.sink.updateFinalStepStreamingChunk(
      loopIndex,
      chunk,
      phase,
      workflowId,
      timestampMs,
      sequence,
      attemptIndex,
      runIndex
    );
  }
  public updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string,
    phase?: ExecutionPhase,
    timestampMs?: number,
    sequence?: number
  ): void {
    this.sink.updateFinalStepStreamingEvents(
      loopIndex,
      events,
      attemptIndex,
      runIndex,
      workflowId,
      phase,
      timestampMs,
      sequence
    );
  }
  public notifyPromptsReordered(
    steps: WorkflowStep[],
    workflowId?: string,
    parallelGroups?: ParallelGroupDefinition[],
    definitionRevision?: number
  ): void {
    this.sink.notifyPromptsReordered(
      steps,
      workflowId,
      parallelGroups,
      definitionRevision
    );
  }
  public notifyUndoRedoSynced(): void {
    this.sink.notifyUndoRedoSynced();
  }

  /**
   * Called when a CLI-managed workflow dynamically extends its queue.
   * Includes the workflowId so the webview can ignore updates for inactive workflows.
   */
  public notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      workflowId,
      steps,
      ...(definitionRevision !== undefined ? { definitionRevision } : {}),
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
    });
  }

  /** @keep The webview warning receiver is a future protocol endpoint; no sender route exists for the checker to trace. */
  public notifyStepLimitReached(currentSteps: number, maxSteps: number): void {
    this.postMessage({
      type: MESSAGE_TYPES.STEP_LIMIT_REACHED,
      currentSteps,
      maxSteps,
    });
  }

  /** @keep The webview warning receiver is a future protocol endpoint; no sender route exists for the checker to trace. */
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

  public updateWorkflowName(
    name: string,
    workflowId?: string,
    definitionRevision?: number
  ): void {
    this.sink.updateWorkflowName(name, workflowId, definitionRevision);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-workflow coordination notifications (called by WorkflowOrchestrator)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a live CLI output update to the webview for a CLI-managed workflow.
   * Called by WorkflowOrchestrator when ExternalRunWatchSession.onOutput fires.
   */
  public notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput,
    prompt?: string
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
      workflowId,
      stepIndex,
      output,
      ...(prompt ? { prompt } : {}),
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

  public notifyCoordinationScopeUpdated(
    scope: CoordinationScopeSnapshot
  ): void {
    this.postMessage({
      type: MESSAGE_TYPES.COORDINATION_SCOPE_UPDATED,
      scope,
    });
  }

  /** Send workspace snapshot data for a completed prompt step to the webview. */
  public sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot,
    workflowId?: string
  ): void {
    this.sink.sendStepUndoDataUpdated(target, workspaceSnapshot, workflowId);
  }

  // ============================================================================
  // Public API - External Wiring
  // ============================================================================

  /**
   * Set WorkflowOrchestrator reference (called after construction to avoid circular dependency)
   */
  public setWorkflowOrchestrator(manager: WorkflowOrchestrator): void {
    this.workflowOrchestrator = manager;
    this.dashboardApplication.setWorkflowOrchestrator(manager);
  }

  /**
   * Unregister a browser WebSocket client from the viewer registry.
   * Called by CtrlYokeHostedServer when a WebSocket connection closes so
   * retired instances are freed when no clients are viewing them.
   *
   * When a browser client was the controller, release the slot to undefined and
   * broadcast TERMINAL_CONTROLLER_CHANGED(undefined) to all connected clients.
   * Any client currently viewing that workflow will auto-claim the empty slot.
   * Clients that connect later will also auto-claim via TERMINAL_STARTED(undefined).
   * Once a new controller is established, everyone else must use "Take Control."
   */
  public unregisterBrowserClient(clientId: string): void {
    this.router.disposeClient(clientId);
    this.workflowOrchestrator?.unregisterClient(clientId);
    const ptyManager = getPtyProcessManager();
    if (!ptyManager) return;
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

  public async routeMessage(message: any): Promise<void> {
    if (this.dashboardApplication) {
      await this.dashboardApplication.routeClientMessage(message, (reply) =>
        this.postMessage(reply)
      );
      return;
    }
    await this.router.route(message);
  }

  public isPanelReady(): boolean {
    return this.panelReady && !!this.view;
  }

  public resolveImageWebviewUri(absolutePath: string): string | undefined {
    return this.view
      ? this.view.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString()
      : undefined;
  }

  public getRunningServerUrl(): string | undefined {
    return this.runningServerUrl;
  }

  public getRunningServerAvailableIps(): string[] {
    return this.runningServerAvailableIps;
  }

  public getRunningServerPortFallback(): ServerPortFallbackInfo | undefined {
    return this.runningServerPortFallback;
  }

  public getRunningServerBindAddressFallback():
    BindAddressFallbackInfo | undefined {
    return this.runningServerBindAddressFallback;
  }

  public async routeExternalMessage(
    message: any,
    postMessage: PostMessageFn,
    clientTag?: string
  ): Promise<void> {
    if (this.dashboardApplication) {
      await this.dashboardApplication.routeClientMessage(
        message,
        postMessage,
        clientTag
      );
      return;
    }
    await this.router.route(message, { postMessage, clientTag });
  }

  /**
   * Set OutputHistoryManager reference (called after construction)
   */
  public setOutputHistoryManager(manager: OutputHistoryManager): void {
    this.dashboardApplication.setOutputHistoryManager(manager);
  }

  /**
   * Set DashboardBroadcastHub reference so config-change notifications
   * broadcast to all clients (panel + browser tabs), not just the panel.
   */
  public setHub(hub: DashboardBroadcastHub): void {
    this.hub = hub;
    this.dashboardApplication.setHub(hub);
  }

  /**
   * Update a single harness availability status and push the change to the UI.
   * Called by WorkflowOrchestrator after initialization completes so that the
   * authoritative retry-based check overrides the quick no-retry check that
   * runs during construction.
   */
  public notifyHarnessAvailability(
    harnessId: HarnessId,
    report: HarnessAvailabilityReport
  ): void {
    this.settingsSync.notifyHarnessAvailability(harnessId, report);
  }

  /**
   * Track the running server URL so READY reconnects the webview when it reloads
   * while the server is up. Pass undefined when the server stops.
   */
  public setRunningServerUrl(
    url: string | undefined,
    availableIps?: string[],
    portFallback?: ServerPortFallbackInfo,
    bindAddressFallback?: BindAddressFallbackInfo
  ): void {
    this.runningServerUrl = url;
    this.runningServerAvailableIps = availableIps ?? [];
    this.runningServerPortFallback = portFallback;
    this.runningServerBindAddressFallback = bindAddressFallback;
  }

  /**
   * Wire up a callback for when the webview captures CSS theme vars.
   * Used by CtrlYokeHostedServer to forward theme vars to browser clients.
   */
  public setThemeVarsCapturedCallback(
    cb: ((vars: Record<string, string>) => void) | undefined
  ): void {
    this.router.setThemeVarsCapturedCallback(cb);
    this.dashboardApplication?.router.setThemeVarsCapturedCallback(cb);
  }

  /**
   * Open new workflow modal in the webview, pre-loaded with the template list
   * and default template (same data the "From Template" dropdown button sends
   * via NEW_WORKFLOW — see WorkflowSerializer.handleNewWorkflow).
   */
  public async openNewWorkflowModal(options?: {
    openCreateTemplateForm?: boolean;
  }): Promise<void> {
    await this.serializer.handleNewWorkflow((message) => {
      this.postMessage(
        options?.openCreateTemplateForm
          ? { ...message, openCreateTemplateForm: true }
          : message
      );
    });
  }

  public async enqueuePromptEditorInsert(
    request: PromptEditorInsertRequest
  ): Promise<void> {
    if (request.references.length === 0) {
      return;
    }

    await vscode.commands.executeCommand("ctrlyoke.dashboard.focus");

    if (!this.view || !this.panelReady) {
      this.pendingPromptEditorInsertQueue.push(request);
      return;
    }

    this.postMessage({
      type: MESSAGE_TYPES.INSERT_PROMPT_REFERENCES,
      data: request,
    });
  }

  /**
   * Clear the current workflow. Public because it's called by extension commands.
   */
  public async handleClearWorkflow(): Promise<void> {
    if (!this.workflowOrchestrator) {
      Log.error(
        "[CtrlYokeWebviewProvider] WorkflowOrchestrator not initialized"
      );
      return;
    }

    this.settingsSync.sendWorkflowUnloadedToSettings();
    await this.workflowOrchestrator.clearWorkflow();
    this.updateFileSelected(DEFAULT_WORKFLOW_NAME, [], undefined);
    Log.info(
      "[CtrlYokeWebviewProvider] Workflow cleared, ready for new prompts"
    );
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.cancelReconnectRetry();
    this.dashboardApplication.dispose();
    this.resolvePanelReadyWaiters();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RECONNECT retry helpers
  // ────────────────────────────────────────────────────────────────────────────

  /** Cancels any in-flight RECONNECT retry loop by invalidating its session id. */
  private cancelReconnectRetry(): void {
    this.reconnectRetrySession++;
  }

  /**
   * Answers the panel's module-mount watchdog (PANEL_RELOAD_REQUEST): the
   * dashboard bundle never mounted, and the page cannot reload itself because
   * a VS Code webview's content frame is an empty `fake.html` our HTML is
   * written into. Reassigning `webview.html` makes VS Code rebuild that frame.
   * This is safe here, unlike during RECONNECT (see ui.instructions.md),
   * because the request comes from a page that finished loading 30 s ago.
   */
  private rebuildPanelHtml(webviewView: vscode.WebviewView): void {
    if (this.view !== webviewView) {
      return;
    }
    if (this.panelHtmlRebuildsWithoutReady >= MAX_PANEL_HTML_REBUILDS) {
      Log.warn(
        `[CtrlYokeWebviewProvider] Ignoring panel rebuild request — ${MAX_PANEL_HTML_REBUILDS} rebuilds have not produced a READY`
      );
      return;
    }
    this.panelHtmlRebuildsWithoutReady++;
    Log.warn(
      `[CtrlYokeWebviewProvider] Rebuilding panel HTML after the dashboard failed to mount (attempt ${this.panelHtmlRebuildsWithoutReady}/${MAX_PANEL_HTML_REBUILDS})`
    );
    this.panelReady = false;
    this.readyPageLoadId = undefined;
    this.cancelReconnectRetry();
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
  }

  public handlePanelReady(pageLoadId: string | undefined): boolean {
    this.cancelReconnectRetry();
    // A READY carrying the same pageLoadId as the one already accepted is the
    // in-page duplicate (BootstrapApp's early READY vs. App.tsx's later one) —
    // ignore it. A different id (or no id at all) means a new page load, even
    // if this WebviewView was retained across a client-side reload, so it must
    // always be handled or the reloaded panel never gets CLIENT_ID_ASSIGNED.
    if (
      this.panelReady &&
      pageLoadId !== undefined &&
      pageLoadId === this.readyPageLoadId
    ) {
      return false;
    }
    this.panelReady = true;
    this.readyPageLoadId = pageLoadId;
    this.panelHtmlRebuildsWithoutReady = 0;
    this.resolvePanelReadyWaiters();
    this.flushPendingPromptEditorInserts();
    return true;
  }

  private resolvePanelReadyWaiters(): void {
    const waiters = this.panelReadyWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private flushPendingPromptEditorInserts(): void {
    if (!this.panelReady || !this.view) {
      return;
    }

    while (this.pendingPromptEditorInsertQueue.length > 0) {
      const request = this.pendingPromptEditorInsertQueue.shift();
      if (!request) {
        continue;
      }

      this.postMessage({
        type: MESSAGE_TYPES.INSERT_PROMPT_REFERENCES,
        data: request,
      });
    }
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

  public async getDevStatus(): Promise<DevStatus | undefined> {
    if (!IS_DEV_MODE) {
      return undefined;
    }

    const commands = await vscode.commands.getCommands(false);
    const extensionOutPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "out",
      "extension.js"
    ).fsPath;
    let buildDate = new Date().toISOString();
    try {
      buildDate = fsSync.statSync(extensionOutPath).mtime.toISOString();
    } catch {
      // Use the current timestamp if the compiled bundle has not been created.
    }

    return {
      enabled: true,
      buildDate,
      commands: {
        reloadWindow: commands.includes("workbench.action.reloadWindow"),
        restartExtensionHost: commands.includes(
          "workbench.action.restartExtensionHost"
        ),
      },
    };
  }

  public async sendDevStatus(postMessage: PostMessageFn): Promise<void> {
    const dev = await this.getDevStatus();
    if (!dev) {
      postMessage({
        type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
        command: MESSAGE_TYPES.DEV_REQUEST_STATUS,
        reason: "Developer actions are unavailable in this build.",
      });
      return;
    }

    postMessage({ type: MESSAGE_TYPES.DEV_STATUS, dev });
  }

  public async handleDevAction(
    action: DevDashboardAction,
    postMessage: PostMessageFn
  ): Promise<void> {
    if (!IS_DEV_MODE) {
      postMessage({
        type: MESSAGE_TYPES.DEV_COMMAND_UNAVAILABLE,
        command: action,
        reason: "Developer actions are unavailable in this build.",
      });
      return;
    }

    const { handleDevDashboardAction } = await import("../dev/DevCommands.js");
    const broadcastAwarePostMessage: PostMessageFn = (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === MESSAGE_TYPES.DEV_RESTARTING
      ) {
        if (this.hub) {
          this.hub.postMessage(message);
        } else {
          this.postMessage(message);
        }
        return;
      }

      postMessage(message);
    };

    await handleDevDashboardAction(action, {
      context: this.context,
      postMessage: broadcastAwarePostMessage,
      sendTestNotification: async () => {
        await vscode.commands.executeCommand(
          "ctrlyoke.dev.sendTestNotification"
        );
      },
    });
  }

  /**
   * Persist a captured UX snapshot to disk (dev builds only) and reply with the
   * saved path. Gated on IS_DEV_MODE so the write path (and DevCommands import)
   * is dead-code-eliminated from production builds, mirroring handleDevAction.
   */
  public async handleUxSnapshot(
    payload: { markdown: string; png?: string },
    workspaceRoot: string,
    postMessage: PostMessageFn
  ): Promise<void> {
    if (!IS_DEV_MODE) {
      postMessage({
        type: MESSAGE_TYPES.UX_SNAPSHOT_SAVED,
        error: "UX snapshot capture is unavailable in this build.",
      });
      return;
    }

    const { writeUxSnapshot } = await import("../dev/DevCommands.js");
    const result = await writeUxSnapshot(
      payload.markdown,
      payload.png,
      workspaceRoot
    );
    postMessage({
      type: MESSAGE_TYPES.UX_SNAPSHOT_SAVED,
      ...result,
    });
  }

  public postMessage(message: unknown): void {
    this.view?.webview.postMessage(secretRedactionService.redactValue(message));
  }

  public getSecretRegistryService(): SecretRegistryService {
    return this.dashboardApplication?.secretRegistry ?? this.secretRegistry;
  }

  /** Reference resolver for `PromptDiagnosticsProvider`; same policy as the dashboard editor. */
  public validateContextReferences(
    references: IdentifiedContextReference[],
    sourceDefinitionPath: string | undefined,
    options: ContextReferenceValidationOptions
  ): Promise<ContextReferenceValidationResult[]> {
    return this.router.validateContextReferences(
      references,
      sourceDefinitionPath,
      options
    );
  }

  public getUserInteractionPort(): UserInteractionPort {
    return this.dashboardApplication?.interactionPort ?? this.interactionPort;
  }

  public async awaitPanelReady(): Promise<void> {
    if (this.panelReady && this.view) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.panelReadyWaiters.push(resolve);
    });
  }

  public openGlobalSettingsTab(tab: "secrets" | "license"): void {
    this.postMessage({
      type: MESSAGE_TYPES.OPEN_GLOBAL_SETTINGS_TAB,
      tab,
    });
  }

  /** Public postMessage for use by PtyProcessManager (terminal output routing) */
  public postMessagePublic(message: unknown): void {
    this.postMessage(message);
  }
}
