import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
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
  MESSAGE_TYPES,
  BROWSER_CLIENT_PREFIX,
  type FinalStepPhase,
  type StepStatus,
  type StatusMessageSeverity,
} from "../types/DashboardConstants";
import type { WorkspaceSnapshot } from "../types/OutputHistoryTypes";
import { PostMessageDashboardSink } from "../ui/PostMessageDashboardSink";
import { findWorkflowFilesInWorkspace } from "../utils/WorkflowFileDiscovery";
import { Log } from "../utils/Log";

export class FlightPathHostedServer
  implements IDashboardProvider, IDashboardSink
{
  private app = express();
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections = new Set<WebSocket>();
  private cachedThemeVars: Record<string, string> = {};
  private nextConnectionId = 1;
  private readonly sink: PostMessageDashboardSink;

  constructor(
    private hub: DashboardBroadcastHub,
    private webviewProvider: FlightPathWebviewProvider,
    private port: number,
    private workspaceRoot: string,
    private token: string,
    private bindAddress: string = "127.0.0.1"
  ) {
    this.sink = new PostMessageDashboardSink((msg) => this.broadcast(msg));
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.setupRoutes();
    this.setupWebSocket();
    hub.addClient(this);
  }

  // ── IDashboardProvider — broadcast all orchestrator events ────────────────

  postMessage(message: unknown): void {
    this.broadcast(message);
  }

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_ADDED, summary });
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_DISMISSED, workflowId });
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    this.broadcast({ type: MESSAGE_TYPES.WORKFLOW_SUMMARY_UPDATED, summary });
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
    this.broadcast({
      type: MESSAGE_TYPES.HARNESS_STATUS_UPDATE,
      harnessId,
      available,
    });
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
    workflowId?: string
  ): Promise<void> {
    return this.sink.updateFileSelected(
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
      workflowId
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
    workflowId?: string
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
      workflowId
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
    workflowId?: string
  ): void {
    this.sink.updateCliStreamingEvents(stepIndex, events, workflowId);
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
    workflowId?: string
  ): void {
    this.sink.updateFinalStepStreamingEvents(loopIndex, events, workflowId);
  }
  notifyWorkflowStateReset(steps: any[], workflowId?: string): void {
    this.sink.notifyWorkflowStateReset(steps, workflowId);
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

  // ── Theme var snapshot (fed from VS Code webview capture) ─────────────────

  updateThemeVars(vars: Record<string, string>): void {
    this.cachedThemeVars = vars;
    this.broadcast({ type: MESSAGE_TYPES.THEME_VARS_UPDATED, vars });
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const webviewDist = this.resolveWebviewDist();
    this.app.use((req, res, next) => {
      if (req.query["token"] === this.token) return next();
      res.status(401).send("Unauthorized");
    });
    // Serve index.html through buildHtml so all placeholders are patched first.
    this.app.get(["/", "/index.html"], (req, res) => {
      this.setNoStore(res);
      res.send(this.buildHtml(webviewDist, req.get("host")));
    });
    this.app.get("/standalone-shim.js", (_req, res) => {
      this.setNoStore(res);
      res.sendFile(path.join(__dirname, "server", "standalone-shim.js"));
    });
    // Serve static assets (disable automatic index.html fallback).
    this.app.use(express.static(webviewDist, { index: false }));
    this.app.get("/api/workflow-files", (_req, res) => {
      res.json({
        workspaceRoot: this.workspaceRoot,
        files: findWorkflowFilesInWorkspace(this.workspaceRoot),
      });
    });
    // SPA fallback: any unmatched route gets the patched index.html.
    this.app.use((req, res) => {
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
    html = html.replace(
      "<body>",
      `<body data-aff-uri="/dictionaries/en_US/en_US.aff" data-dic-uri="/dictionaries/en_US/en_US.dic" data-logo-uri="/flightpath-icon.svg">`
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
      `ws://[::1]:${this.port}`,
    ];
    const connectSources = Array.from(new Set(["'self'", ...websocketSources]));
    const csp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "script-src 'self' 'unsafe-inline'",
      `connect-src ${connectSources.join(" ")}`,
    ].join("; ");
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
    );

    // Inject theme vars and standalone shim before </head>.
    const themeBlock = this.buildThemeStyleBlock();
    return html.replace(
      "</head>",
      `${themeBlock}<script src="/standalone-shim.js"></script></head>`
    );
  }

  private buildThemeStyleBlock(): string {
    const vars = Object.entries(this.cachedThemeVars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return vars ? `<style>:root {\n${vars}\n}</style>\n` : "";
  }

  private isSafeRequestHost(host: string): boolean {
    return /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(host);
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
      ws.on("close", (code, reason) => {
        Log.debug(
          `[hosted-server] WebSocket closed clientId=${clientTag} ready=${sawReady} lifetimeMs=${Date.now() - connectedAt} code=${code} reason=${reason.toString()}`
        );
        this.connections.delete(ws);
        this.webviewProvider.unregisterBrowserClient(clientTag);
      });
      ws.on("error", (error) => {
        Log.warn(
          `[hosted-server] WebSocket error clientId=${clientTag}: ${error}`
        );
      });
    });
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

  listen(): string {
    this.httpServer.listen(this.port, this.bindAddress);
    const host =
      this.bindAddress === "0.0.0.0" ? this.getLanIp() : "localhost";
    return `http://${host}:${this.port}/?token=${this.token}`;
  }

  private getLanIp(): string {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "localhost";
  }

  dispose(): void {
    this.hub.removeClient(this);
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
