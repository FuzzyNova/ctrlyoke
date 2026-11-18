import * as fs from "fs/promises";
import * as path from "path";
import {
  APPROVAL_DECISIONS,
  FAILURE_KINDS,
  FAILURE_SOURCES,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
  imageExtensionToMimeType,
  type ApprovalDecision,
} from "../../../types/DashboardConstants";
import { CTRLYOKE_VERSION } from "../../../utils/BuildConfig";
import { getErrorMessage } from "../../../utils/ErrorUtils";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { CliTransportError } from "../shared/CliTransportError";
import {
  AcpJsonRpcClient,
  type AcpJsonRpcId,
  type AcpJsonRpcRequest,
} from "../shared/AcpJsonRpcClient";
import {
  COPILOT_ACP_CONTENT_TYPES,
  COPILOT_ACP_METHODS,
  COPILOT_ACP_PERMISSION_KINDS,
  COPILOT_ACP_PERMISSION_OUTCOMES,
  COPILOT_ACP_SESSION_EVENT_CAPABILITY,
  COPILOT_ACP_SESSION_EVENTS,
  COPILOT_CLI_FLAGS,
} from "./CopilotProtocolConstants";
import type {
  ControlObservation,
  ControlWriter,
  HeadlessControlChannelOptions,
  IHeadlessControlChannel,
} from "../shared/IHeadlessControlChannel";

interface PendingPermission {
  id: AcpJsonRpcId;
  options: readonly unknown[];
  toolName: string;
  input: unknown;
}

function requestKey(id: AcpJsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function getPermissionOption(
  options: readonly unknown[],
  kind: (typeof COPILOT_ACP_PERMISSION_KINDS)[keyof typeof COPILOT_ACP_PERMISSION_KINDS]
): string | undefined {
  for (const option of options) {
    if (
      isRecord(option) &&
      option.kind === kind &&
      typeof option.optionId === "string"
    ) {
      return option.optionId;
    }
  }
  return undefined;
}

/** Copilot CLI's ACP channel for one headless workflow step. */
export class CopilotHeadlessControlChannel implements IHeadlessControlChannel {
  readonly steerDelivery = HEADLESS_STEER_DELIVERIES.QUEUE;
  readonly startLogTailAfterChannelStart = true;
  readonly spawnShape: {
    args: readonly string[];
    replaceArgs: true;
  };

  private readonly client = new AcpJsonRpcClient();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private promptQueue = Promise.resolve();
  private sessionId?: string;
  private activePrompt?: AcpJsonRpcRequest;
  private initialPromptSent = false;

  constructor(
    private readonly options: HeadlessControlChannelOptions,
    launchArgs: readonly string[]
  ) {
    this.spawnShape = {
      args: [
        COPILOT_CLI_FLAGS.ACP,
        ...CopilotHeadlessControlChannel.filterLaunchArgs(launchArgs),
      ],
      replaceArgs: true,
    };
  }

  async start(writer: ControlWriter): Promise<void> {
    this.client.start(writer);
    try {
      const initialized = this.client.request(COPILOT_ACP_METHODS.INITIALIZE, {
        protocolVersion: 1,
        clientInfo: {
          name: "ctrlyoke",
          title: "ctrlyoke",
          version: CTRLYOKE_VERSION,
        },
        clientCapabilities: {
          _meta: {
            [COPILOT_ACP_SESSION_EVENT_CAPABILITY]: {
              events: [...COPILOT_ACP_SESSION_EVENTS],
            },
          },
        },
      });
      await initialized.sent;
      await initialized.result;

      const cwd = this.options.context?.workspaceRoot ?? process.cwd();
      const priorSessionId = this.options.context?.sessionId;
      const sessionRequest = this.client.request(
        priorSessionId
          ? COPILOT_ACP_METHODS.SESSION_LOAD
          : COPILOT_ACP_METHODS.SESSION_NEW,
        {
          ...(priorSessionId ? { sessionId: priorSessionId } : {}),
          cwd,
          mcpServers: [],
        }
      );
      await sessionRequest.sent;
      const result = await sessionRequest.result;
      const returnedSessionId =
        isRecord(result) &&
        typeof result.sessionId === "string" &&
        result.sessionId.length > 0
          ? result.sessionId
          : undefined;
      const sessionId = returnedSessionId ?? priorSessionId;
      if (!sessionId) {
        throw new Error("Copilot ACP did not return a session ID");
      }
      this.sessionId = sessionId;
      this.options.context?.onSessionId?.(sessionId);
    } catch (error) {
      throw new CliTransportError(
        `Copilot ACP session setup failed: ${getErrorMessage(error)}`,
        FAILURE_KINDS.HARNESS_ERROR,
        { cause: error },
        FAILURE_SOURCES.HEADLESS_PARSE
      );
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    const queuedSend = this.promptQueue.then(() =>
      this.sendQueuedUserMessage(text)
    );
    this.promptQueue = queuedSend.catch(() => undefined);
    await queuedSend;
  }

  private async sendQueuedUserMessage(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Copilot ACP session has not started");
    }

    const priorRequest = this.activePrompt;
    if (priorRequest) {
      await priorRequest.result;
    }

    const prompt = [
      { type: COPILOT_ACP_CONTENT_TYPES.TEXT, text },
      ...(this.initialPromptSent ? [] : await this.readImageContent()),
    ];
    this.initialPromptSent = true;
    const request = this.client.request(COPILOT_ACP_METHODS.SESSION_PROMPT, {
      sessionId: this.sessionId,
      prompt,
    });
    this.activePrompt = request;
    await request.sent;
  }

  observe(record: unknown): ControlObservation[] {
    if (!isRecord(record)) return [];

    if (
      record.method === COPILOT_ACP_METHODS.SESSION_REQUEST_PERMISSION &&
      isAcpId(record.id) &&
      isRecord(record.params)
    ) {
      const params = record.params;
      const toolCall = isRecord(params.toolCall) ? params.toolCall : params;
      const options = Array.isArray(params.options) ? params.options : [];
      const key = requestKey(record.id);
      const toolName =
        (typeof toolCall.title === "string" && toolCall.title) ||
        (typeof toolCall.name === "string" && toolCall.name) ||
        "Copilot tool";
      const input =
        toolCall.rawInput ?? toolCall.input ?? toolCall.arguments ?? params;
      this.pendingPermissions.set(key, {
        id: record.id,
        options,
        toolName,
        input,
      });
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId: key,
          toolName,
          input,
        },
      ];
    }

    if (
      isAcpId(record.id) &&
      this.activePrompt &&
      requestKey(record.id) === requestKey(this.activePrompt.id) &&
      record.method === undefined
    ) {
      return [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }];
    }

    return [];
  }

  observeStdoutChunk(chunk: string): ControlObservation[] {
    return this.client
      .receiveChunk(chunk)
      .flatMap((message) => this.observe(message));
  }

  flushStdout(): ControlObservation[] {
    return this.client
      .receiveChunk("", true)
      .flatMap((message) => this.observe(message));
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    _message?: string
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(
        `Copilot ACP approval request ${requestId} is no longer pending`
      );
    }
    const kind =
      decision === APPROVAL_DECISIONS.ALLOW_ONCE
        ? COPILOT_ACP_PERMISSION_KINDS.ALLOW_ONCE
        : COPILOT_ACP_PERMISSION_KINDS.REJECT_ONCE;
    const optionId = getPermissionOption(pending.options, kind);
    if (!optionId) {
      try {
        await this.client.respondError(
          pending.id,
          -32602,
          `Copilot ACP approval request has no ${kind} option`
        );
      } finally {
        this.pendingPermissions.delete(requestId);
      }
      throw new Error(
        `Copilot ACP approval request ${requestId} has no ${kind} option`
      );
    }
    try {
      await this.client.respond(pending.id, {
        outcome: {
          outcome: COPILOT_ACP_PERMISSION_OUTCOMES.SELECTED,
          optionId,
        },
      });
    } finally {
      this.pendingPermissions.delete(requestId);
    }
  }

  close(): void {
    this.client.close();
    this.pendingPermissions.clear();
  }

  private async readImageContent(): Promise<Record<string, string>[]> {
    const imagePaths = this.options.context?.imageFilePaths ?? [];
    const blocks: Record<string, string>[] = [];
    for (const imagePath of imagePaths) {
      const extension = path.extname(imagePath).slice(1);
      const mimeType = imageExtensionToMimeType(extension);
      if (!mimeType) {
        throw new Error(`Unsupported Copilot ACP image type: ${extension}`);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(imagePath);
      } catch (error) {
        throw new Error(
          `Could not read Copilot ACP image "${imagePath}": ${getErrorMessage(error)}`
        );
      }
      blocks.push({
        type: COPILOT_ACP_CONTENT_TYPES.IMAGE,
        data: bytes.toString("base64"),
        mimeType,
      });
    }
    return blocks;
  }

  private static filterLaunchArgs(args: readonly string[]): string[] {
    const filtered: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (
        argument === COPILOT_CLI_FLAGS.RESUME ||
        argument === COPILOT_CLI_FLAGS.OUTPUT_FORMAT ||
        argument === COPILOT_CLI_FLAGS.PRINT_PROMPT ||
        argument === COPILOT_CLI_FLAGS.PROMPT ||
        argument === COPILOT_CLI_FLAGS.INTERACTIVE
      ) {
        index += 1;
        continue;
      }
      if (
        argument === COPILOT_CLI_FLAGS.ACP ||
        argument.startsWith(`${COPILOT_CLI_FLAGS.RESUME}=`) ||
        argument.startsWith(`${COPILOT_CLI_FLAGS.OUTPUT_FORMAT}=`) ||
        argument.startsWith(`${COPILOT_CLI_FLAGS.PROMPT}=`)
      ) {
        continue;
      }
      filtered.push(argument);
    }
    return filtered;
  }
}

function isAcpId(value: unknown): value is AcpJsonRpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
