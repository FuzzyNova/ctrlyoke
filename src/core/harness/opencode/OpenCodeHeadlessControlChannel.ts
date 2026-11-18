import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import {
  APPROVAL_DECISIONS,
  HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
  type ApprovalDecision,
} from "../../../types/DashboardConstants";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { Log } from "../../../utils/Log";
import {
  OPENCODE_HEADLESS_CONTROL_ENV,
  OPENCODE_HEADLESS_CONTROL_EVENTS,
  OPENCODE_HEADLESS_CONTROL_ROUTES,
  OPENCODE_HEADLESS_PERMISSION_DECISIONS,
} from "./OpenCodeProtocolConstants";
import type {
  ControlObservation,
  ControlObservationHandler,
  ControlWriter,
  HeadlessControlSpawnShape,
  IHeadlessControlChannel,
} from "../shared/IHeadlessControlChannel";

const HTTP_METHODS = {
  GET: "GET",
  POST: "POST",
} as const;

const HTTP_STATUSES = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_SERVER_ERROR: 500,
} as const;

const OPENCODE_PERMISSION_EFFECTS = {
  ASK: "ask",
} as const;

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const STEER_POLL_TIMEOUT_MS = 20_000;

interface PendingApproval {
  resolve: (result: { decision: ApprovalDecision; message?: string }) => void;
}

interface PendingSteer {
  id: string;
  text: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingSteerPoll {
  sessionId: string;
  response: ServerResponse;
  timer: NodeJS.Timeout;
}

interface BridgeError extends Error {
  statusCode?: number;
}

function isHttpMethod(
  method: string | undefined,
  expected: (typeof HTTP_METHODS)[keyof typeof HTTP_METHODS]
): boolean {
  return method === expected;
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  if (response.destroyed || response.writableEnded) return;
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(content),
  });
  response.end(content);
}

function bridgeError(statusCode: number, message: string): BridgeError {
  const error = new Error(message) as BridgeError;
  error.statusCode = statusCode;
  return error;
}

/** Per-process loopback control bridge for OpenCode 2.3+ headless runs. */
export class OpenCodeHeadlessControlChannel implements IHeadlessControlChannel {
  readonly steerDelivery = HEADLESS_STEER_DELIVERIES.INJECT;
  readonly answersApprovalRequests = true;
  private readonly token = randomBytes(32).toString("hex");
  private readonly server: Server;
  private baseUrl?: string;
  private writer?: ControlWriter;
  private observationHandler?: ControlObservationHandler;
  private mainSessionId?: string;
  private mainSessionActive = false;
  private initialPromptSent = false;
  private closed = false;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly queuedSteers: PendingSteer[] = [];
  private readonly pendingSteerPolls = new Set<PendingSteerPoll>();

  private constructor() {
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  static async create(): Promise<OpenCodeHeadlessControlChannel> {
    const channel = new OpenCodeHeadlessControlChannel();
    try {
      await channel.listen();
      return channel;
    } catch (error) {
      channel.close();
      throw error;
    }
  }

  get spawnShape(): HeadlessControlSpawnShape {
    if (!this.baseUrl) {
      throw new Error("OpenCode headless control bridge is not listening");
    }
    return {
      env: {
        [OPENCODE_HEADLESS_CONTROL_ENV.URL]: this.baseUrl,
        [OPENCODE_HEADLESS_CONTROL_ENV.TOKEN]: this.token,
      },
    };
  }

  async start(
    writer: ControlWriter,
    onObservations?: ControlObservationHandler
  ): Promise<void> {
    if (this.closed) {
      throw new Error("OpenCode headless control bridge is closed");
    }
    this.writer = writer;
    this.observationHandler = onObservations;
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.initialPromptSent) {
      if (!this.writer) {
        throw new Error("OpenCode headless control channel has not started");
      }
      await this.writer.write(text);
      await this.writer.end();
      this.initialPromptSent = true;
      return;
    }

    if (
      this.closed ||
      (this.mainSessionId !== undefined && !this.mainSessionActive)
    ) {
      throw new Error(
        "OpenCode session has already ended; the steer message was not queued."
      );
    }

    await new Promise<void>((resolve, reject) => {
      const steer: PendingSteer = {
        id: randomUUID(),
        text,
        resolve,
        reject,
      };
      this.queuedSteers.push(steer);
      this.deliverQueuedSteers();
    });
  }

  observe(_record: unknown): ControlObservation[] {
    return [];
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown OpenCode permission request: ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);
    pending.resolve({
      decision,
      ...(message !== undefined ? { message } : {}),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const poll of [...this.pendingSteerPolls]) {
      this.finishSteerPoll(poll, HTTP_STATUSES.GONE, {
        error: "OpenCode control channel is closed",
      });
    }
    const closedError = new Error(
      "OpenCode session has already ended; the steer message was not queued."
    );
    for (const steer of this.queuedSteers.splice(0)) {
      steer.reject(closedError);
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({
        decision: APPROVAL_DECISIONS.DENY,
        message: HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
      });
    }
    this.pendingApprovals.clear();

    if (this.server.listening) {
      this.server.close((error) => {
        if (error) {
          Log.warn(
            `[OpenCodeHeadlessControlChannel] Could not close control bridge: ${error.message}`
          );
        }
      });
    }
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });

    const address = this.server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      throw new Error("OpenCode control bridge did not bind a TCP port");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.server.on("error", (error: Error) => {
      Log.warn(
        `[OpenCodeHeadlessControlChannel] Control bridge error: ${error.message}`
      );
    });
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (!this.isAuthorized(request)) {
        respondJson(response, HTTP_STATUSES.UNAUTHORIZED, {
          error: "Unauthorized OpenCode control request",
        });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        isHttpMethod(request.method, HTTP_METHODS.GET) &&
        url.pathname === OPENCODE_HEADLESS_CONTROL_ROUTES.STEER
      ) {
        this.handleSteerPoll(url.searchParams.get("sessionID") ?? "", response);
        return;
      }
      if (
        isHttpMethod(request.method, HTTP_METHODS.POST) &&
        url.pathname === OPENCODE_HEADLESS_CONTROL_ROUTES.PERMISSION
      ) {
        await this.handlePermission(request, response);
        return;
      }
      if (
        isHttpMethod(request.method, HTTP_METHODS.POST) &&
        url.pathname === OPENCODE_HEADLESS_CONTROL_ROUTES.SESSION_EVENT
      ) {
        await this.handleSessionEvent(request, response);
        return;
      }
      respondJson(response, HTTP_STATUSES.NOT_FOUND, {
        error: "Unknown OpenCode control route",
      });
    } catch (error) {
      const statusCode =
        isRecord(error) && typeof error.statusCode === "number"
          ? error.statusCode
          : HTTP_STATUSES.INTERNAL_SERVER_ERROR;
      if (statusCode === HTTP_STATUSES.INTERNAL_SERVER_ERROR) {
        Log.warn(
          `[OpenCodeHeadlessControlChannel] Control request failed: ${getErrorMessage(error)}`
        );
      }
      respondJson(response, statusCode, { error: getErrorMessage(error) });
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const prefix = "Bearer ";
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith(prefix)
    ) {
      return false;
    }
    const candidate = Buffer.from(authorization.slice(prefix.length));
    const expected = Buffer.from(this.token);
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  }

  private async handlePermission(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await this.readJson(request);
    if (body.effect !== OPENCODE_PERMISSION_EFFECTS.ASK) {
      respondJson(response, HTTP_STATUSES.BAD_REQUEST, {
        error: "OpenCode permission bridge expects an ask effect",
      });
      return;
    }

    const requestId = randomUUID();
    const result = await new Promise<{
      decision: ApprovalDecision;
      message?: string;
    }>((resolve) => {
      const pending: PendingApproval = { resolve };
      this.pendingApprovals.set(requestId, pending);
      response.once("close", () => {
        if (!response.writableEnded) {
          this.pendingApprovals.delete(requestId);
        }
      });
      this.observationHandler?.([
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId,
          toolName:
            typeof body.action === "string"
              ? body.action
              : "OpenCode permission request",
          input: {
            agent: body.agent,
            resources: body.resources,
            source: body.source,
          },
        },
      ]);
      if (!this.observationHandler) {
        this.pendingApprovals.delete(requestId);
        resolve({
          decision: APPROVAL_DECISIONS.DENY,
          message: HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
        });
      }
    });
    const decision =
      result.decision === APPROVAL_DECISIONS.ALLOW_ONCE
        ? OPENCODE_HEADLESS_PERMISSION_DECISIONS.ONCE
        : OPENCODE_HEADLESS_PERMISSION_DECISIONS.REJECT;
    respondJson(response, HTTP_STATUSES.OK, {
      decision,
      ...(result.message !== undefined ? { message: result.message } : {}),
    });
  }

  private async handleSessionEvent(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await this.readJson(request);
    if (typeof body.sessionID !== "string" || typeof body.type !== "string") {
      throw bridgeError(
        HTTP_STATUSES.BAD_REQUEST,
        "OpenCode session event is missing its type or sessionID"
      );
    }

    if (body.type === OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_STARTED) {
      const isRootSession =
        typeof body.parentID !== "string" || body.parentID.length === 0;
      if (
        isRootSession &&
        (!this.mainSessionId || this.mainSessionId === body.sessionID)
      ) {
        this.mainSessionId = body.sessionID;
        this.mainSessionActive = true;
      }
      response.writeHead(HTTP_STATUSES.NO_CONTENT);
      response.end();
      return;
    }

    if (
      body.type === OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_SUCCEEDED ||
      body.type === OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_FAILED ||
      body.type === OPENCODE_HEADLESS_CONTROL_EVENTS.EXECUTION_INTERRUPTED
    ) {
      if (body.sessionID === this.mainSessionId && this.mainSessionActive) {
        this.mainSessionActive = false;
        this.rejectQueuedSteers(
          "OpenCode session has already ended; the steer message was not queued."
        );
        for (const poll of [...this.pendingSteerPolls]) {
          this.finishSteerPoll(poll, HTTP_STATUSES.GONE, {
            error: "OpenCode session has already ended",
          });
        }
        this.observationHandler?.([
          { kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END },
        ]);
      }
    }
    response.writeHead(HTTP_STATUSES.NO_CONTENT);
    response.end();
  }

  private handleSteerPoll(sessionId: string, response: ServerResponse): void {
    if (
      this.closed ||
      !this.mainSessionActive ||
      sessionId !== this.mainSessionId
    ) {
      respondJson(response, HTTP_STATUSES.GONE, {
        error: "OpenCode session has already ended",
      });
      return;
    }

    const queued = this.queuedSteers.shift();
    if (queued) {
      respondJson(response, HTTP_STATUSES.OK, {
        id: queued.id,
        text: queued.text,
      });
      queued.resolve();
      return;
    }

    const poll: PendingSteerPoll = {
      sessionId,
      response,
      timer: setTimeout(() => {
        this.finishSteerPoll(poll, HTTP_STATUSES.NO_CONTENT);
      }, STEER_POLL_TIMEOUT_MS),
    };
    this.pendingSteerPolls.add(poll);
    response.once("close", () => {
      clearTimeout(poll.timer);
      this.pendingSteerPolls.delete(poll);
    });
    this.deliverQueuedSteers();
  }

  private deliverQueuedSteers(): void {
    while (this.queuedSteers.length > 0) {
      const poll = [...this.pendingSteerPolls].find(
        (candidate) =>
          candidate.sessionId === this.mainSessionId && this.mainSessionActive
      );
      if (!poll) return;

      const steer = this.queuedSteers.shift()!;
      this.finishSteerPoll(poll, HTTP_STATUSES.OK, {
        id: steer.id,
        text: steer.text,
      });
      steer.resolve();
    }
  }

  private finishSteerPoll(
    poll: PendingSteerPoll,
    statusCode: number,
    body?: unknown
  ): void {
    if (!this.pendingSteerPolls.delete(poll)) return;
    clearTimeout(poll.timer);
    if (statusCode === HTTP_STATUSES.NO_CONTENT) {
      if (!poll.response.destroyed && !poll.response.writableEnded) {
        poll.response.writeHead(statusCode);
        poll.response.end();
      }
      return;
    }
    respondJson(poll.response, statusCode, body);
  }

  private rejectQueuedSteers(message: string): void {
    const error = new Error(message);
    for (const steer of this.queuedSteers.splice(0)) {
      steer.reject(error);
    }
  }

  private async readJson(
    request: IncomingMessage
  ): Promise<Record<string, unknown>> {
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let bytes = 0;
      let tooLarge = false;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_REQUEST_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        if (!tooLarge) chunks.push(chunk);
      });
      request.once("error", reject);
      request.once("end", () => {
        if (tooLarge) {
          reject(
            bridgeError(
              HTTP_STATUSES.PAYLOAD_TOO_LARGE,
              "OpenCode control request is too large"
            )
          );
        } else {
          resolve(chunks.join(""));
        }
      });
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw bridgeError(HTTP_STATUSES.BAD_REQUEST, "Invalid JSON request body");
    }
    if (!isRecord(parsed)) {
      throw bridgeError(
        HTTP_STATUSES.BAD_REQUEST,
        "OpenCode control request must be a JSON object"
      );
    }
    return parsed;
  }
}
