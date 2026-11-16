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
  USER_ROLE: "user",
  DENY_BEHAVIOR: "deny",
} as const;

export interface StreamJsonControlProtocol {
  requestType: string;
  responseType: string;
  canUseToolSubtype: string;
  successSubtype: string;
  denyBehavior: string;
  resultType: string;
}

/** Shared stream-json control messages used by Claude and Qwen. */
export abstract class StreamJsonHeadlessControlChannel
  implements IHeadlessControlChannel
{
  readonly spawnShape = {};
  protected writer?: ControlWriter;

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
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId: record.request_id,
        },
      ];
    }

    if (record.type === this.protocol.resultType) {
      return [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }];
    }
    return [];
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void> {
    if (decision !== APPROVAL_DECISIONS.DENY) {
      throw new Error("Headless stream-json approvals only support deny");
    }
    await this.writeRecord({
      type: this.protocol.responseType,
      response: {
        subtype: this.protocol.successSubtype,
        request_id: requestId,
        response: {
          behavior: this.protocol.denyBehavior,
          message,
        },
      },
    });
  }

  close(): void {
    this.writer = undefined;
  }

  protected async writeRecord(record: Record<string, unknown>): Promise<void> {
    if (!this.writer) {
      throw new Error("Headless stream-json control channel has not started");
    }
    await this.writer.write(`${JSON.stringify(record)}\n`);
  }
}
