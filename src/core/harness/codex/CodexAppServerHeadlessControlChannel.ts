import {
  APPROVAL_DECISIONS,
  FAILURE_KINDS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
  type ApprovalDecision,
} from "../../../types/DashboardConstants";
import { CTRLYOKE_VERSION } from "../../../utils/BuildConfig";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { CliTransportError } from "../shared/CliTransportError";
import type {
  ControlObservation,
  ControlWriter,
  HeadlessControlChannelContext,
  IHeadlessControlChannel,
} from "../shared/IHeadlessControlChannel";
import { CODEX_APP_SERVER_METHODS } from "./CodexProtocolConstants";

type JsonRpcId = number | string;

interface PendingRpcRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface CodexAppServerHeadlessControlChannelOptions {
  context?: HeadlessControlChannelContext;
  additionalWritableRoots?: readonly string[];
  isRecoverableSessionError?: (message: string) => boolean;
}

function rpcIdKey(id: unknown): string | undefined {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `number:${id}`;
  return undefined;
}

function isJsonRpcId(id: unknown): id is JsonRpcId {
  return (
    typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
  );
}

function getRpcErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Codex app-server returned an invalid JSON-RPC error";
}

function isApprovalMethod(method: string): boolean {
  return (
    method === CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL ||
    method === CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL ||
    method === CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL
  );
}

function approvalToolName(method: string): string {
  switch (method) {
    case CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL:
      return "Command execution";
    case CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL:
      return "File change";
    case CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL:
      return "Additional permissions";
    default:
      return "Codex request";
  }
}

/** JSON-RPC control transport for a single Codex app-server thread and turn. */
export class CodexAppServerHeadlessControlChannel implements IHeadlessControlChannel {
  readonly spawnShape = {};
  readonly steerDelivery = HEADLESS_STEER_DELIVERIES.QUEUE;
  readonly supportsSteering = false;

  private writer?: ControlWriter;
  private nextRequestId = 1;
  private threadId?: string;
  private initialPromptSent = false;
  private turnCompleted = false;
  private readonly pendingRpc = new Map<string, PendingRpcRequest>();
  private readonly pendingServerRequests = new Map<
    string,
    PendingServerRequest
  >();

  constructor(
    private readonly options: CodexAppServerHeadlessControlChannelOptions = {}
  ) {}

  async start(writer: ControlWriter): Promise<void> {
    this.writer = writer;
    try {
      await this.request(CODEX_APP_SERVER_METHODS.INITIALIZE, {
        clientInfo: {
          name: "ctrlyoke",
          title: "ctrlyoke",
          version: CTRLYOKE_VERSION,
        },
        capabilities: { experimentalApi: true },
      });
      await this.writeNotification(CODEX_APP_SERVER_METHODS.INITIALIZED);

      const sessionId = this.options.context?.sessionId;
      const config = await this.buildThreadConfig();
      const method = sessionId
        ? CODEX_APP_SERVER_METHODS.THREAD_RESUME
        : CODEX_APP_SERVER_METHODS.THREAD_START;
      const params = sessionId
        ? {
            threadId: sessionId,
            config,
            excludeTurns: true,
          }
        : {
            historyMode: "paginated",
            config,
          };
      const result = await this.request(method, params);
      const thread =
        isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
      if (typeof thread?.id !== "string" || thread.id.length === 0) {
        throw new Error("Codex app-server did not return a thread ID");
      }
      this.threadId = thread.id;
    } catch (error) {
      const message = getErrorMessage(error);
      if (
        this.options.context?.sessionId &&
        this.options.isRecoverableSessionError?.(message)
      ) {
        throw new CliTransportError(message, FAILURE_KINDS.SESSION_REJECTED);
      }
      throw error;
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.threadId) {
      throw new Error("Codex app-server thread has not started");
    }
    if (this.initialPromptSent) {
      throw new Error("Codex app-server headless steering is not enabled");
    }
    this.initialPromptSent = true;
    const input: Record<string, unknown>[] = [
      { type: "text", text, textElements: [] },
      ...(this.options.context?.imageFilePaths ?? []).map((path) => ({
        type: "localImage",
        path,
      })),
    ];
    await this.request(CODEX_APP_SERVER_METHODS.TURN_START, {
      threadId: this.threadId,
      input,
    });
  }

  observe(record: unknown): ControlObservation[] {
    if (!isRecord(record)) return [];

    if (typeof record.method === "string" && isJsonRpcId(record.id)) {
      return this.observeServerRequest(record.id, record.method, record.params);
    }

    if (isJsonRpcId(record.id)) {
      const key = rpcIdKey(record.id);
      if (key && this.pendingRpc.has(key)) {
        const pending = this.pendingRpc.get(key)!;
        this.pendingRpc.delete(key);
        if (record.error !== undefined) {
          pending.reject(
            new Error(
              `Codex app-server rejected ${pending.method}: ${getRpcErrorMessage(record.error)}`
            )
          );
        } else {
          pending.resolve(record.result);
        }
        return [];
      }
    }

    if (
      record.method === CODEX_APP_SERVER_METHODS.TURN_COMPLETED &&
      isRecord(record.params) &&
      record.params.threadId === this.threadId &&
      !this.turnCompleted
    ) {
      this.turnCompleted = true;
      return [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }];
    }

    return [];
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void> {
    const request = this.pendingServerRequests.get(requestId);
    if (!request) {
      throw new Error(`Unknown Codex app-server request: ${requestId}`);
    }

    let response: Record<string, unknown>;
    if (request.method === CODEX_APP_SERVER_METHODS.COMMAND_APPROVAL) {
      response = {
        decision:
          decision === APPROVAL_DECISIONS.ALLOW_ONCE ? "accept" : "decline",
      };
    } else if (
      request.method === CODEX_APP_SERVER_METHODS.FILE_CHANGE_APPROVAL
    ) {
      response = {
        decision:
          decision === APPROVAL_DECISIONS.ALLOW_ONCE ? "accept" : "decline",
      };
    } else if (
      request.method === CODEX_APP_SERVER_METHODS.PERMISSIONS_APPROVAL
    ) {
      const params = isRecord(request.params) ? request.params : undefined;
      const requestedPermissions = params?.permissions;
      if (
        decision === APPROVAL_DECISIONS.ALLOW_ONCE &&
        !isRecord(requestedPermissions)
      ) {
        throw new Error(
          "Codex app-server permissions request did not include a permission profile"
        );
      }
      response = {
        permissions:
          decision === APPROVAL_DECISIONS.ALLOW_ONCE
            ? requestedPermissions
            : {},
        scope: "turn",
      };
    } else {
      await this.writeServerError(
        request.id,
        message ?? "This Codex request is not supported in a headless step"
      );
      this.pendingServerRequests.delete(requestId);
      return;
    }

    await this.writeServerResponse(request.id, response);
    this.pendingServerRequests.delete(requestId);
  }

  close(): void {
    this.writer = undefined;
    for (const pending of this.pendingRpc.values()) {
      pending.reject(new Error("Codex app-server control channel closed"));
    }
    this.pendingRpc.clear();
    this.pendingServerRequests.clear();
  }

  private observeServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown
  ): ControlObservation[] {
    const requestId = rpcIdKey(id);
    if (!requestId) return [];
    this.pendingServerRequests.set(requestId, { id, method, params });

    if (isApprovalMethod(method)) {
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId,
          toolName: approvalToolName(method),
          input: params,
        },
      ];
    }

    return [
      {
        kind: HEADLESS_CONTROL_OBSERVATION_KINDS.MODEL_QUESTION,
        requestId,
      },
    ];
  }

  private async buildThreadConfig(): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = { bypass_hook_trust: true };
    const additionalRoots = this.options.additionalWritableRoots ?? [];
    if (additionalRoots.length === 0) return config;

    const response = await this.request(
      CODEX_APP_SERVER_METHODS.CONFIG_READ,
      {}
    );
    if (!isRecord(response) || !isRecord(response.config)) {
      throw new Error(
        "Codex app-server config/read returned an invalid response"
      );
    }
    const currentConfig = response.config;
    const sandbox = isRecord(currentConfig?.sandbox_workspace_write)
      ? currentConfig.sandbox_workspace_write
      : undefined;
    const existingRoots = Array.isArray(sandbox?.writable_roots)
      ? sandbox.writable_roots.filter(
          (root): root is string => typeof root === "string"
        )
      : [];
    config["sandbox_workspace_write.writable_roots"] = [
      ...new Set([...existingRoots, ...additionalRoots]),
    ];
    return config;
  }

  private async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const writer = this.writer;
    if (!writer) {
      throw new Error("Codex app-server control channel has not started");
    }

    const id = this.nextRequestId++;
    const key = rpcIdKey(id)!;
    let resolveResponse!: (result: unknown) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.pendingRpc.set(key, {
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    try {
      await writer.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      this.pendingRpc.delete(key);
      throw error;
    }
    return response;
  }

  private async writeNotification(method: string): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      throw new Error("Codex app-server control channel has not started");
    }
    await writer.write(`${JSON.stringify({ method })}\n`);
  }

  private async writeServerResponse(
    id: JsonRpcId,
    result: Record<string, unknown>
  ): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      throw new Error("Codex app-server control channel has not started");
    }
    await writer.write(`${JSON.stringify({ id, result })}\n`);
  }

  private async writeServerError(
    id: JsonRpcId,
    message: string
  ): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      throw new Error("Codex app-server control channel has not started");
    }
    await writer.write(
      `${JSON.stringify({
        id,
        error: { code: -32000, message },
      })}\n`
    );
  }
}
