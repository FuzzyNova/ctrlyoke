import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createHttpServer, Server } from "http";
import { createServer as createHttpsServer } from "https";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { WorkflowSummary, WorkflowStep } from "../types/FlightPathTypes";
import type {
  CliEvent,
  CliOutput,
  UndoExecutionTarget,
} from "../types/WebviewMessageTypes";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import type { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import {
  BROWSER_NOTIFICATION_MODES,
  HOSTED_ICON_FILES,
  HOSTED_ICON_PATHS,
  MESSAGE_TYPES,
  BROWSER_CLIENT_PREFIX,
  type FinalStepPhase,
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
import { Log } from "../utils/Log";
import { configService } from "../config/FlightPathConfigService";
import { createHostedHarnessStatusUpdate } from "./HostedServerMessageFactory";
import {
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
  type FlightPathNotificationEvent,
} from "../ui/notifications/CompletionNotificationFactory";
import { buildHostedServiceWorkerScript } from "./HostedServiceWorkerScript";
import {
  WebPushService,
  type WebPushSubscriptionPayload,
} from "./WebPushService";
import { pngIconService } from "./PngIconService";
import { HostedWorkspaceViewerService } from "./HostedWorkspaceViewerService";

export class FlightPathHostedServer
  implements IDashboardProvider, IDashboardSink
{
  private static readonly SOCKET_HEARTBEAT_INTERVAL_MS = 30000;

  private app = express();
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections = new Set<WebSocket>();
  private readonly socketLiveness = new WeakMap<WebSocket, boolean>();
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
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
    private webviewProvider: FlightPathWebviewProvider,
    private readonly getOrchestrator: () => WorkflowOrchestrator,
    private port: number,
    private workspaceRoot: string,
    private token: string,
    private bindAddress: string = "127.0.0.1",
    tlsConfig?: { certPath: string; keyPath: string }
  ) {
    this.sink = new PostMessageDashboardSink((msg) => this.broadcast(msg));
    this.webPushService = new WebPushService(workspaceRoot);
    this.viewerService = new HostedWorkspaceViewerService(workspaceRoot);
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
      Log.warn(`FlightPath server error: ${err.message}`);
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    // ws re-emits httpServer errors onto wss — add a handler to prevent crashes.
    this.wss.on("error", (err: Error) => {
      Log.warn(`FlightPath WebSocket server error: ${err.message}`);
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

  notifyHarnessAvailability(harnessId: string, available: boolean): void {
    this.broadcast(createHostedHarnessStatusUpdate(harnessId, available));
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

  notifyNotificationEvent(event: FlightPathNotificationEvent): void {
    void this.dispatchCompletionNotification(event);
  }

  // ── Theme var snapshot (fed from VS Code webview capture) ─────────────────

  updateThemeVars(vars: Record<string, string>): void {
    this.cachedThemeVars = vars;
    this.broadcast({ type: MESSAGE_TYPES.THEME_VARS_UPDATED, vars });
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
        .send(
          fs.readFileSync(
            path.join(__dirname, "server", "standalone-shim.js"),
            "utf8"
          )
        );
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
          'attachment; filename="flightpath.cer"'
        );
        res.send(cert);
      } catch {
        res.status(404).send("Certificate not found");
      }
    });
    this.app.get("/flightpath-service-worker.js", (_req, res) => {
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
    this.app.get("/api/workflow-files", requireToken, (_req, res) => {
      res.json({
        workspaceRoot: this.workspaceRoot,
        files: findWorkflowFilesInWorkspace(this.workspaceRoot),
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

    this.app.get(
      "/api/workspace-viewer/status",
      requireToken,
      async (_req, res) => {
        try {
          res.json(await this.viewerService.getStatus());
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
        const body = req.body as { message?: unknown };
        if (typeof body.message !== "string" || !body.message.trim()) {
          res.status(400).json({ error: "message is required" });
          return;
        }
        try {
          await this.viewerService.commit(body.message);
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
      async (_req, res) => {
        try {
          res.json(await this.viewerService.push());
        } catch (err) {
          Log.error(`workspace-viewer /push error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.post(
      "/api/workspace-viewer/pull",
      requireToken,
      async (_req, res) => {
        try {
          res.json(await this.viewerService.pull());
        } catch (err) {
          Log.error(`workspace-viewer /pull error: ${String(err)}`);
          res.status(500).json({ error: "Internal server error" });
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
    html = html.replace(/\{\{logoUri\}\}/g, "/flightpath-icon.svg");
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
      `<body class="${themeBodyClass}" data-aff-uri="/dictionaries/en_US/en_US.aff" data-dic-uri="/dictionaries/en_US/en_US.dic" data-logo-uri="/flightpath-icon.svg">`
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
    const { iconBgColor = ICON_BG_COLOR_DEFAULT, iconFgColor = ICON_FG_COLOR_DEFAULT } =
      configService.getAll().server;
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
      `<meta name="apple-mobile-web-app-title" content="FlightPath" />`,
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
      const { iconBgColor = ICON_BG_COLOR_DEFAULT, iconFgColor = ICON_FG_COLOR_DEFAULT } =
        configService.getAll().server;
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
      const { iconBgColor = ICON_BG_COLOR_DEFAULT, iconFgColor = ICON_FG_COLOR_DEFAULT } =
        configService.getAll().server;
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
    const headerToken = req.get("x-flightpath-token");
    if (headerToken === this.token) {
      return true;
    }
    return req.query["token"] === this.token;
  }

  private buildManifest(): Record<string, unknown> {
    const { iconBgColor = ICON_BG_COLOR_DEFAULT, iconFgColor = ICON_FG_COLOR_DEFAULT } =
      configService.getAll().server;
    const iconColorParam = `?bg=${iconBgColor.replace("#", "")}&fg=${iconFgColor.replace("#", "")}`;
    return {
      name: "FlightPath",
      short_name: "FlightPath",
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
    event: FlightPathNotificationEvent | undefined
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
      this.connections.add(ws);
      this.socketLiveness.set(ws, true);
      const clientTag = `${BROWSER_CLIENT_PREFIX}${this.nextConnectionId++}`;
      let sawReady = false;
      const connectedAt = Date.now();
      Log.debug(
        `[hosted-server] WebSocket connected clientId=${clientTag} ip=${req.socket.remoteAddress ?? ""} ua=${req.headers["user-agent"] ?? ""} origin=${req.headers.origin ?? ""}`
      );
      const send = (reply: unknown): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      };
      this.sendInitialState(ws);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
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
      });
      ws.on("close", (code, reason) => {
        Log.debug(
          `[hosted-server] WebSocket closed clientId=${clientTag} ready=${sawReady} lifetimeMs=${Date.now() - connectedAt} code=${code} reason=${reason.toString()}`
        );
        this.connections.delete(ws);
        this.socketLiveness.delete(ws);
        this.webviewProvider.unregisterBrowserClient(clientTag);
      });
      ws.on("error", (error) => {
        Log.warn(
          `[hosted-server] WebSocket error clientId=${clientTag}: ${error}`
        );
      });
    });
  }

  private setupHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.connections) {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        const isAlive = this.socketLiveness.get(ws);
        if (isAlive === false) {
          try {
            ws.terminate();
          } catch {
            // Best-effort cleanup. close/error handlers own the rest.
          }
          continue;
        }

        this.socketLiveness.set(ws, false);
        try {
          ws.ping();
        } catch {
          try {
            ws.terminate();
          } catch {
            // Best-effort cleanup. close/error handlers own the rest.
          }
        }
      }
    }, FlightPathHostedServer.SOCKET_HEARTBEAT_INTERVAL_MS);
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
