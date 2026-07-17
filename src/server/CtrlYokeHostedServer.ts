import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createHttpServer, Server } from "http";
import { createServer as createHttpsServer } from "https";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { WorkflowSummary, WorkflowStep } from "../types/CtrlYokeTypes";
import type {
  CliEvent,
  CliOutput,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import type { CtrlYokeWebviewProvider } from "../ui/CtrlYokeWebviewProvider";
import {
  BROWSER_NOTIFICATION_MODES,
  HOSTED_ICON_FILES,
  HOSTED_ICON_PATHS,
  HOSTED_CONNECTION_LIVENESS,
  MESSAGE_TYPES,
  BROWSER_CLIENT_PREFIX,
  type FinalStepPhase,
  type HarnessId,
  type StepStatus,
  type StatusMessageSeverity,
} from "../types/DashboardConstants";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "../types/IconColorDefaults";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import { PostMessageDashboardSink } from "../ui/PostMessageDashboardSink";
import { findWorkflowFilesInWorkspace } from "../utils/WorkflowFileDiscovery";
import { getGitTrackedFiles } from "../utils/GitUtils";
import { Log } from "../utils/Log";
import { configService } from "../config/CtrlYokeConfigService";
import { createHostedHarnessStatusUpdate } from "./HostedServerMessageFactory";
import {
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
  type CtrlYokeNotificationEvent,
} from "../ui/notifications/CompletionNotificationFactory";
import { buildHostedServiceWorkerScript } from "./HostedServiceWorkerScript";
import { buildHostedStandaloneShimScript } from "./HostedStandaloneShimScript";
import {
  WebPushService,
  type WebPushSubscriptionPayload,
} from "./WebPushService";
import { pngIconService } from "./PngIconService";
import { HostedWorkspaceViewerService } from "./HostedWorkspaceViewerService";
import type {
  WorkspaceDeleteRequest,
  WorkspaceCopyRequest,
  WorkspaceMoveRequest,
  WorkspaceGenerateCommitMessageResponse,
  WorkspaceGitRefDiffResponse,
} from "../types/HostedWorkspaceViewerTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";

const THEME_VAR_KEY_PATTERN = /^--[A-Za-z0-9_-]+$/;

/**
 * Theme vars are spliced verbatim into a server-rendered `<style>` block
 * served to every hosted-dashboard visitor (see buildThemeStyleBlock). Only
 * well-formed CSS custom-property names are kept, and any value containing
 * `<`/`>` is dropped — that's the only way to break out of a `<style>`
 * element's raw-text content model into a new tag/script.
 */
export function sanitizeThemeVars(
  vars: Record<string, string>
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (
      typeof value === "string" &&
      THEME_VAR_KEY_PATTERN.test(key) &&
      !/[<>]/.test(value)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Sanitize a client-supplied stable clientId (the browser's persisted tabId) before
 * it is adopted as a server-side client identity. The id is used as a map key and
 * broadcast to every connected client, so it is restricted to a conservative
 * charset and length. Returns null when nothing usable remains (caller then mints a
 * per-connection fallback id).
 */
export function sanitizeBrowserClientId(
  supplied: string | null
): string | null {
  const sanitized = supplied
    ? supplied.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
    : "";
  return sanitized || null;
}

export class CtrlYokeHostedServer
  implements IDashboardProvider, IDashboardSink
{
  /**
   * When a new client connects we probe all existing sockets for liveness and
   * reap any that don't respond within this grace window — far faster than the
   * 30s steady-state heartbeat. This is what lets a freshly opened tab take over
   * control quickly after the previous tab closed: iOS Safari often fails to send
   * a WebSocket close (or run `pagehide`) on tab close, so without this the dead
   * tab lingers as the recorded controller for up to ~60s and the new tab is
   * stuck in view-only mode. Generous enough to tolerate high mobile RTT; a
   * backgrounded tab that gets reaped simply reconnects when it returns.
   */
  private static readonly NEW_CONNECTION_LIVENESS_PROBE_GRACE_MS = 3000;

  private app = express();
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections = new Set<WebSocket>();
  private readonly socketLiveness = new WeakMap<WebSocket, boolean>();
  private readonly socketLastProtocolPongAt = new WeakMap<WebSocket, number>();
  private readonly socketLastApplicationAckAt = new WeakMap<
    WebSocket,
    number
  >();
  private readonly socketTerminationCauses = new WeakMap<WebSocket, string>();
  /**
   * Per-socket clientId (the stable browser tag). Multiple sockets can briefly
   * share a tag when a reopened PWA/tab reconnects before the stale socket's close
   * is detected; this lets the close handler tell "last socket for this client
   * left" from "a stale duplicate closed while the client is still connected".
   */
  private readonly socketClientTags = new WeakMap<WebSocket, string>();
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private nextApplicationHeartbeatId = 1;
  private readonly workflowSummaries = new Map<string, WorkflowSummary>();
  private readonly notifiedEventIds = new Set<string>();
  private cachedThemeVars: Record<string, string> = {};
  private nextConnectionId = 1;
  private readonly sink: PostMessageDashboardSink;
  private readonly webPushService: WebPushService;
  private readonly isTls: boolean;
  private readonly tlsCertPath: string | undefined;
  private publicUrl?: string;
  private availableIps: string[] = [];
  private readonly viewerService: HostedWorkspaceViewerService;

  constructor(
    private hub: DashboardBroadcastHub,
    private webviewProvider: CtrlYokeWebviewProvider,
    private readonly getOrchestrator: () => WorkflowOrchestrator,
    private port: number,
    private workspaceRoot: string,
    namedWorkspaceRoots: ResolverWorkspaceFolder[],
    private token: string,
    private bindAddress: string = "127.0.0.1",
    tlsConfig?: { certPath: string; keyPath: string }
  ) {
    this.sink = new PostMessageDashboardSink((msg) => this.broadcast(msg));
    this.webPushService = new WebPushService(workspaceRoot);
    this.viewerService = new HostedWorkspaceViewerService(
      workspaceRoot,
      namedWorkspaceRoots
    );
    if (tlsConfig) {
      const cert = fs.readFileSync(tlsConfig.certPath);
      const key = fs.readFileSync(tlsConfig.keyPath);
      this.httpServer = createHttpsServer({ cert, key }, this.app);
      this.isTls = true;
      this.tlsCertPath = tlsConfig.certPath;
    } else {
      this.httpServer = createHttpServer(this.app);
      this.isTls = false;
    }
    // Prevent unhandled 'error' crashes before listen() registers its handler.
    // listen() adds its own once-handler on top of this permanent fallback.
    this.httpServer.on("error", (err: NodeJS.ErrnoException) => {
      Log.warn(`ctrlyoke server error: ${err.message}`);
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    // ws re-emits httpServer errors onto wss — add a handler to prevent crashes.
    this.wss.on("error", (err: Error) => {
      Log.warn(`ctrlyoke WebSocket server error: ${err.message}`);
    });
    this.app.use(express.json({ limit: "64kb" }));
    this.setupRoutes();
    this.setupWebSocket();
    this.setupHeartbeat();
    hub.addClient(this);
  }

  // ── IDashboardProvider — broadcast all orchestrator events ────────────────

  postMessage(message: unknown): void {
    this.broadcast(message);
  }

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.workflowSummaries.set(summary.id, summary);
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.workflowSummaries.delete(workflowId);
    for (const key of [...this.notifiedEventIds]) {
      if (key.startsWith(`${workflowId}:`)) {
        this.notifiedEventIds.delete(key);
      }
    }
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId });
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    const previousSummary = this.workflowSummaries.get(summary.id);
    this.workflowSummaries.set(summary.id, summary);
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });

    if (!isWorkflowCompletionTransition(previousSummary, summary)) {
      return;
    }

    void this.dispatchCompletionNotification(
      buildWorkflowCompletionNotification({
        summary,
        settings: configService.getAll().notifications,
        url: this.publicUrl,
      })
    );
  }

  notifyActiveWorkflowChanged(_workflowId: string): void {
    // Intentional no-op. ACTIVE_WORKFLOW_CHANGED must never be broadcast to
    // browser clients — each browser client's active workflow is driven exclusively
    // by replayWorkflowStateTo(), which sends directly via the client's scoped
    // postMessage.
  }

  notifyCliWatchOutput(
    workflowId: string,
    stepIndex: number,
    output: CliOutput
  ): void {
    this.broadcast({
      type: MESSAGE_TYPES.CLI_WATCH_OUTPUT,
      workflowId,
      stepIndex,
      output,
    });
  }

  notifyCliPromptsExtended(workflowId: string, steps: any[]): void {
    this.broadcast({ type: MESSAGE_TYPES.STEPS_EXTENDED, workflowId, steps });
  }

  notifyHarnessAvailability(
    harnessId: HarnessId,
    available: boolean,
    installHint: string
  ): void {
    this.broadcast(
      createHostedHarnessStatusUpdate(harnessId, available, installHint)
    );
  }

  // ── IDashboardSink — delegate to PostMessageDashboardSink ────────────────
  // Message shapes are single-sourced in PostMessageDashboardSink. Add new
  // methods there first, then add a one-liner delegate here.

  async updateFileSelected(
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
    workflowProperties?: Record<string, unknown>
  ): Promise<void> {
    return this.sink.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId,
      workflowProperties
    );
  }
  async updateSessionRestored(
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
    workflowProperties?: Record<string, unknown>
  ): Promise<void> {
    return this.sink.updateSessionRestored(
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId,
      workflowProperties
    );
  }
  updateExecutionStarted(
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
  notifyRunHistoryUpdated(
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
  updateProgress(current: number, total: number, workflowId?: string): void {
    this.sink.updateProgress(current, total, workflowId);
  }
  updateExecutionState(state: string, workflowId?: string): void {
    this.sink.updateExecutionState(state, workflowId);
  }
  updateExecutionCompleted(workflowId?: string): void {
    this.sink.updateExecutionCompleted(workflowId);
  }
  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    details?: Record<string, unknown>,
    workflowId?: string
  ): void {
    this.sink.updateStepStatus(stepIndex, status, details, workflowId);
    if (!workflowId) {
      return;
    }

    const summary = this.workflowSummaries.get(workflowId);
    if (!summary) {
      return;
    }

    const steps = this.getOrchestrator()
      .getWorkflow(workflowId)
      ?.getQueueState().steps;
    void this.dispatchCompletionNotification(
      buildPromptCompletionNotification({
        summary,
        steps,
        stepIndex,
        stepStatus: {
          state: status.state as StepStatus,
          duration: status.duration,
          message: status.message,
        },
        settings: configService.getAll().notifications,
        url: this.publicUrl,
      })
    );
  }
  updateRetryAttempt(
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
  updateCliOutput(
    stepIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    this.sink.updateCliOutput(stepIndex, output, workflowId);
  }
  updateCliStreamingChunk(
    stepIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.sink.updateCliStreamingChunk(stepIndex, chunk, workflowId);
  }
  updateCliStreamingEvents(
    stepIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    this.sink.updateCliStreamingEvents(
      stepIndex,
      events,
      attemptIndex,
      runIndex,
      workflowId
    );
  }
  updateContextWindow(
    stepIndex: number,
    used: number,
    size: number,
    workflowId?: string
  ): void {
    this.sink.updateContextWindow(stepIndex, used, size, workflowId);
  }
  updateStatusMessage(
    stepIndex: number,
    message: string,
    severity?: StatusMessageSeverity,
    workflowId?: string
  ): void {
    this.sink.updateStatusMessage(stepIndex, message, severity, workflowId);
  }
  updateStepsExtended(
    steps: any[],
    finalStep?: WorkflowStep | null,
    executionState?: string,
    workflowId?: string
  ): void {
    this.sink.updateStepsExtended(steps, finalStep, executionState, workflowId);
  }
  updatePromptDeleted(
    fileName: string,
    steps: any[],
    finalStep?: WorkflowStep | null
  ): void {
    this.sink.updatePromptDeleted(fileName, steps, finalStep);
  }
  updateFinalStep(finalStep: WorkflowStep | null, workflowId?: string): void {
    this.sink.updateFinalStep(finalStep, workflowId);
  }
  updateFinalStepStatus(
    status: StepStatus | null,
    loopCount: number,
    phase: FinalStepPhase | null,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStatus(status, loopCount, phase, workflowId);
  }
  updateFinalStepOutput(
    loopIndex: number,
    output: unknown,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepOutput(loopIndex, output, workflowId);
  }
  updateFinalStepStreamingChunk(
    loopIndex: number,
    chunk: string,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStreamingChunk(loopIndex, chunk, workflowId);
  }
  updateFinalStepStreamingEvents(
    loopIndex: number,
    events: CliEvent[],
    attemptIndex?: number,
    runIndex?: number,
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStreamingEvents(
      loopIndex,
      events,
      attemptIndex,
      runIndex,
      workflowId
    );
  }
  notifyWorkflowStateReset(steps: any[], workflowId?: string): void {
    this.sink.notifyWorkflowStateReset(steps, workflowId);
  }

  async sendTestNotification(): Promise<void> {
    await this.dispatchCompletionNotification(
      buildTestNotificationEvent(this.publicUrl)
    );
  }

  notifyStartPositionSet(
    steps: WorkflowStep[],
    currentIndex: number,
    workflowId?: string
  ): void {
    this.sink.notifyStartPositionSet(steps, currentIndex, workflowId);
  }
  notifyPromptsReordered(steps: WorkflowStep[], workflowId?: string): void {
    this.sink.notifyPromptsReordered(steps, workflowId);
  }
  notifyUndoRedoSynced(): void {
    this.sink.notifyUndoRedoSynced();
  }
  updateWorkflowName(name: string, workflowId?: string): void {
    this.sink.updateWorkflowName(name, workflowId);
  }
  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot
  ): void {
    this.sink.sendStepUndoDataUpdated(target, workspaceSnapshot);
  }

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    void this.dispatchCompletionNotification(event);
  }

  // ── Theme var snapshot (fed from VS Code webview capture) ─────────────────

  updateThemeVars(vars: Record<string, string>): void {
    this.cachedThemeVars = sanitizeThemeVars(vars);
    this.broadcast({
      type: MESSAGE_TYPES.THEME_VARS_UPDATED,
      vars: this.cachedThemeVars,
    });
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const webviewDist = this.resolveWebviewDist();
    // Serve static assets (CSS/JS/fonts) without token — they are not sensitive and
    // the browser fetches them without query params after loading the entry HTML.
    this.app.get("/standalone-shim.js", (_req, res) => {
      this.setNoStore(res);
      res
        .type("application/javascript")
        .send(buildHostedStandaloneShimScript());
    });
    // Cert download — no token required so iOS users can fetch and install it
    // before the WebSocket handshake can succeed. The cert is a public key only.
    this.app.get("/cert", (_req, res) => {
      if (!this.tlsCertPath) {
        res.status(404).send("Not found");
        return;
      }
      try {
        const cert = fs.readFileSync(this.tlsCertPath);
        this.setNoStore(res);
        res.setHeader("Content-Type", "application/x-x509-ca-cert");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="ctrlyoke.cer"'
        );
        res.send(cert);
      } catch {
        res.status(404).send("Certificate not found");
      }
    });
    this.app.get("/ctrlyoke-service-worker.js", (_req, res) => {
      this.setNoStore(res);
      res.type("application/javascript").send(buildHostedServiceWorkerScript());
    });
    // Dynamic SVG icon routes — apply configurable background/foreground colors to the
    // SVG templates on each request. PNG files continue to be served as static assets.
    this.app.get("/favicon.svg", (_req, res) => {
      const svgPath = path.join(webviewDist, HOSTED_ICON_FILES.FAVICON_SVG);
      this.serveColorizedSvg(svgPath, res);
    });
    this.app.get("/app-icon.svg", (_req, res) => {
      const svgPath = path.join(webviewDist, HOSTED_ICON_FILES.APP_ICON_SVG);
      this.serveColorizedSvg(svgPath, res);
    });
    // Dynamic PNG routes — generated via resvg-wasm with configurable colors. Cached in memory
    // and regenerated only when colors change (on settings save). These override the static PNG
    // files in webviewDist so that color changes apply to iOS < 26 homescreen icons.
    this.app.get(HOSTED_ICON_PATHS.APPLE_TOUCH_ICON_PNG, (_req, res) => {
      const svgPath = path.join(webviewDist, HOSTED_ICON_FILES.APP_ICON_SVG);
      void this.serveColorizedPng(svgPath, "small", res);
    });
    this.app.get(HOSTED_ICON_PATHS.APP_ICON_PNG, (_req, res) => {
      const svgPath = path.join(webviewDist, HOSTED_ICON_FILES.APP_ICON_SVG);
      void this.serveColorizedPng(svgPath, "large", res);
    });
    this.app.use(express.static(webviewDist, { index: false }));

    // Token is required for the HTML entry point and all API routes.
    const requireToken: express.RequestHandler = (req, res, next) => {
      if (this.requestHasValidToken(req)) return next();
      res.status(401).send("Unauthorized");
    };
    this.app.get("/manifest.webmanifest", requireToken, (_req, res) => {
      this.setNoStore(res);
      res
        .type("application/manifest+json")
        .send(JSON.stringify(this.buildManifest()));
    });
    this.app.get(
      "/api/notifications/vapid-public-key",
      requireToken,
      async (_req, res) => {
        res.json({ publicKey: await this.webPushService.getPublicKey() });
      }
    );
    this.app.get(
      "/api/notifications/subscriptions",
      requireToken,
      async (_req, res) => {
        res.json(await this.webPushService.listSubscriptions());
      }
    );
    this.app.post(
      "/api/notifications/subscriptions",
      requireToken,
      async (req, res) => {
        const body = req.body as {
          subscription?: WebPushSubscriptionPayload;
          label?: string;
        };
        if (!isValidPushSubscription(body?.subscription)) {
          res.status(400).json({ error: "Invalid push subscription payload" });
          return;
        }
        const subscription = await this.webPushService.upsertSubscription(
          body.subscription,
          {
            userAgent: req.get("user-agent") ?? undefined,
            label: body.label,
          }
        );
        res.status(201).json({ id: subscription.id });
      }
    );
    this.app.delete(
      "/api/notifications/subscriptions/:id",
      requireToken,
      async (req, res) => {
        const id =
          typeof req.params.id === "string" ? req.params.id : req.params.id[0];
        const removed = await this.webPushService.removeSubscription(id);
        res.json({ removed });
      }
    );
    // Serve index.html through buildHtml so all placeholders are patched first.
    this.app.get(["/", "/index.html"], requireToken, (req, res) => {
      this.setNoStore(res);
      res.send(this.buildHtml(webviewDist, req.get("host")));
    });
    this.app.get("/api/workflow-files", requireToken, async (_req, res) => {
      const files = findWorkflowFilesInWorkspace(this.workspaceRoot);
      const trackedFiles = await getGitTrackedFiles(this.workspaceRoot).catch(
        () => null
      );
      const isGitRepo = trackedFiles !== null;
      const trackedSet = trackedFiles ? new Set(trackedFiles) : null;
      res.json({
        workspaceRoot: this.workspaceRoot,
        isGitRepo,
        files: files.map((file) => ({
          ...file,
          gitIgnored: trackedSet ? !trackedSet.has(file.relativePath) : false,
        })),
      });
    });

    // ── Workspace Viewer API ────────────────────────────────────────────────

    this.app.get(
      "/api/workspace-viewer/tree",
      requireToken,
      async (req, res) => {
        const dirPath =
          typeof req.query.path === "string" ? req.query.path : "";
        try {
          res.json(await this.viewerService.listDirectory(dirPath));
        } catch (err) {
          Log.error(`workspace-viewer /tree error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/file",
      requireToken,
      async (req, res) => {
        const filePath =
          typeof req.query.path === "string" ? req.query.path : "";
        if (!filePath) {
          res.status(400).json({ error: "path is required" });
          return;
        }
        try {
          res.json(await this.viewerService.readFile(filePath));
        } catch (err) {
          Log.error(`workspace-viewer GET /file error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.put(
      "/api/workspace-viewer/file",
      requireToken,
      express.json({ limit: "5mb" }),
      async (req, res) => {
        const body = req.body as { path?: unknown; content?: unknown };
        if (typeof body.path !== "string" || typeof body.content !== "string") {
          res.status(400).json({ error: "path and content are required" });
          return;
        }
        try {
          await this.viewerService.saveFile({
            path: body.path,
            content: body.content,
          });
          res.json({});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Path not allowed") {
            res.status(403).json({ error: message });
          } else {
            Log.error(`workspace-viewer PUT /file error: ${message}`);
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.delete(
      "/api/workspace-viewer/entry",
      requireToken,
      async (req, res) => {
        const deleteRequest: WorkspaceDeleteRequest = {
          path: typeof req.query["path"] === "string" ? req.query["path"] : "",
        };
        try {
          await this.viewerService.deleteEntry(deleteRequest.path);
          res.status(204).send();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(`workspace-viewer DELETE /entry error: ${message}`);
          res.status(400).json({ error: message });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/copy",
      requireToken,
      async (req, res) => {
        const body = req.body as Partial<WorkspaceCopyRequest>;
        if (
          typeof body.sourcePath !== "string" ||
          typeof body.destDir !== "string" ||
          (body.newName !== undefined && typeof body.newName !== "string")
        ) {
          res
            .status(400)
            .json({ error: "sourcePath and destDir are required" });
          return;
        }
        try {
          await this.viewerService.copyEntry({
            sourcePath: body.sourcePath,
            destDir: body.destDir,
            newName: body.newName,
          });
          res.status(204).send();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(`workspace-viewer POST /copy error: ${message}`);
          res.status(400).json({ error: message });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/move",
      requireToken,
      async (req, res) => {
        const body = req.body as Partial<WorkspaceMoveRequest>;
        if (
          typeof body.sourcePath !== "string" ||
          typeof body.destDir !== "string" ||
          (body.newName !== undefined && typeof body.newName !== "string")
        ) {
          res
            .status(400)
            .json({ error: "sourcePath and destDir are required" });
          return;
        }
        try {
          await this.viewerService.moveEntry({
            sourcePath: body.sourcePath,
            destDir: body.destDir,
            newName: body.newName,
          });
          res.status(204).send();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(`workspace-viewer POST /move error: ${message}`);
          res.status(400).json({ error: message });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/repos",
      requireToken,
      async (_req, res) => {
        try {
          res.json(await this.viewerService.getRepos());
        } catch (err) {
          Log.error(`workspace-viewer /repos error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/status",
      requireToken,
      async (req, res) => {
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          res.json(await this.viewerService.getStatus(repo));
        } catch (err) {
          Log.error(`workspace-viewer /status error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/diff",
      requireToken,
      async (req, res) => {
        const filePath =
          typeof req.query.path === "string" ? req.query.path : "";
        if (!filePath) {
          res.status(400).json({ error: "path is required" });
          return;
        }
        try {
          res.json(await this.viewerService.getDiff(filePath));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Path not allowed") {
            res.status(403).json({ error: message });
          } else {
            Log.error(`workspace-viewer /diff error: ${message}`);
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/stage",
      requireToken,
      async (req, res) => {
        const body = req.body as { path?: unknown };
        if (typeof body.path !== "string") {
          res.status(400).json({ error: "path is required" });
          return;
        }
        try {
          await this.viewerService.stageFile(body.path);
          res.json({});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Path not allowed") {
            res.status(403).json({ error: message });
          } else {
            Log.error(`workspace-viewer /stage error: ${message}`);
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/unstage",
      requireToken,
      async (req, res) => {
        const body = req.body as { path?: unknown };
        if (typeof body.path !== "string") {
          res.status(400).json({ error: "path is required" });
          return;
        }
        try {
          await this.viewerService.unstageFile(body.path);
          res.json({});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Path not allowed") {
            res.status(403).json({ error: message });
          } else {
            Log.error(`workspace-viewer /unstage error: ${message}`);
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/discard",
      requireToken,
      async (req, res) => {
        const body = req.body as { path?: unknown };
        if (typeof body.path !== "string") {
          res.status(400).json({ error: "path is required" });
          return;
        }
        try {
          await this.viewerService.discardFile(body.path);
          res.json({});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === "Path not allowed") {
            res.status(403).json({ error: message });
          } else {
            Log.error(`workspace-viewer /discard error: ${message}`);
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/commit",
      requireToken,
      async (req, res) => {
        const body = req.body as { message?: unknown; repo?: unknown };
        if (typeof body.message !== "string" || !body.message.trim()) {
          res.status(400).json({ error: "message is required" });
          return;
        }
        const repo = typeof body.repo === "string" ? body.repo : undefined;
        try {
          await this.viewerService.commit(body.message, repo);
          res.json({});
        } catch (err) {
          Log.error(`workspace-viewer /commit error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/push",
      requireToken,
      async (req, res) => {
        const repo =
          typeof req.body?.repo === "string" ? req.body.repo : undefined;
        try {
          res.json(await this.viewerService.push(repo));
        } catch (err) {
          Log.error(`workspace-viewer /push error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/pull",
      requireToken,
      async (req, res) => {
        const repo =
          typeof req.body?.repo === "string" ? req.body.repo : undefined;
        try {
          res.json(await this.viewerService.pull(repo));
        } catch (err) {
          Log.error(`workspace-viewer /pull error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/generate-commit-message",
      requireToken,
      async (req, res) => {
        try {
          const instructions =
            typeof req.body?.instructions === "string"
              ? req.body.instructions
              : undefined;
          const repo =
            typeof req.body?.repo === "string" ? req.body.repo : undefined;
          const result = await this.viewerService.generateCommitMessage(
            instructions,
            repo
          );
          if (!result) {
            res.status(422).json({
              error: "No changes detected. Stage or modify files first.",
            });
            return;
          }
          res.json({
            message: result.message,
            staged: result.staged,
            truncated: result.truncated,
          } satisfies WorkspaceGenerateCommitMessageResponse);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(
            `workspace-viewer /generate-commit-message error: ${message}`
          );
          res.status(500).json({ error: message });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/commit-log",
      requireToken,
      async (req, res) => {
        const skip = parseInt(String(req.query.skip ?? "0"), 10);
        const limit = parseInt(String(req.query.limit ?? "30"), 10);
        const branch =
          typeof req.query.branch === "string" && req.query.branch.trim()
            ? req.query.branch.trim()
            : undefined;
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          res.json(
            await this.viewerService.getCommitLog(
              Number.isFinite(skip) ? skip : 0,
              Number.isFinite(limit) && limit > 0 ? limit : 30,
              branch,
              repo
            )
          );
        } catch (err) {
          Log.error(`workspace-viewer /commit-log error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/git-ref-diff",
      requireToken,
      async (req, res) => {
        const ref = req.query.ref;
        if (typeof ref !== "string" || !ref) {
          res.status(400).json({ error: "ref is required" });
          return;
        }
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          const result = await this.viewerService.getGitRefDiff(ref, repo);
          res.json(result satisfies WorkspaceGitRefDiffResponse);
        } catch (err) {
          Log.error(`workspace-viewer /git-ref-diff error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/checkout-commit",
      requireToken,
      async (req, res) => {
        const body = req.body as { hash?: unknown; repo?: unknown };
        if (typeof body.hash !== "string" || !body.hash.trim()) {
          res.status(400).json({ error: "hash is required" });
          return;
        }
        const repo = typeof body.repo === "string" ? body.repo : undefined;
        try {
          res.json(
            await this.viewerService.checkoutCommit(body.hash.trim(), repo)
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(`workspace-viewer /checkout-commit error: ${message}`);
          res.status(500).json({ error: message });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/checkout-branch",
      requireToken,
      async (req, res) => {
        const body = req.body as { branch?: unknown; repo?: unknown };
        if (typeof body.branch !== "string" || !body.branch.trim()) {
          res.status(400).json({ error: "branch is required" });
          return;
        }
        const repo = typeof body.repo === "string" ? body.repo : undefined;
        try {
          res.json(
            await this.viewerService.checkoutBranch(body.branch.trim(), repo)
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.error(`workspace-viewer /checkout-branch error: ${message}`);
          res.status(500).json({ error: message });
        }
      }
    );

    // SPA fallback: any unmatched route gets the patched index.html (token required).
    this.app.use(requireToken, (req, res) => {
      this.setNoStore(res);
      res.send(this.buildHtml(webviewDist, req.get("host")));
    });
  }

  private setNoStore(res: express.Response): void {
    res.set("Cache-Control", "no-store, max-age=0");
    res.set("Pragma", "no-cache");
  }

  private buildHtml(webviewDist: string, requestHost?: string): string {
    const indexPath = path.join(webviewDist, "index.html");
    let html = fs.readFileSync(indexPath, "utf8");

    // Replace VS Code URI placeholders with server-relative paths.
    // typo.js is copied to webview-react/ by Vite and served as a static asset.
    html = html.replace(/\{\{typoUri\}\}/g, "/typo.js");
    html = html.replace(/\{\{codiconsUri\}\}/g, "/codicons/codicon.css");
    html = html.replace(/\{\{customIconsUri\}\}/g, "/custom-icons.css");
    html = html.replace(/\{\{logoUri\}\}/g, "/ctrlyoke-icon.svg");
    // Vite adds crossorigin to module scripts; remove it for same-origin serving.
    html = html.replace(
      /<script type="module" crossorigin/g,
      '<script type="module"'
    );

    // Add spell-checker dictionary paths as data attributes on <body>.
    // Also inject the VS Code theme body class (vscode-dark / vscode-light /
    // vscode-high-contrast) from the cached theme vars so that CSS rules that
    // gate on body class (e.g. harness-icon-adaptive inversion) work correctly
    // on first render, before the WebSocket THEME_VARS_UPDATED message arrives.
    const themeKind = this.cachedThemeVars["--fp-color-theme-kind"];
    const themeBodyClass =
      themeKind === "light"
        ? "vscode-light"
        : themeKind === "high-contrast"
          ? "vscode-high-contrast"
          : "vscode-dark";
    html = html.replace(
      "<body>",
      `<body class="${themeBodyClass}" data-aff-uri="/dictionaries/en_US/en_US.aff" data-dic-uri="/dictionaries/en_US/en_US.dic" data-logo-uri="/ctrlyoke-icon.svg">`
    );

    // Replace the VS Code-specific CSP with a browser-compatible policy.
    // connect-src must explicitly allow the WebSocket endpoint.
    const normalizedHost = requestHost?.trim();
    const host =
      normalizedHost && this.isSafeRequestHost(normalizedHost)
        ? normalizedHost
        : `localhost:${this.port}`;
    const websocketSources = [
      `ws://${host}`,
      `wss://${host}`,
      `ws://localhost:${this.port}`,
      `ws://127.0.0.1:${this.port}`,
    ];
    const connectSources = Array.from(new Set(["'self'", ...websocketSources]));
    const csp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "script-src 'self' 'unsafe-inline'",
      "worker-src 'self'",
      "manifest-src 'self'",
      `connect-src ${connectSources.join(" ")}`,
    ].join("; ");
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
    );

    // Inject theme vars and standalone shim before </head>.
    const themeBlock = this.buildThemeStyleBlock();
    // Append current colors as query params to SVG icon URLs so that browsers (which cache
    // favicon/icon resources aggressively and often ignore Cache-Control headers) pick up the
    // new icon as soon as colors change. The server-side route ignores these params — they exist
    // solely to bust the browser's icon cache. PNG icons are static and need no versioning.
    const {
      iconBgColor = ICON_BG_COLOR_DEFAULT,
      iconFgColor = ICON_FG_COLOR_DEFAULT,
    } = configService.getAll().server;
    const iconColorParam = `?bg=${iconBgColor.replace("#", "")}&fg=${iconFgColor.replace("#", "")}`;
    const hostedIconLinks = [
      // sizes="any" signals this is a scalable SVG — browsers that support SVG will prefer it
      // without fetching the PNG at all. Without this attribute browsers fetch both and show
      // whichever responds first (a race condition).  The PNG fallback is removed; all modern
      // browsers that display favicons support SVG. A default /favicon.ico request will 404
      // gracefully, which is fine.
      `<link rel="icon" type="image/svg+xml" sizes="any" href="${HOSTED_ICON_PATHS.FAVICON_SVG}${iconColorParam}" />`,
      // SVG apple-touch-icon — delivers custom background/foreground colors dynamically.
      // No `sizes` attribute makes it the highest-priority default. iOS SpringBoard fetches
      // this independently from Safari; it requires the server cert to be trusted at the
      // system level (Settings → General → About → Certificate Trust Settings). Once trusted,
      // iOS 15+ will use the SVG for the homescreen icon. PNG is kept as a sized fallback because
      // iOS Safari does not support SVG for homescreen icons — only PNG.
      `<link rel="apple-touch-icon" type="image/svg+xml" sizes="any" href="${HOSTED_ICON_PATHS.APP_ICON_SVG}${iconColorParam}" />`,
      `<link rel="apple-touch-icon" sizes="180x180" href="${HOSTED_ICON_PATHS.APPLE_TOUCH_ICON_PNG}${iconColorParam}" />`,
      // Enable standalone PWA mode and set the title shown under the home screen icon.
      `<meta name="apple-mobile-web-app-capable" content="yes" />`,
      `<meta name="apple-mobile-web-app-title" content="ctrlyoke" />`,
    ].join("");
    return html.replace(
      "</head>",
      `${themeBlock}${hostedIconLinks}<link rel="manifest" href="/manifest.webmanifest?token=${encodeURIComponent(this.token)}" /><script src="/standalone-shim.js"></script></head>`
    );
  }

  private buildThemeStyleBlock(): string {
    const vars = Object.entries(this.cachedThemeVars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return vars ? `<style>:root {\n${vars}\n}</style>\n` : "";
  }

  private serveColorizedSvg(svgPath: string, res: express.Response): void {
    try {
      const {
        iconBgColor = ICON_BG_COLOR_DEFAULT,
        iconFgColor = ICON_FG_COLOR_DEFAULT,
      } = configService.getAll().server;
      const svg = fs
        .readFileSync(svgPath, "utf8")
        .replace(new RegExp(ICON_BG_COLOR_DEFAULT, "gi"), iconBgColor)
        .replace(new RegExp(ICON_FG_COLOR_DEFAULT, "gi"), iconFgColor);
      this.setNoStore(res);
      res.type("image/svg+xml").send(svg);
    } catch {
      res.status(404).send("Not found");
    }
  }

  private async serveColorizedPng(
    svgPath: string,
    size: "small" | "large",
    res: express.Response
  ): Promise<void> {
    try {
      const {
        iconBgColor = ICON_BG_COLOR_DEFAULT,
        iconFgColor = ICON_FG_COLOR_DEFAULT,
      } = configService.getAll().server;
      const buffer =
        size === "small"
          ? await pngIconService.getSmall(svgPath, iconBgColor, iconFgColor)
          : await pngIconService.getLarge(svgPath, iconBgColor, iconFgColor);
      if (!buffer) {
        res.status(404).send("Not found");
        return;
      }
      this.setNoStore(res);
      res.type("image/png").send(buffer);
    } catch {
      res.status(500).send("Error");
    }
  }

  private requestHasValidToken(req: express.Request): boolean {
    const headerToken = req.get("x-ctrlyoke-token");
    if (headerToken === this.token) {
      return true;
    }
    return req.query["token"] === this.token;
  }

  private buildManifest(): Record<string, unknown> {
    const {
      iconBgColor = ICON_BG_COLOR_DEFAULT,
      iconFgColor = ICON_FG_COLOR_DEFAULT,
    } = configService.getAll().server;
    const iconColorParam = `?bg=${iconBgColor.replace("#", "")}&fg=${iconFgColor.replace("#", "")}`;
    return {
      name: "ctrlyoke",
      short_name: "ctrlyoke",
      display: "standalone",
      start_url: `/?token=${this.token}`,
      scope: "/",
      icons: [
        {
          src: `${HOSTED_ICON_PATHS.APPLE_TOUCH_ICON_PNG}${iconColorParam}`,
          sizes: "180x180",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `${HOSTED_ICON_PATHS.APP_ICON_PNG}${iconColorParam}`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `${HOSTED_ICON_PATHS.APP_ICON_SVG}${iconColorParam}`,
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any",
        },
      ],
      theme_color: "#1f1f1f",
      background_color: "#1f1f1f",
    };
  }

  private isSafeRequestHost(host: string): boolean {
    return /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(host);
  }

  private async dispatchCompletionNotification(
    event: CtrlYokeNotificationEvent | undefined
  ): Promise<void> {
    if (!event) {
      return;
    }

    const notificationSettings = configService.getAll().notifications;
    if (
      notificationSettings.browser.mode === BROWSER_NOTIFICATION_MODES.NEVER
    ) {
      return;
    }
    if (this.notifiedEventIds.has(event.id)) {
      return;
    }
    this.notifiedEventIds.add(event.id);

    this.broadcast({
      type: MESSAGE_TYPES.NOTIFICATION_EVENT,
      event,
    });

    if (notificationSettings.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH) {
      try {
        const result = await this.webPushService.sendNotification(event);
        if (result.sent || result.removed || result.failed) {
          Log.debug(
            `[hosted-server] push notification ${event.id} sent=${result.sent} removed=${result.removed} failed=${result.failed}`
          );
        }
      } catch (error) {
        Log.warn(
          `[hosted-server] push notification dispatch failed for ${event.id}: ${error}`
        );
      }
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private setupWebSocket(): void {
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", `http://localhost`);
      if (url.searchParams.get("token") !== this.token) {
        ws.close(4401, "Unauthorized");
        return;
      }
      const clientTag = this.resolveClientTag(url);
      const connectedAt = Date.now();
      this.connections.add(ws);
      this.socketLiveness.set(ws, true);
      this.socketLastProtocolPongAt.set(ws, connectedAt);
      this.socketLastApplicationAckAt.set(ws, connectedAt);
      this.socketClientTags.set(ws, clientTag);
      // A reopened PWA/tab presents the same stable id while a stale socket for it
      // may still linger (iOS often never reports the old close). Terminate that
      // stale socket so identity and controller status transfer cleanly to this
      // connection; its close handler is id-aware and won't release the controller
      // we're inheriting. Register this socket first so that check sees it.
      this.takeoverStaleSocketsForTag(clientTag, ws);
      // A new connection is the moment we most need to know whether previously
      // recorded clients (e.g. a phone tab that was just closed) are actually
      // still alive — so the new tab can take over an orphaned controller slot
      // without waiting for the slow steady-state heartbeat.
      this.probeExistingConnectionsForLiveness(ws, clientTag);
      let sawReady = false;
      Log.debug(
        `[hosted-server] WebSocket connected clientId=${clientTag} connectedCount=${this.connections.size} ip=${req.socket.remoteAddress ?? ""} ua=${req.headers["user-agent"] ?? ""} origin=${req.headers.origin ?? ""}`
      );
      const send = (reply: unknown): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      };
      this.sendInitialState(ws);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT) {
            const heartbeatId = this.getHeartbeatId(msg);
            if (heartbeatId) {
              this.socketLastApplicationAckAt.set(ws, Date.now());
              send({
                type: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK,
                id: heartbeatId,
              });
            }
            return;
          }
          if (msg?.type === MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK) {
            if (this.getHeartbeatId(msg)) {
              this.socketLastApplicationAckAt.set(ws, Date.now());
            }
            return;
          }
          if (msg?.type === MESSAGE_TYPES.READY) {
            sawReady = true;
            Log.debug(
              `[hosted-server] WebSocket READY clientId=${clientTag} afterMs=${Date.now() - connectedAt} preferredWorkingFilePath=${typeof msg.preferredWorkingFilePath === "string" ? msg.preferredWorkingFilePath : ""}`
            );
          }
          void this.webviewProvider
            .routeExternalMessage(msg, send, clientTag)
            .catch((error) => {
              Log.warn(
                `[hosted-server] routeExternalMessage failed for ${clientTag}: ${error}`
              );
            });
        } catch (error) {
          Log.warn(
            `[hosted-server] ignored malformed WebSocket message from ${clientTag}: ${error}`
          );
        }
      });
      ws.on("pong", () => {
        this.socketLiveness.set(ws, true);
        this.socketLastProtocolPongAt.set(ws, Date.now());
      });
      ws.on("close", (code, reason) => {
        const terminationCause = this.socketTerminationCauses.get(ws);
        this.connections.delete(ws);
        this.socketLiveness.delete(ws);
        this.socketLastProtocolPongAt.delete(ws);
        this.socketLastApplicationAckAt.delete(ws);
        this.socketTerminationCauses.delete(ws);
        this.socketClientTags.delete(ws);
        // Only unregister the client (releasing its controller slot + remembered
        // terminal viewport) if no OTHER live socket still holds this id. With
        // stable ids a reopened tab briefly overlaps the stale socket, so the late
        // close of that stale socket must not strip control from the socket that
        // just inherited it.
        const clientStillConnected = this.hasLiveSocketForTag(clientTag);
        Log.debug(
          `[hosted-server] WebSocket closed clientId=${clientTag} ready=${sawReady} lifetimeMs=${Date.now() - connectedAt} code=${code} reason=${reason.toString()} terminationCause=${terminationCause ?? "peer-or-network"} remainingCount=${this.connections.size} clientStillConnected=${clientStillConnected}`
        );
        if (!clientStillConnected) {
          this.webviewProvider.unregisterBrowserClient(clientTag);
        }
      });
      ws.on("error", (error) => {
        Log.warn(
          `[hosted-server] WebSocket error clientId=${clientTag}: ${error}`
        );
      });
    });
  }

  /**
   * Resolve the clientId for a new WebSocket from its `clientId` query param — the
   * client's stable, persisted tabId. Sanitized (identity is used as a map key and
   * broadcast to all clients) and namespaced with BROWSER_CLIENT_PREFIX so it can
   * never collide with the panel id. Falls back to a per-connection counter when
   * absent (older clients / stripped param) so the id is at least unique.
   */
  private resolveClientTag(url: URL): string {
    const id = sanitizeBrowserClientId(url.searchParams.get("clientId"));
    return id
      ? `${BROWSER_CLIENT_PREFIX}${id}`
      : `${BROWSER_CLIENT_PREFIX}${this.nextConnectionId++}`;
  }

  /**
   * Terminate any already-registered socket that shares `tag` with a just-connected
   * socket (`keep`). This is the reconnect path: the same logical client returned,
   * so the stale socket is abandoned. The stale socket's id-aware close handler
   * sees `keep` and skips unregister, so the controller slot survives the handoff.
   */
  private takeoverStaleSocketsForTag(tag: string, keep: WebSocket): void {
    for (const ws of this.connections) {
      if (ws === keep) continue;
      if (this.socketClientTags.get(ws) !== tag) continue;
      Log.debug(
        `[hosted-server] reconnect takeover: terminating stale socket for ${tag}`
      );
      this.terminateSocket(ws, "same-client-reconnect-takeover");
    }
  }

  /** True if any still-connected socket carries `tag` (see id-aware close). */
  private hasLiveSocketForTag(tag: string): boolean {
    for (const ws of this.connections) {
      if (
        ws.readyState !== WebSocket.OPEN &&
        ws.readyState !== WebSocket.CONNECTING
      ) {
        continue;
      }
      if (this.socketClientTags.get(ws) === tag) return true;
    }
    return false;
  }

  /**
   * Ping every currently-open socket except the one that just connected, then
   * terminate any that fail to pong within the grace window. Terminating a dead
   * socket fires its `close` handler → `unregisterBrowserClient` → the orphaned
   * controller slot is released and broadcast as CONTROLLER_CHANGED(undefined),
   * which the surviving client auto-claims. Live clients pong and keep control,
   * so this never steals control from an active controller.
   */
  private probeExistingConnectionsForLiveness(
    newlyConnected: WebSocket,
    newClientTag: string
  ): void {
    const probed: WebSocket[] = [];
    for (const ws of this.connections) {
      if (ws === newlyConnected) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;
      this.socketLiveness.set(ws, false);
      try {
        ws.ping();
        probed.push(ws);
      } catch (error) {
        this.terminateSocket(
          ws,
          "new-connection-probe-send-failed",
          `triggeredBy=${newClientTag} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (probed.length === 0) return;
    Log.debug(
      `[hosted-server] new connection ${newClientTag} probing ${probed.length} existing socket(s) for liveness`
    );
    setTimeout(() => {
      for (const ws of probed) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (this.socketLiveness.get(ws) === false) {
          this.terminateSocket(
            ws,
            "new-connection-protocol-pong-timeout",
            `triggeredBy=${newClientTag}`
          );
        }
      }
    }, CtrlYokeHostedServer.NEW_CONNECTION_LIVENESS_PROBE_GRACE_MS);
  }

  private setupHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.runHeartbeatCycle();
    }, HOSTED_CONNECTION_LIVENESS.HEARTBEAT_INTERVAL_MS);
  }

  private runHeartbeatCycle(): void {
    const now = Date.now();
    for (const ws of this.connections) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      if (this.socketLiveness.get(ws) === false) {
        const lastPongAt = this.socketLastProtocolPongAt.get(ws) ?? now;
        this.terminateSocket(
          ws,
          "protocol-pong-timeout",
          `lastPongAgoMs=${now - lastPongAt}`
        );
        continue;
      }

      const lastApplicationAckAt =
        this.socketLastApplicationAckAt.get(ws) ?? now;
      if (
        now - lastApplicationAckAt >
        HOSTED_CONNECTION_LIVENESS.SERVER_APPLICATION_ACK_TIMEOUT_MS
      ) {
        this.terminateSocket(
          ws,
          "application-heartbeat-ack-timeout",
          `lastApplicationAckAgoMs=${now - lastApplicationAckAt}`
        );
        continue;
      }

      this.socketLiveness.set(ws, false);
      try {
        ws.ping();
        ws.send(
          JSON.stringify({
            type: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT,
            id: `server-${this.nextApplicationHeartbeatId++}`,
            sentAt: now,
          })
        );
      } catch (error) {
        this.terminateSocket(
          ws,
          "heartbeat-send-failed",
          `error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private getHeartbeatId(message: unknown): string | undefined {
    if (!message || typeof message !== "object") return undefined;
    const id = (message as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 && id.length <= 128
      ? id
      : undefined;
  }

  private terminateSocket(ws: WebSocket, cause: string, detail?: string): void {
    if (this.socketTerminationCauses.has(ws)) return;
    this.socketTerminationCauses.set(ws, cause);
    const clientTag = this.socketClientTags.get(ws) ?? "browser:unknown";
    Log.warn(
      `[hosted-server] terminating WebSocket clientId=${clientTag} cause=${cause}${detail ? ` ${detail}` : ""}`
    );
    try {
      ws.terminate();
    } catch {
      // Best-effort; close/error handlers own the rest of cleanup.
    }
  }

  private sendInitialState(ws: WebSocket): void {
    // Push cached theme vars immediately so the client can style itself without waiting
    // for a CAPTURE_THEME_VARS round-trip. The shim applies themeVarsUpdated directly
    // to :root before React mounts, so this is safe to send at connection time.
    if (
      Object.keys(this.cachedThemeVars).length > 0 &&
      ws.readyState === WebSocket.OPEN
    ) {
      ws.send(
        JSON.stringify({
          type: MESSAGE_TYPES.THEME_VARS_UPDATED,
          vars: this.cachedThemeVars,
        })
      );
    }
    // Request a fresh capture so any theme-change since last capture is picked up.
    this.webviewProvider.postMessage({
      type: MESSAGE_TYPES.CAPTURE_THEME_VARS,
    });
    // NOTE: We intentionally do NOT inject a server-side synthetic READY here.
    // Browser-client registration belongs to standalone-shim.js: it sends READY
    // when the socket opens, buffers replay messages, then flushes them only
    // after React posts its own READY and useMessageHandler is listening.
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(message);
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const attemptListen = (port: number) => {
        const onError = (err: NodeJS.ErrnoException) => {
          this.httpServer.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE") {
            setImmediate(() => attemptListen(0));
          } else {
            reject(err);
          }
        };
        const onListening = () => {
          this.httpServer.removeListener("error", onError);
          const addr = this.httpServer.address() as import("net").AddressInfo;
          this.port = addr.port;
          const scheme = this.isTls ? "https" : "http";
          this.availableIps =
            this.bindAddress === "0.0.0.0" ? this.getLanIps() : [];
          const host = this.availableIps[0] ?? "localhost";
          this.publicUrl = `${scheme}://${host}:${this.port}/?token=${this.token}`;
          resolve(this.publicUrl);
        };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        this.httpServer.listen(port, this.bindAddress);
      };
      attemptListen(this.port);
    });
  }

  getAvailableIps(): string[] {
    return this.availableIps;
  }

  private getLanIps(): string[] {
    const ips: string[] = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
      }
    }
    return ips;
  }

  dispose(): void {
    this.hub.removeClient(this);
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    for (const ws of this.connections) ws.close();
    this.connections.clear();
    this.wss.close();
    this.httpServer.close();
  }

  private resolveWebviewDist(): string {
    // Vite outputs to out/ui/webview-react/ relative to the extension root.
    // __dirname at runtime = out/ (esbuild resolves __dirname to the output file's directory).
    return path.join(__dirname, "ui", "webview-react");
  }
}

function isValidPushSubscription(
  value: unknown
): value is WebPushSubscriptionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WebPushSubscriptionPayload>;
  return Boolean(
    candidate.endpoint &&
    candidate.keys &&
    candidate.keys.auth &&
    candidate.keys.p256dh
  );
}
