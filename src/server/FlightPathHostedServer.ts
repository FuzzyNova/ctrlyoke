import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import * as path from "path";
import * as fs from "fs";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { WorkflowSummary, PromptStep } from "../types/FlightPathTypes";
import type { CliOutput } from "../types/WebviewMessageTypes";
import type { StepStatus, FinalStepPhase } from "../types/DashboardConstants";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import type { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { MESSAGE_TYPES } from "../types/DashboardConstants";

export class FlightPathHostedServer implements IDashboardProvider {
  private app = express();
  private httpServer: Server;
  private wss: WebSocketServer;
  private connections = new Set<WebSocket>();
  private cachedThemeVars: Record<string, string> = {};
  private nextConnectionId = 1;

  constructor(
    private hub: DashboardBroadcastHub,
    private webviewProvider: FlightPathWebviewProvider,
    private port: number
  ) {
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
    // postMessage. DashboardBroadcastHub.notifyActiveWorkflowChanged() already
    // routes only to clients[0] (VS Code) so this method should never be called,
    // but we guard here defensively.
  }

  async updateFileSelected(
    fileName: string,
    steps: any[],
    workflowName?: string,
    finalStep?: PromptStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    }
  ): Promise<void> {
    this.broadcast({
      type: MESSAGE_TYPES.FILE_SELECTED,
      fileName,
      steps,
      workflowName,
      finalStep,
      finalStepRuntime,
    });
  }

  async updateSessionRestored(
    fileName: string,
    steps: any[],
    results: any[],
    executionState: string,
    currentIndex: number,
    workflowName?: string,
    finalStep?: PromptStep | null,
    finalStepRuntime?: {
      status?: StepStatus;
      loopCount: number;
      phase: FinalStepPhase;
    }
  ): Promise<void> {
    this.broadcast({
      type: MESSAGE_TYPES.SESSION_RESTORED,
      fileName,
      steps,
      results,
      executionState,
      currentIndex,
      workflowName,
      finalStep,
      finalStepRuntime,
    });
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

  notifyRunHistoryUpdated(
    runCount: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ): void {
    this.broadcast({
      type: MESSAGE_TYPES.RUN_HISTORY_UPDATED,
      runCount,
      runTimestamps,
      runStates,
    });
  }

  // ── Theme var snapshot (fed from VS Code webview capture) ─────────────────

  updateThemeVars(vars: Record<string, string>): void {
    this.cachedThemeVars = vars;
    this.broadcast({ type: MESSAGE_TYPES.THEME_VARS_UPDATED, vars });
  }

  // ── HTTP routes ───────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const webviewDist = this.resolveWebviewDist();
    // Serve index.html through buildHtml so all placeholders are patched first.
    this.app.get(["/", "/index.html"], (_req, res) =>
      res.send(this.buildHtml(webviewDist))
    );
    // Serve static assets (disable automatic index.html fallback).
    this.app.use(express.static(webviewDist, { index: false }));
    this.app.get("/standalone-shim.js", (_req, res) =>
      res.sendFile(path.join(__dirname, "server", "standalone-shim.js"))
    );
    // SPA fallback: any unmatched route gets the patched index.html.
    this.app.use((_req, res) => res.send(this.buildHtml(webviewDist)));
  }

  private buildHtml(webviewDist: string): string {
    const indexPath = path.join(webviewDist, "index.html");
    let html = fs.readFileSync(indexPath, "utf8");

    // Replace VS Code URI placeholders with server-relative paths.
    // typo.js is only available via VS Code's URI scheme — omit for browser.
    html = html.replace(/<script\s+src="\{\{typoUri\}\}"><\/script>/g, "");
    html = html.replace(/\{\{codiconsUri\}\}/g, "/codicons/codicon.css");
    html = html.replace(/\{\{customIconsUri\}\}/g, "/custom-icons.css");
    html = html.replace(/\{\{logoUri\}\}/g, "");
    // Vite adds crossorigin to module scripts; remove it for same-origin serving.
    html = html.replace(
      /<script type="module" crossorigin/g,
      '<script type="module"'
    );

    // Add spell-checker dictionary paths as data attributes on <body>.
    html = html.replace(
      "<body>",
      `<body data-aff-uri="/dictionaries/en_US/en_US.aff" data-dic-uri="/dictionaries/en_US/en_US.dic" data-logo-uri="">`
    );

    // Replace the VS Code-specific CSP with a browser-compatible policy.
    // connect-src must explicitly allow the WebSocket endpoint.
    const csp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      "script-src 'self' 'unsafe-inline'",
      `connect-src 'self' ws://localhost:${this.port}`,
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

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private setupWebSocket(): void {
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      const clientTag = `browser:${this.nextConnectionId++}`;
      const send = (reply: unknown): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
      };
      this.sendInitialState(ws, clientTag);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.webviewProvider.routeExternalMessage(msg, send, clientTag);
        } catch (_e) {
          /* ignore malformed messages */
        }
      });
      ws.on("close", () => this.connections.delete(ws));
    });
  }

  private sendInitialState(ws: WebSocket, clientTag: string): void {
    const send = (msg: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    this.webviewProvider.routeExternalMessage(
      { type: MESSAGE_TYPES.READY },
      send,
      clientTag
    );
    // Push cached theme vars immediately so the client can style itself without waiting
    // for a CAPTURE_THEME_VARS round-trip.
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
    // Also request a fresh capture so any theme-change since last capture is picked up.
    this.webviewProvider.postMessage({
      type: MESSAGE_TYPES.CAPTURE_THEME_VARS,
    });
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(message);
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  listen(): string {
    this.httpServer.listen(this.port, "0.0.0.0");
    return `http://localhost:${this.port}`;
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
