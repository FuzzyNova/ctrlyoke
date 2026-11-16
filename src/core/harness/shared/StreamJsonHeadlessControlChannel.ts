import { randomUUID } from "crypto";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  type ApprovalDecision,
  type HeadlessSteerDelivery,
} from "../../../types/DashboardConstants";
import { isRecord } from "../../../utils/JsonTypeGuards";
import type {
  ControlObservation,
  ControlWriter,
  IHeadlessControlChannel,
} from "./IHeadlessControlChannel";

export const STREAM_JSON_CONTROL = {
  REQUEST_TYPE: "control_request",
  RESPONSE_TYPE: "control_response",
  USER_TYPE: "user",
  RESULT_TYPE: "result",
  INITIALIZE_SUBTYPE: "initialize",
  CAN_USE_TOOL_SUBTYPE: "can_use_tool",
  SUCCESS_SUBTYPE: "success",
  ERROR_SUBTYPE: "error",
  INTERRUPT_SUBTYPE: "interrupt",
  USER_ROLE: "user",
  ALLOW_BEHAVIOR: "allow",
  DENY_BEHAVIOR: "deny",
} as const;

export interface StreamJsonControlProtocol {
  requestType: string;
  responseType: string;
  canUseToolSubtype: string;
  successSubtype: string;
  denyBehavior: string;
  resultType: string;
  modelQuestionToolNames: readonly string[];
}

/** Shared stream-json control messages used by Claude and Qwen. */
export abstract class StreamJsonHeadlessControlChannel implements IHeadlessControlChannel {
  readonly spawnShape = {};
  protected writer?: ControlWriter;
  private interruptRequested = false;
  private readonly pendingToolInputs = new Map<string, unknown>();

  constructor(
    private readonly protocol: StreamJsonControlProtocol,
    readonly steerDelivery: HeadlessSteerDelivery
  ) {}

  async start(writer: ControlWriter): Promise<void> {
    this.writer = writer;
  }

  protected abstract createUserMessageRecord(
    text: string
  ): Record<string, unknown>;

  async sendUserMessage(text: string): Promise<void> {
    await this.writeRecord(this.createUserMessageRecord(text));
  }

  observe(record: unknown): ControlObservation[] {
    if (!isRecord(record)) return [];

    if (
      record.type === this.protocol.requestType &&
      isRecord(record.request) &&
      record.request.subtype === this.protocol.canUseToolSubtype &&
      typeof record.request_id === "string"
    ) {
      const toolName =
        typeof record.request.tool_name === "string"
          ? record.request.tool_name
          : "Unknown tool";
      if (this.protocol.modelQuestionToolNames.includes(toolName)) {
        return [
          {
            kind: HEADLESS_CONTROL_OBSERVATION_KINDS.MODEL_QUESTION,
            requestId: record.request_id,
          },
        ];
      }
      const input = record.request.input;
      this.pendingToolInputs.set(record.request_id, input);
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId: record.request_id,
          toolName,
          input,
        },
      ];
    }

    if (record.type === this.protocol.resultType) {
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END,
          ...(this.interruptRequested ? { interrupted: true } : {}),
        },
      ];
    }
    return [];
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void> {
    const pendingInput = this.pendingToolInputs.get(requestId);
    const response =
      decision === APPROVAL_DECISIONS.ALLOW_ONCE
        ? {
            behavior: STREAM_JSON_CONTROL.ALLOW_BEHAVIOR,
            updatedInput: isRecord(pendingInput) ? pendingInput : {},
          }
        : {
            behavior: this.protocol.denyBehavior,
            ...(message ? { message } : {}),
          };
    try {
      await this.writeRecord({
        type: this.protocol.responseType,
        response: {
          subtype: this.protocol.successSubtype,
          request_id: requestId,
          response,
        },
      });
    } finally {
      this.pendingToolInputs.delete(requestId);
    }
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true;
    try {
      await this.writeRecord({
        type: this.protocol.requestType,
        request_id: randomUUID(),
        request: { subtype: STREAM_JSON_CONTROL.INTERRUPT_SUBTYPE },
      });
    } catch (error) {
      this.interruptRequested = false;
      throw error;
    }
  }

  close(): void {
    this.writer = undefined;
    this.pendingToolInputs.clear();
  }

  protected async writeRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.writer) {
      throw new Error("Headless stream-json control channel has not started");
    }
    await this.writer.write(`${JSON.stringify(record)}\n`);
  }
}
