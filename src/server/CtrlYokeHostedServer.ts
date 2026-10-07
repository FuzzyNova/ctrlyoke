import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  createServer as createHttpServer,
  request as httpRequest,
  Server,
} from "http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "https";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { DashboardClientEndpoint } from "../ui/DashboardClientEndpoint";
import type { IDashboardProvider } from "../ui/IDashboardProvider";
import type { IDashboardSink } from "../types/IDashboardSink";
import type { HarnessUsageSnapshot } from "../types/UsageTypes";
import type {
  WorkflowViewAddress,
  ParallelGroupDefinition,
  WorktreeRunProjection,
  RunnerHostIdentity,
  CoordinationScopeSnapshot,
} from "../types/CtrlYokeTypes";
import type { WorkflowSummary, WorkflowStep } from "../types/CtrlYokeTypes";
import type {
  CliEvent,
  CliOutput,
  BindAddressFallbackInfo,
  ServerPortFallbackInfo,
  UndoExecutionTarget,
  UserFeedbackMessage,
} from "../types/WebviewMessageTypes";
import { DashboardBroadcastHub } from "../ui/DashboardBroadcastHub";
import {
  BROWSER_NOTIFICATION_MODES,
  LICENSE_UI,
  HOSTED_ICON_FILES,
  HOSTED_ICON_PATHS,
  HOSTED_CERT_DOWNLOAD,
  HOSTED_CONNECTION_LIVENESS,
  MESSAGE_TYPES,
  BROWSER_CLIENT_PREFIX,
  type FinalStepPhase,
  type ExecutionPhase,
  type HarnessId,
  type ExecutionMode,
  type StepStatus,
  type StatusMessageSeverity,
  BOOLEAN_STRING_VALUES,
  WORKSPACE_SEARCH_SCOPES,
  NETWORK_INTERFACE_FAMILIES,
  THEME_KINDS,
  SERVER_THEME_MODES,
  type HostKind,
  type ServerThemeMode,
} from "../types/DashboardConstants";
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
import { projectKey } from "../utils/ProjectStatePaths";
import { colorizeSvg, resolveHostedIconColors } from "./IconColorizer";
import {
  WebPushService,
  PushAccessDeniedError,
  type WebPushSubscriptionPayload,
} from "./WebPushService";
import { pngIconService } from "./PngIconService";
import {
  HostedWorkspaceViewerService,
  MAX_FILE_SIZE,
  RedactionMarkerSaveError,
} from "./HostedWorkspaceViewerService";
import { parseWorkspaceTreeQuery } from "./WorkspaceTreeRoute";
import { WorkspaceTreeHttpError } from "./WorkspaceTreeErrors";
import type {
  WorkspaceDeleteRequest,
  WorkspaceCopyRequest,
  WorkspaceMoveRequest,
  WorkspaceGenerateCommitMessageResponse,
  WorkspaceFileHistoryDiffResponse,
  WorkspaceGitRefDiffPageResponse,
  WorkspaceGitRefDiffResponse,
  WorkspaceSearchScope,
} from "../types/HostedWorkspaceViewerTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { secretRedactionService } from "../utils/SecretRedactionService";
import { installSecretRedactionMiddleware } from "./SecretRedactionMiddleware";
import { buildHostedErrorPage } from "./HostedErrorPageTemplate";
import type { HostedThemeDefaults } from "./HostedThemeDefaults";
import { IS_DEV_MODE } from "../utils/BuildConfig";
import {
  bytesToMb,
  noteMemoryActivity,
  registerMemoryContext,
} from "../utils/MemoryDiagnostics";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { isLoopbackBindAddress } from "../utils/NetworkUtils";
import type { HarnessAvailabilityReport } from "../types/WebviewMessageTypes";

const THEME_VAR_KEY_PATTERN = /^--[A-Za-z0-9_-]+$/;
const SIBLING_SERVER_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_JSON_BODY_LIMIT = "64kb";
// SAVE_PASTED_IMAGE allows 15 MiB of decoded image data. Its base64 JSON
// message is about 20 MiB; 24 MiB leaves room for the message envelope while
// bounding inbound WebSocket buffering well below ws's 100 MiB default.
const HOSTED_WEBSOCKET_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const JSON_STRING_MAX_BYTE_EXPANSION_FACTOR = 6;
const WORKSPACE_FILE_JSON_METADATA_HEADROOM_BYTES = 4 * 1024;
const WORKSPACE_FILE_JSON_BODY_LIMIT_BYTES =
  MAX_FILE_SIZE * JSON_STRING_MAX_BYTE_EXPANSION_FACTOR +
  WORKSPACE_FILE_JSON_METADATA_HEADROOM_BYTES;
const WORKSPACE_FILE_ROUTE_PATH = "/api/workspace-viewer/file";
const SERVER_IDENTITY_ROUTE_PATH = "/api/server-identity";

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "<":
        return "&lt;";
      default:
        return "&gt;";
    }
  });
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function createServerIdentityProof(
  token: string,
  nonce: string,
  workspaceRoot: string
): string {
  return createHmac("sha256", token)
    .update(`${nonce}\n${normalizeWorkspaceRoot(workspaceRoot)}`)
    .digest("hex");
}

function timingSafeStringEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function maskHostedServerUrlToken(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/i, "$1…");
}

function redactHostedTransportMessage(message: unknown): unknown {
  return secretRedactionService.redactValue(message);
}

/** Hosted sends at least this large are noted for the memory watchdog. */
const LARGE_HOSTED_SEND_BYTES = 1024 * 1024;

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

export interface HostedServerOptions {
  hub: DashboardBroadcastHub;
  endpoint: DashboardClientEndpoint;
  getOrchestrator: () => WorkflowOrchestrator;
  port: number;
  fallbackPorts: number[];
  bindAddress: string;
  tls?: { certPath: string; keyPath: string };
  workspaceRoot: string;
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
  token: string;
  remoteAccess: {
    isAllowed: () => Promise<boolean>;
    onBlocked: () => void;
  };
  runnerHostIdentity?: RunnerHostIdentity;
  onSiblingServerDetected?: (url: string) => void;
  hostKind: HostKind;
  themeDefaults: HostedThemeDefaults;
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
  private readonly unregisterMemoryContext: () => void;
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
  private requestedPort?: number;
  private portFellBack = false;
  private bindAddressFallback?: BindAddressFallbackInfo;
  private devServerUrlFileOwned = false;
  private readonly viewerService: HostedWorkspaceViewerService;
  private readonly getRemoteAccess: (() => Promise<boolean>) | undefined;
  private readonly onRemoteAccessBlocked: (() => void) | undefined;
  private remoteAccessUpsellShown = false;
  private readonly hub: DashboardBroadcastHub;
  private readonly dashboardClient: DashboardClientEndpoint;
  private readonly getOrchestrator: () => WorkflowOrchestrator;
  private port: number;
  private readonly workspaceRoot: string;
  private readonly workspaceKey: string;
  private readonly token: string;
  private bindAddress: string;
  private readonly fallbackPorts: number[];
  private readonly onSiblingServerDetected?: (url: string) => void;
  private readonly hostKind: HostKind;
  private readonly themeDefaults: HostedThemeDefaults;

  constructor(options: HostedServerOptions) {
    const {
      hub,
      endpoint,
      getOrchestrator,
      port,
      fallbackPorts,
      bindAddress,
      tls,
      workspaceRoot,
      namedWorkspaceRoots,
      token,
      remoteAccess,
      runnerHostIdentity,
      onSiblingServerDetected,
      hostKind,
      themeDefaults,
    } = options;
    this.hub = hub;
    this.dashboardClient = endpoint;
    this.getOrchestrator = getOrchestrator;
    this.port = port;
    this.fallbackPorts = fallbackPorts;
    this.bindAddress = bindAddress;
    this.workspaceRoot = workspaceRoot;
    this.workspaceKey = projectKey(workspaceRoot);
    this.token = token;
    this.onSiblingServerDetected = onSiblingServerDetected;
    this.hostKind = hostKind;
    this.themeDefaults = themeDefaults;
    this.getRemoteAccess = remoteAccess.isAllowed;
    this.onRemoteAccessBlocked = remoteAccess.onBlocked;
    this.sink = new PostMessageDashboardSink((msg) => this.broadcast(msg));
    this.webPushService = new WebPushService(undefined, {
      hasRemoteAccess: () => this.resolveRemoteAccess(),
      onAccessBlocked: () => this.notifyRemoteAccessBlocked(),
    });
    this.viewerService = new HostedWorkspaceViewerService(
      workspaceRoot,
      namedWorkspaceRoots,
      runnerHostIdentity
    );
    if (tls) {
      const cert = fs.readFileSync(tls.certPath);
      const key = fs.readFileSync(tls.keyPath);
      this.httpServer = createHttpsServer({ cert, key }, this.app);
      this.isTls = true;
      this.tlsCertPath = tls.certPath;
    } else {
      this.httpServer = createHttpServer(this.app);
      this.isTls = false;
    }
    // Prevent unhandled 'error' crashes before listen() registers its handler.
    // listen() adds its own once-handler on top of this permanent fallback.
    this.httpServer.on("error", (err: NodeJS.ErrnoException) => {
      Log.warn(`[CtrlYokeHostedServer] ctrlyoke server error: ${err.message}`);
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: HOSTED_WEBSOCKET_MAX_PAYLOAD_BYTES,
    });
    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!timingSafeStringEqual(url.searchParams.get("token"), this.token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    // ws server errors are handled to prevent unhandled error crashes.
    this.wss.on("error", (err: Error) => {
      Log.warn(
        `[CtrlYokeHostedServer] ctrlyoke WebSocket server error: ${err.message}`
      );
    });
    const defaultJsonParser = express.json({ limit: DEFAULT_JSON_BODY_LIMIT });
    const workspaceFileJsonParser = express.json({
      limit: WORKSPACE_FILE_JSON_BODY_LIMIT_BYTES,
    });
    this.app.use((req, res, next) => {
      // Skip parsing until the route's normal auth middleware can reject an
      // unauthenticated request. Public endpoints do not consume JSON bodies.
      if (!this.requestHasValidToken(req)) {
        next();
        return;
      }
      const parser =
        req.method === "PUT" && req.path === WORKSPACE_FILE_ROUTE_PATH
          ? workspaceFileJsonParser
          : defaultJsonParser;
      parser(req, res, next);
    });
    installSecretRedactionMiddleware(this.app);
    this.setupRoutes();
    this.setupWebSocket();
    this.unregisterMemoryContext = registerMemoryContext("hosted", () =>
      this.hostedMemoryContext()
    );
    this.setupHeartbeat();
    hub.addClient(this);
  }

  // ── IDashboardProvider — broadcast all orchestrator events ────────────────

  postMessage(message: unknown): void {
    // STARTUP_COMPLETE from DashboardBroadcastHub.notifyStartupComplete() fires
    // the instant the PANEL's own auto-load settles, with no regard for whether
    // any given browser client's READY has made it through the extension's
    // serialized routeQueue yet. Forwarding it here races ahead of that
    // client's own replay (SESSION_RESTORED/WORKFLOWS_LIST) — useMessageHandler's
    // STARTUP_COMPLETE handler then sees no fileName/activeWorkflowWorkingFilePath
    // and creates a blank workflow. Every browser client already gets its own
    // correctly-sequenced STARTUP_COMPLETE from WebviewMessageRouter's
    // completeBrowserReadyAfterStartup() once ITS replay finishes, so the
    // broadcast copy is both redundant and unsafe for browser sockets — drop it.
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === MESSAGE_TYPES.STARTUP_COMPLETE
    ) {
      return;
    }
    this.broadcast(message);
  }

  /**
   * Delivers operational feedback to browser sockets only.
   * The VS Code panel uses the separate DashboardBroadcastHub path and is not
   * part of this connection set, so it cannot receive an in-app duplicate.
   */
  broadcastUserFeedback(message: UserFeedbackMessage): void {
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

  notifyCoordinationScopeUpdated(scope: CoordinationScopeSnapshot): void {
    this.broadcast({ type: MESSAGE_TYPES.COORDINATION_SCOPE_UPDATED, scope });
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

  notifyCliPromptsExtended(
    workflowId: string,
    steps: any[],
    definitionRevision?: number,
    parallelGroups?: ParallelGroupDefinition[]
  ): void {
    this.broadcast({
      type: MESSAGE_TYPES.STEPS_EXTENDED,
      workflowId,
      steps,
      ...(definitionRevision !== undefined ? { definitionRevision } : {}),
      ...(parallelGroups !== undefined ? { parallelGroups } : {}),
    });
  }

  notifyHarnessAvailability(
    harnessId: HarnessId,
    report: HarnessAvailabilityReport
  ): void {
    this.broadcast(createHostedHarnessStatusUpdate(harnessId, report));
    void this.publishHarnessCapabilitySnapshot(harnessId);
  }

  /** Broadcast the same registry snapshot used by the VS Code panel. */
  private async publishHarnessCapabilitySnapshot(
    harnessId?: HarnessId
  ): Promise<void> {
    try {
      const registry = this.getOrchestrator().getCompatibilityRegistry();
      if (harnessId) {
        await registry.refresh(harnessId);
      }
      this.broadcast({
        type: MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT,
        data: { snapshot: await registry.getSnapshot() },
      });
    } catch (error) {
      Log.warn(
        "[CtrlYokeHostedServer] Failed to publish hosted harness capability snapshot:",
        error
      );
    }
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
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: import("../types/CtrlYokeTypes").ParallelGroupDefinition[],
    activeStepIndices?: number[],
    schemaWarnings?: import("../types/CtrlYokeTypes").WorkflowValidationWarning[]
  ): Promise<void> {
    return this.sink.updateFileSelected(
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
    workflowProperties?: Record<string, unknown>,
    parallelGroups?: ParallelGroupDefinition[],
    activeStepIndices?: number[],
    definitionRevision?: number,
    schemaWarnings?: import("../types/CtrlYokeTypes").WorkflowValidationWarning[]
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
      workflowProperties,
      parallelGroups,
      activeStepIndices,
      definitionRevision,
      schemaWarnings
    );
  }
  updateExecutionStarted(
    workflowId: string,
    fileName: string,
    totalSteps: number,
    isContinuation?: boolean,
    preserveStepCount?: number,
    isInjectMode?: boolean,
    executionMode?: ExecutionMode
  ): void {
    this.sink.updateExecutionStarted(
      workflowId,
      fileName,
      totalSteps,
      isContinuation,
      preserveStepCount,
      isInjectMode,
      executionMode
    );
  }
  updateProgress(current: number, total: number, workflowId?: string): void {
    this.sink.updateProgress(current, total, workflowId);
  }
  public updateExecutionState(
    state: string,
    workflowId?: string,
    activeStepIndices?: number[]
  ): void {
    this.sink.updateExecutionState(state, workflowId, activeStepIndices);
  }
  public updateActiveStepIndices(
    activeStepIndices: number[],
    workflowId?: string
  ): void {
    this.sink.updateActiveStepIndices?.(activeStepIndices, workflowId);
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
  updateCliStreamingEvents(
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
  updateStepsExtended(
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
  updateStepColor(
    indices: number[],
    color: string | null,
    definitionRevision?: number,
    workflowId?: string
  ): void {
    this.sink.updateStepColor(indices, color, definitionRevision, workflowId);
  }
  updatePromptDeleted(
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
  updateFinalStep(
    finalStep: WorkflowStep | null,
    workflowId?: string,
    definitionRevision?: number
  ): void {
    this.sink.updateFinalStep(finalStep, workflowId, definitionRevision);
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
  updateFinalStepStreamingEvents(
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
  async sendTestNotification(): Promise<void> {
    await this.dispatchCompletionNotification(
      buildTestNotificationEvent(this.publicUrl)
    );
  }

  notifyPromptsReordered(
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
  notifyUndoRedoSynced(): void {
    this.sink.notifyUndoRedoSynced();
  }
  updateWorkflowName(
    name: string,
    workflowId?: string,
    definitionRevision?: number
  ): void {
    this.sink.updateWorkflowName(name, workflowId, definitionRevision);
  }
  sendStepUndoDataUpdated(
    target: UndoExecutionTarget,
    workspaceSnapshot?: WorkspaceSnapshot,
    workflowId?: string
  ): void {
    this.sink.sendStepUndoDataUpdated(target, workspaceSnapshot, workflowId);
  }

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    void this.dispatchCompletionNotification(event);
  }

  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void {
    this.sink.updateHarnessUsage(snapshots);
  }

  updateWorktreeMerge(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    worktree: WorktreeRunProjection
  ): void {
    this.sink.updateWorktreeMerge(address, worktree);
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
    this.app.get(SERVER_IDENTITY_ROUTE_PATH, (req, res) => {
      const nonce = req.query["nonce"];
      if (typeof nonce !== "string" || nonce.length > 128) {
        res.status(400).json({ error: "nonce is required" });
        return;
      }
      res.json({
        proof: createServerIdentityProof(this.token, nonce, this.workspaceRoot),
      });
    });
    // Serve static assets (CSS/JS/fonts) without token — they are not sensitive and
    // the browser fetches them without query params after loading the entry HTML.
    this.app.get("/standalone-shim.js", (_req, res) => {
      this.setNoStore(res);
      res.locals.skipSecretRedaction = true;
      res
        .type("application/javascript")
        .send(buildHostedStandaloneShimScript(this.workspaceKey));
    });
    // Cert download — no token required so iOS users can fetch and install it
    // before the WebSocket handshake can succeed. The cert is a public key only.
    this.app.get(HOSTED_CERT_DOWNLOAD.PATH, (_req, res) => {
      if (!this.tlsCertPath) {
        this.sendNotFoundPage(
          res,
          "This ctrlyoke server isn't running with TLS enabled, so there's no certificate to download.",
          [
            "Enable TLS in your ctrlyoke server settings, or connect using the non-HTTPS link instead.",
          ],
          this.getThemeOverride(_req)
        );
        return;
      }
      try {
        const cert = fs.readFileSync(this.tlsCertPath);
        this.setNoStore(res);
        res.setHeader("Content-Type", HOSTED_CERT_DOWNLOAD.CONTENT_TYPE);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${HOSTED_CERT_DOWNLOAD.FILENAME}"`
        );
        res.send(cert);
      } catch {
        this.sendNotFoundPage(
          res,
          "The ctrlyoke TLS certificate could not be read from disk.",
          undefined,
          this.getThemeOverride(_req)
        );
      }
    });
    this.app.get("/ctrlyoke-service-worker.js", (_req, res) => {
      this.setNoStore(res);
      res.locals.skipSecretRedaction = true;
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
    // Token is required for the HTML entry point and all API routes.
    const requireToken: express.RequestHandler = (req, res, next) => {
      if (this.requestHasValidToken(req)) return next();
      res.status(401).send("Unauthorized");
    };
    // Same check, but for browser-navigated page routes (entry HTML, SPA fallback)
    // rather than JSON API routes — these get the themed landing page instead of a
    // bare "Unauthorized" string, since a human is looking at this in a browser tab.
    const requireTokenForPage: express.RequestHandler = (req, res, next) => {
      if (this.requestHasValidToken(req)) return next();
      this.sendUnauthorizedPage(res, this.getThemeOverride(req));
    };
    this.app.get("/manifest.webmanifest", requireToken, (_req, res) => {
      this.setNoStore(res);
      res.locals.skipSecretRedaction = true;
      res
        .type("application/manifest+json")
        .send(JSON.stringify(this.buildManifest()));
    });
    this.app.get(
      "/api/notifications/vapid-public-key",
      requireToken,
      async (_req, res) => {
        try {
          res.json({ publicKey: await this.webPushService.getPublicKey() });
        } catch (error) {
          if (!this.sendPushAccessError(res, error)) throw error;
        }
      }
    );
    this.app.get(
      "/api/notifications/subscriptions",
      requireToken,
      async (_req, res) => {
        try {
          res.json(await this.webPushService.listSubscriptions());
        } catch (error) {
          if (!this.sendPushAccessError(res, error)) throw error;
        }
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
        try {
          const subscription = await this.webPushService.upsertSubscription(
            body.subscription,
            {
              userAgent: req.get("user-agent") ?? undefined,
              label: body.label,
            }
          );
          res.status(201).json({ id: subscription.id });
        } catch (error) {
          if (!this.sendPushAccessError(res, error)) throw error;
        }
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
    this.app.get(["/", "/index.html"], requireTokenForPage, (req, res) => {
      this.setNoStore(res);
      res.locals.skipSecretRedaction = true;
      res.send(
        this.buildHtml(webviewDist, req.get("host"), this.getThemeOverride(req))
      );
    });
    // Register static files after the explicit HTML entry route so /index.html
    // receives the same token check and hosted-page patching as /.
    const isWindows = process.platform === "win32";
    const protectedStaticPaths = new Set(
      [
        path.resolve(webviewDist, "index.html"),
        path.resolve(webviewDist, "favicon.svg"),
      ].map((protectedPath) =>
        isWindows ? protectedPath.toLowerCase() : protectedPath
      )
    );
    this.app.use(
      (req, res, next) => {
        let decodedPath = req.path;
        try {
          while (true) {
            const nextPath = decodeURIComponent(decodedPath);
            if (nextPath === decodedPath) break;
            decodedPath = nextPath;
          }
        } catch {
          return next();
        }
        // express.static resolves the decoded request path with the platform
        // path implementation. Mirror that resolution here so separators and
        // dot segments cannot make a protected file look like another path.
        const resolvedPath = path.resolve(webviewDist, `.${decodedPath}`);
        const comparisonPath = isWindows
          ? resolvedPath.toLowerCase()
          : resolvedPath;
        const protectsResolvedPath = protectedStaticPaths.has(comparisonPath);
        const resolvedDirectory = path.dirname(resolvedPath);
        const comparisonDirectory = isWindows
          ? resolvedDirectory.toLowerCase()
          : resolvedDirectory;
        const comparisonWebviewDist = isWindows
          ? webviewDist.toLowerCase()
          : webviewDist;
        const isWebviewRootFile = comparisonDirectory === comparisonWebviewDist;
        const staticPath = path.basename(resolvedPath).toLowerCase();
        const isProtectedHtmlPath =
          isWebviewRootFile &&
          /^index(?:~\d+)?\.html?(?::.*)?$/.test(staticPath);
        const isProtectedFaviconPath =
          isWebviewRootFile &&
          /^(?:favicon|favico~\d+)\.svg(?::.*)?$/.test(staticPath);
        if (
          protectsResolvedPath ||
          isProtectedHtmlPath ||
          isProtectedFaviconPath
        ) {
          return res.sendStatus(404);
        }
        return next();
      },
      express.static(webviewDist, { index: false })
    );
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
        try {
          const request = parseWorkspaceTreeQuery(
            req.query as Record<string, unknown>
          );
          res.json(await this.viewerService.listDirectory(request));
        } catch (err) {
          if (err instanceof WorkspaceTreeHttpError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /tree error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/search",
      requireToken,
      async (req, res) => {
        const query =
          typeof req.query.query === "string" ? req.query.query.trim() : "";
        if (query.length < 2) {
          res
            .status(400)
            .json({ error: "query must be at least 2 characters" });
          return;
        }

        const rawScope =
          typeof req.query.scope === "string" ? req.query.scope : "";
        const scope: WorkspaceSearchScope =
          rawScope === WORKSPACE_SEARCH_SCOPES.FILES ||
          rawScope === WORKSPACE_SEARCH_SCOPES.CONTENT ||
          rawScope === WORKSPACE_SEARCH_SCOPES.BOTH
            ? rawScope
            : WORKSPACE_SEARCH_SCOPES.BOTH;
        const includeGitIgnored =
          req.query.includeGitIgnored === BOOLEAN_STRING_VALUES.TRUE;
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        const rawLimit =
          typeof req.query.limit === "string"
            ? Number.parseInt(req.query.limit, 10)
            : NaN;
        const limit =
          Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

        try {
          res.json(
            await this.viewerService.searchWorkspace({
              query,
              scope,
              includeGitIgnored,
              repo,
              limit,
            })
          );
        } catch (err) {
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /search error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(WORKSPACE_FILE_ROUTE_PATH, requireToken, async (req, res) => {
      const filePath = typeof req.query.path === "string" ? req.query.path : "";
      if (!filePath) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      try {
        const file = await this.viewerService.readFile(filePath);
        res.locals.skipSecretRedaction = true;
        res.json(file);
      } catch (err) {
        Log.error(
          `[CtrlYokeHostedServer] workspace-viewer GET /file error: ${String(err)}`
        );
        res.status(500).json({ error: "Internal server error" });
      }
    });

    this.app.put(WORKSPACE_FILE_ROUTE_PATH, requireToken, async (req, res) => {
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
        } else if (err instanceof RedactionMarkerSaveError) {
          res.status(400).json({ error: message });
        } else {
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer PUT /file error: ${message}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    this.app.delete(
      "/api/workspace-viewer/entry",
      requireToken,
      async (req, res) => {
        if (typeof req.query["path"] !== "string" || req.query["path"] === "") {
          res.status(400).json({ error: "path is required" });
          return;
        }
        const deleteRequest: WorkspaceDeleteRequest = {
          path: req.query["path"],
        };
        try {
          await this.viewerService.deleteEntry(deleteRequest.path);
          res.status(204).send();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          Log.warn(
            `[CtrlYokeHostedServer] workspace-viewer DELETE /entry error: ${message}`
          );
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
          Log.warn(
            `[CtrlYokeHostedServer] workspace-viewer POST /copy error: ${message}`
          );
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
          body.sourcePath === "" ||
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
          Log.warn(
            `[CtrlYokeHostedServer] workspace-viewer POST /move error: ${message}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /repos error: ${String(err)}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /status error: ${String(err)}`
          );
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
            Log.error(
              `[CtrlYokeHostedServer] workspace-viewer /diff error: ${message}`
            );
            res.status(500).json({ error: "Internal server error" });
          }
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/file-history",
      requireToken,
      async (req, res) => {
        const filePath =
          typeof req.query.path === "string" ? req.query.path : "";
        if (!filePath) {
          res.status(400).json({ error: "path is required" });
          return;
        }
        const rawOffset =
          typeof req.query.offset === "string" ? req.query.offset : "0";
        const rawPageSize =
          typeof req.query.pageSize === "string"
            ? req.query.pageSize
            : undefined;
        const offset = Number.parseInt(rawOffset, 10);
        const pageSize =
          rawPageSize === undefined
            ? undefined
            : Number.parseInt(rawPageSize, 10);
        const historyId =
          typeof req.query.historyId === "string" && req.query.historyId
            ? req.query.historyId
            : undefined;
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          res.json(
            await this.viewerService.getFileHistory(
              filePath,
              offset,
              pageSize,
              historyId,
              repo
            )
          );
        } catch (err) {
          if (err instanceof WorkspaceTreeHttpError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          if (err instanceof Error && err.message === "Path not allowed") {
            res.status(403).json({ error: err.message });
            return;
          }
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /file-history error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/file-history-diff",
      requireToken,
      async (req, res) => {
        const filePath =
          typeof req.query.path === "string" ? req.query.path : "";
        if (!filePath) {
          res.status(400).json({ error: "path is required" });
          return;
        }
        const commit =
          typeof req.query.commit === "string" ? req.query.commit : "";
        if (!commit) {
          res.status(400).json({ error: "commit is required" });
          return;
        }
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          const result = await this.viewerService.getFileHistoryDiff(
            filePath,
            commit,
            repo
          );
          res.json(result satisfies WorkspaceFileHistoryDiffResponse);
        } catch (err) {
          if (err instanceof WorkspaceTreeHttpError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          if (err instanceof Error && err.message === "Path not allowed") {
            res.status(403).json({ error: err.message });
            return;
          }
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /file-history-diff error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
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
            Log.error(
              `[CtrlYokeHostedServer] workspace-viewer /stage error: ${message}`
            );
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
            Log.error(
              `[CtrlYokeHostedServer] workspace-viewer /unstage error: ${message}`
            );
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
            Log.error(
              `[CtrlYokeHostedServer] workspace-viewer /discard error: ${message}`
            );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /commit error: ${String(err)}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /push error: ${String(err)}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /pull error: ${String(err)}`
          );
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
            `[CtrlYokeHostedServer] workspace-viewer /generate-commit-message error: ${message}`
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
        const historyId =
          typeof req.query.historyId === "string" && req.query.historyId
            ? req.query.historyId
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
              repo,
              historyId
            )
          );
        } catch (err) {
          if (err instanceof WorkspaceTreeHttpError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /commit-log error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/git-ref-diff-page",
      requireToken,
      async (req, res) => {
        const ref = req.query.ref;
        if (typeof ref !== "string" || !ref) {
          res.status(400).json({ error: "ref is required" });
          return;
        }
        const rawOffset =
          typeof req.query.offset === "string" ? req.query.offset : "0";
        const rawPageSize =
          typeof req.query.pageSize === "string"
            ? req.query.pageSize
            : undefined;
        const offset = Number.parseInt(rawOffset, 10);
        const pageSize =
          rawPageSize === undefined
            ? undefined
            : Number.parseInt(rawPageSize, 10);
        const diffId =
          typeof req.query.diffId === "string" && req.query.diffId
            ? req.query.diffId
            : undefined;
        const repo =
          typeof req.query.repo === "string" && req.query.repo.trim()
            ? req.query.repo.trim()
            : undefined;
        try {
          res.json(
            (await this.viewerService.getGitRefDiffPage(
              ref,
              offset,
              pageSize,
              diffId,
              repo
            )) satisfies WorkspaceGitRefDiffPageResponse
          );
        } catch (err) {
          if (err instanceof WorkspaceTreeHttpError) {
            res.status(err.statusCode).json({ error: err.message });
            return;
          }
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /git-ref-diff-page error: ${String(err)}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /git-ref-diff error: ${String(err)}`
          );
          res.status(500).json({ error: "Internal server error" });
        }
      }
    );

    this.app.get(
      "/api/workspace-viewer/worktree-diff",
      requireToken,
      async (req, res) => {
        const sourceCheckoutRoot = req.query.sourceCheckoutRoot;
        const baseCommit = req.query.baseCommit;
        const branchName = req.query.branchName;
        if (
          typeof sourceCheckoutRoot !== "string" ||
          !sourceCheckoutRoot ||
          typeof baseCommit !== "string" ||
          !baseCommit ||
          typeof branchName !== "string" ||
          !branchName
        ) {
          res.status(400).json({
            error:
              "sourceCheckoutRoot, baseCommit, and branchName are required",
          });
          return;
        }
        try {
          const result = await this.viewerService.getWorktreeDiff(
            sourceCheckoutRoot,
            baseCommit,
            branchName
          );
          res.json(result satisfies WorkspaceGitRefDiffResponse);
        } catch (err) {
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /worktree-diff error: ${String(err)}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /checkout-commit error: ${message}`
          );
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
          Log.error(
            `[CtrlYokeHostedServer] workspace-viewer /checkout-branch error: ${message}`
          );
          res.status(500).json({ error: message });
        }
      }
    );

    // SPA fallback: any unmatched route gets the patched index.html (token required).
    this.app.use(requireTokenForPage, (req, res) => {
      this.setNoStore(res);
      res.locals.skipSecretRedaction = true;
      res.send(this.buildHtml(webviewDist, req.get("host")));
    });
  }

  private setNoStore(res: express.Response): void {
    res.set("Cache-Control", "no-store, max-age=0");
    res.set("Pragma", "no-cache");
  }

  private buildHtml(
    webviewDist: string,
    requestHost?: string,
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): string {
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
    const themeBodyClass = this.resolveThemeBodyClass(themeOverride);
    const themeClassScript =
      this.resolveThemeSelection(themeOverride) === SERVER_THEME_MODES.AUTO
        ? '<script>(()=>{const c=window.matchMedia("(prefers-color-scheme: light)").matches?"vscode-light":"vscode-dark";document.body.classList.remove("vscode-light","vscode-dark");document.body.classList.add(c)})()</script>'
        : "";
    html = html.replace(
      "<body>",
      `<body class="${themeBodyClass}" data-aff-uri="/dictionaries/en_US/en_US.aff" data-dic-uri="/dictionaries/en_US/en_US.dic" data-logo-uri="/ctrlyoke-icon.svg">${themeClassScript}`
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
    const themeBlock = this.buildThemeStyleBlock(themeOverride);
    // Append current colors as query params to SVG icon URLs so that browsers (which cache
    // favicon/icon resources aggressively and often ignore Cache-Control headers) pick up the
    // new icon as soon as colors change. The server-side route ignores these params — they exist
    // solely to bust the browser's icon cache. PNG icons are static and need no versioning.
    const { bg, fg } = resolveHostedIconColors(configService.getAll().server);
    const iconColorParam = `?bg=${bg.replace("#", "")}&fg=${fg.replace("#", "")}`;
    const escapedIconColorParam = escapeHtmlAttribute(iconColorParam);
    const hostedIconLinks = [
      // sizes="any" signals this is a scalable SVG — browsers that support SVG will prefer it
      // without fetching the PNG at all. Without this attribute browsers fetch both and show
      // whichever responds first (a race condition).  The PNG fallback is removed; all modern
      // browsers that display favicons support SVG. A default /favicon.ico request will 404
      // gracefully, which is fine.
      `<link rel="icon" type="image/svg+xml" sizes="any" href="${HOSTED_ICON_PATHS.FAVICON_SVG}${escapedIconColorParam}" />`,
      // SVG apple-touch-icon — delivers custom background/foreground colors dynamically.
      // No `sizes` attribute makes it the highest-priority default. iOS SpringBoard fetches
      // this independently from Safari; it requires the server cert to be trusted at the
      // system level (Settings → General → About → Certificate Trust Settings). Once trusted,
      // iOS 15+ will use the SVG for the homescreen icon. PNG is kept as a sized fallback because
      // iOS Safari does not support SVG for homescreen icons — only PNG.
      `<link rel="apple-touch-icon" type="image/svg+xml" sizes="any" href="${HOSTED_ICON_PATHS.APP_ICON_SVG}${escapedIconColorParam}" />`,
      `<link rel="apple-touch-icon" sizes="180x180" href="${HOSTED_ICON_PATHS.APPLE_TOUCH_ICON_PNG}${escapedIconColorParam}" />`,
      // Enable standalone PWA mode and set the title shown under the home screen icon.
      `<meta name="apple-mobile-web-app-capable" content="yes" />`,
      `<meta name="apple-mobile-web-app-title" content="ctrlyoke" />`,
    ].join("");
    return html.replace(
      "</head>",
      `${themeBlock}${hostedIconLinks}<link rel="manifest" href="/manifest.webmanifest?token=${encodeURIComponent(this.token)}" /><script src="/standalone-shim.js"></script></head>`
    );
  }

  private getThemeOverride(
    req: express.Request
  ): Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO> | undefined {
    const value = req.query.theme;
    return value === SERVER_THEME_MODES.LIGHT || value === SERVER_THEME_MODES.DARK
      ? value
      : undefined;
  }

  private resolveThemeSelection(
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): ServerThemeMode {
    if (themeOverride) return themeOverride;
    const configuredTheme = configService.getAll().server.theme;
    return configuredTheme === SERVER_THEME_MODES.LIGHT ||
      configuredTheme === SERVER_THEME_MODES.DARK
      ? configuredTheme
      : SERVER_THEME_MODES.AUTO;
  }

  private buildThemeStyleBlock(
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): string {
    const selection = this.resolveThemeSelection(themeOverride);
    const defaults =
      selection === SERVER_THEME_MODES.AUTO
        ? `@media (prefers-color-scheme: dark) {\n${this.themeDefaults.dark}\n}\n@media (prefers-color-scheme: light) {\n${this.themeDefaults.light}\n}`
        : selection === SERVER_THEME_MODES.LIGHT
          ? this.themeDefaults.light
          : this.themeDefaults.dark;
    const vars = Object.entries(this.cachedThemeVars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    const captured = vars ? `\n:root {\n${vars}\n}` : "";
    return `<style>${defaults}${captured}</style>\n`;
  }

  private resolveThemeBodyClass(
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): string {
    const themeKind = this.cachedThemeVars["--cy-color-theme-kind"];
    if (themeKind === THEME_KINDS.LIGHT) return "vscode-light";
    if (themeKind === THEME_KINDS.HIGH_CONTRAST) return "vscode-high-contrast";
    if (themeKind === THEME_KINDS.DARK) return "vscode-dark";
    return this.resolveThemeSelection(themeOverride) === SERVER_THEME_MODES.LIGHT
      ? "vscode-light"
      : "vscode-dark";
  }

  /**
   * Themed 401 landing page shown to a human in a browser tab (wrong/missing
   * token). Reuses the same theme vars/body class as the main app shell so it
   * never flashes an unstyled background before the user has a valid session.
   */
  private sendUnauthorizedPage(
    res: express.Response,
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): void {
    this.setNoStore(res);
    res
      .status(401)
      .type("html")
      .send(
        buildHostedErrorPage({
          statusCode: 401,
          message: "You need a valid ctrlyoke access token to view this page.",
          hints: [
            "Did you recently regenerate your ctrlyoke token? Old links stop working as soon as the token changes.",
          ],
          themeBodyClass: this.resolveThemeBodyClass(themeOverride),
          themeStyleBlock: this.buildThemeStyleBlock(themeOverride),
          hostKind: this.hostKind,
        })
      );
  }

  /** Themed 404 landing page for a browser-navigated public route (e.g. `/cert`). */
  private sendNotFoundPage(
    res: express.Response,
    message: string,
    hints?: string[],
    themeOverride?: Exclude<ServerThemeMode, typeof SERVER_THEME_MODES.AUTO>
  ): void {
    this.setNoStore(res);
    res
      .status(404)
      .type("html")
      .send(
        buildHostedErrorPage({
          statusCode: 404,
          message,
          hints,
          themeBodyClass: this.resolveThemeBodyClass(themeOverride),
          themeStyleBlock: this.buildThemeStyleBlock(themeOverride),
          hostKind: this.hostKind,
        })
      );
  }

  private serveColorizedSvg(svgPath: string, res: express.Response): void {
    try {
      const { bg, fg } = resolveHostedIconColors(configService.getAll().server);
      const svg = colorizeSvg(fs.readFileSync(svgPath, "utf8"), bg, fg);
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
      const { bg, fg } = resolveHostedIconColors(configService.getAll().server);
      const buffer =
        size === "small"
          ? await pngIconService.getSmall(svgPath, bg, fg)
          : await pngIconService.getLarge(svgPath, bg, fg);
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
    if (timingSafeStringEqual(headerToken, this.token)) {
      return true;
    }
    return timingSafeStringEqual(req.query["token"], this.token);
  }

  private buildManifest(): Record<string, unknown> {
    const { bg, fg } = resolveHostedIconColors(configService.getAll().server);
    const iconColorParam = `?bg=${bg.replace("#", "")}&fg=${fg.replace("#", "")}`;
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

    const notificationEvent = {
      ...event,
      url: event.url ?? this.publicUrl,
    };

    this.broadcast({
      type: MESSAGE_TYPES.NOTIFICATION_EVENT,
      event: notificationEvent,
    });

    if (notificationSettings.browser.mode === BROWSER_NOTIFICATION_MODES.PUSH) {
      try {
        const result =
          await this.webPushService.sendNotification(notificationEvent);
        if (result.sent || result.removed || result.failed) {
          Log.debug(
            `[hosted-server] push notification ${event.id} sent=${result.sent} removed=${result.removed} failed=${result.failed}`
          );
        }
      } catch (error) {
        if (error instanceof PushAccessDeniedError) return;
        Log.warn(
          `[hosted-server] push notification dispatch failed for ${event.id}: ${error}`
        );
      }
    }
  }

  private sendPushAccessError(res: express.Response, error: unknown): boolean {
    if (!(error instanceof PushAccessDeniedError)) return false;
    res.status(403).json({
      error: error.message,
      pricingUrl: LICENSE_UI.PRICING_URL,
    });
    return true;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private setupWebSocket(): void {
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", `http://localhost`);
      if (!timingSafeStringEqual(url.searchParams.get("token"), this.token)) {
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
        if (ws.readyState === WebSocket.OPEN) {
          const json = JSON.stringify(redactHostedTransportMessage(reply));
          ws.send(json);
          this.noteLargeSend(reply, json, ws, clientTag);
        }
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
              `[hosted-server] WebSocket READY clientId=${clientTag} afterMs=${Date.now() - connectedAt} preferredViewAddress=${JSON.stringify(msg.preferredViewAddress ?? null)}`
            );
          }
          void this.dashboardClient
            .routeClientMessage(msg, send, clientTag)
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
          this.dashboardClient.disconnectClient?.(clientTag);
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
    this.dashboardClient.requestThemeCapture?.();
    // NOTE: We intentionally do NOT inject a server-side synthetic READY here.
    // Browser-client registration belongs to standalone-shim.js: it sends READY
    // when the socket opens, buffers replay messages, then flushes them only
    // after React posts its own READY and useMessageHandler is listening.
  }

  private broadcast(message: unknown): void {
    const json = JSON.stringify(redactHostedTransportMessage(message));
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        this.noteLargeSend(message, json, ws);
      }
    }
  }

  /**
   * Large sends and per-socket queue depth (`bufferedAmount`, which nothing
   * here bounds) are reported to the memory watchdog so a heap jump can be
   * tied to the hosted delivery that caused it.
   */
  private noteLargeSend(
    message: unknown,
    json: string,
    ws: WebSocket,
    clientTag?: string
  ): void {
    if (json.length < LARGE_HOSTED_SEND_BYTES) return;
    const tag = clientTag ?? this.socketClientTags.get(ws);
    const type = (message as { type?: unknown } | null)?.type;
    noteMemoryActivity(
      `hosted send ${typeof type === "string" ? type : "unknown"} ${bytesToMb(json.length)}MB client=${tag ?? "?"} queued=${bytesToMb(ws.bufferedAmount)}MB`
    );
  }

  private hostedMemoryContext(): Record<string, number> {
    let totalQueued = 0;
    let maxQueued = 0;
    for (const ws of this.connections) {
      totalQueued += ws.bufferedAmount;
      maxQueued = Math.max(maxQueued, ws.bufferedAmount);
    }
    return {
      connections: this.connections.size,
      queuedMB: bytesToMb(totalQueued),
      maxSocketQueuedMB: bytesToMb(maxQueued),
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async listen(): Promise<string | undefined> {
    this.requestedPort = this.port;
    this.portFellBack = false;
    this.bindAddressFallback = undefined;
    await this.enforceRemoteBindBeforeListen();
    // Try the configured port, then each configured fallback port in order
    // (so a workspace can pin a stable, bookmarkable URL even when the
    // primary port is often taken), then finally an OS-assigned port.
    const candidatePorts = [
      this.port,
      ...this.fallbackPorts.filter((port) => port !== this.port),
      0,
    ];
    let candidateIndex = 0;
    return new Promise((resolve, reject) => {
      const attemptListen = (port: number) => {
        const onError = (err: NodeJS.ErrnoException) => {
          this.httpServer.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE") {
            const tryNextCandidate = () => {
              this.portFellBack = true;
              candidateIndex += 1;
              const nextPort = candidatePorts[candidateIndex] ?? 0;
              setImmediate(() => attemptListen(nextPort));
            };
            void this.probeExistingServer(port)
              .then((existingServer) => {
                if (existingServer) {
                  this.onSiblingServerDetected?.(this.buildPublicUrl(port));
                }
                tryNextCandidate();
              })
              .catch(tryNextCandidate);
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
          this.writeDevServerUrlFile(this.publicUrl);
          resolve(this.publicUrl);
        };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        this.httpServer.listen(port, this.bindAddress);
      };
      attemptListen(candidatePorts[0]);
    });
  }

  private async enforceRemoteBindBeforeListen(): Promise<void> {
    if (
      (await this.resolveRemoteAccess()) ||
      isLoopbackBindAddress(this.bindAddress)
    ) {
      return;
    }

    const requestedBindAddress = this.bindAddress;
    this.bindAddress = "127.0.0.1";
    this.bindAddressFallback = {
      requestedBindAddress,
      actualBindAddress: this.bindAddress,
    };
    this.notifyRemoteAccessBlocked();
  }

  private notifyRemoteAccessBlocked(): void {
    if (this.remoteAccessUpsellShown) return;
    this.remoteAccessUpsellShown = true;
    this.onRemoteAccessBlocked?.();
  }

  private async resolveRemoteAccess(): Promise<boolean> {
    // Fail closed to Free/localhost-only when no entitlement callback is
    // wired, consistent with LicenseService's fail-open-to-free contract
    // (PRO_LICENSE_PLAN.md §1.4/§1.8) — a caller that omits the callback
    // must never be granted remote reach or push access by default.
    if (!this.getRemoteAccess) return false;
    try {
      return await this.getRemoteAccess();
    } catch {
      return false;
    }
  }

  getAvailableIps(): string[] {
    return this.availableIps;
  }

  getServerUrl(): string | undefined {
    return this.publicUrl;
  }

  hasConnectedClients(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Non-null only when the configured `server.port` was already taken
   * (EADDRINUSE) and listen() fell back to an OS-assigned port instead.
   * Callers use this to warn the user, since the running URL silently
   * differs from what they configured until the server is restarted.
   */
  getPortFallbackInfo(): ServerPortFallbackInfo | null {
    if (!this.portFellBack || this.requestedPort === undefined) {
      return null;
    }
    return { requestedPort: this.requestedPort, actualPort: this.port };
  }

  /**
   * Non-null when a non-loopback configured bind address was coerced to
   * localhost because remote access was not entitled.
   */
  getBindAddressFallbackInfo(): BindAddressFallbackInfo | null {
    return this.bindAddressFallback ?? null;
  }

  private buildPublicUrl(port: number): string {
    const scheme = this.isTls ? "https" : "http";
    const availableIps = this.bindAddress === "0.0.0.0" ? this.getLanIps() : [];
    const host = availableIps[0] ?? "localhost";
    return `${scheme}://${host}:${port}/?token=${this.token}`;
  }

  private probeExistingServer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const nonce = randomBytes(32).toString("hex");
      const request = (this.isTls ? httpsRequest : httpRequest)(
        {
          hostname: this.getProbeHost(),
          port,
          path: `${SERVER_IDENTITY_ROUTE_PATH}?nonce=${nonce}`,
          method: "GET",
          timeout: SIBLING_SERVER_PROBE_TIMEOUT_MS,
          ...(this.isTls ? { rejectUnauthorized: false } : {}),
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              resolve(false);
              return;
            }
            try {
              const payload: unknown = JSON.parse(body);
              const proof =
                payload && typeof payload === "object"
                  ? (payload as { proof?: unknown }).proof
                  : undefined;
              resolve(
                timingSafeStringEqual(
                  proof,
                  createServerIdentityProof(
                    this.token,
                    nonce,
                    this.workspaceRoot
                  )
                )
              );
            } catch {
              resolve(false);
            }
          });
          response.on("error", () => resolve(false));
        }
      );
      request.on("error", () => resolve(false));
      request.on("timeout", () => request.destroy());
      request.end();
    });
  }

  private getProbeHost(): string {
    if (this.bindAddress === "0.0.0.0") return "127.0.0.1";
    if (this.bindAddress === "::") return "::1";
    return this.bindAddress;
  }

  private getLanIps(): string[] {
    const ips: string[] = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (
          iface.family === NETWORK_INTERFACE_FAMILIES.IPV4 &&
          !iface.internal
        ) {
          ips.push(iface.address);
        }
      }
    }
    return ips;
  }

  /**
   * Dev-only convenience: mirrors the active workspace server URL (including
   * its token) to `.ctrlyoke/dev/server-url.txt` so external tooling can read it directly
   * instead of a human pasting it. Best-effort — a write failure must never
   * block the server from starting.
   */
  private writeDevServerUrlFile(url: string): void {
    if (!IS_DEV_MODE) return;
    try {
      const devDir = path.join(
        this.workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.DEV_DIR
      );
      fs.mkdirSync(devDir, { recursive: true });
      fs.writeFileSync(
        path.join(devDir, PATH_CONSTANTS.SERVER_URL_FILE),
        `${url}\n`,
        "utf8"
      );
      this.devServerUrlFileOwned = true;
    } catch (err) {
      Log.warn(
        `[CtrlYokeHostedServer] ctrlyoke: Failed to write dev server-url file: ${err}`
      );
    }
  }

  private clearDevServerUrlFile(): void {
    if (!IS_DEV_MODE) return;
    try {
      fs.rmSync(
        path.join(
          this.workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          PATH_CONSTANTS.DEV_DIR,
          PATH_CONSTANTS.SERVER_URL_FILE
        ),
        { force: true }
      );
    } catch (err) {
      Log.warn(
        `[CtrlYokeHostedServer] ctrlyoke: Failed to clear dev server-url file: ${err}`
      );
    }
  }

  dispose(): void {
    this.unregisterMemoryContext();
    if (this.devServerUrlFileOwned) this.clearDevServerUrlFile();
    this.viewerService.dispose();
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
    // Bundled entrypoints resolve __dirname to out/, while plain tsc output
    // (including extension-host tests) resolves it to out/server/.
    const bundledDist = path.join(__dirname, "ui", "webview-react");
    if (fs.existsSync(path.join(bundledDist, "index.html"))) return bundledDist;
    return path.join(__dirname, "..", "ui", "webview-react");
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
