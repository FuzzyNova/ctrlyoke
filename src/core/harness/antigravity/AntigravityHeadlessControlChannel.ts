import {
  type ApprovalDecision,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
} from "../../../types/DashboardConstants";
import { isRecord } from "../../../utils/JsonTypeGuards";
import {
  ANTIGRAVITY_STREAM_JSON_EVENTS,
  ANTIGRAVITY_STREAM_JSON_INPUT_EVENTS,
  ANTIGRAVITY_STREAM_JSON_USER_ROLE,
} from "./AntigravityProtocolConstants";
import type {
  ControlObservation,
  ControlWriter,
  IHeadlessControlChannel,
} from "../shared/IHeadlessControlChannel";

/** Antigravity's queue-only stream-json input channel for one headless step. */
export class AntigravityHeadlessControlChannel implements IHeadlessControlChannel {
  readonly spawnShape = {};
  readonly steerDelivery = HEADLESS_STEER_DELIVERIES.QUEUE;
  private writer?: ControlWriter;

  async start(writer: ControlWriter): Promise<void> {
    this.writer = writer;
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.writer) {
      throw new Error("Antigravity headless control channel has not started");
    }

    await this.writer.write(
      `${JSON.stringify({
        event: ANTIGRAVITY_STREAM_JSON_INPUT_EVENTS.USER,
        message: {
          role: ANTIGRAVITY_STREAM_JSON_USER_ROLE,
          content: text,
        },
      })}\n`
    );
  }

  observe(record: unknown): ControlObservation[] {
    if (
      !isRecord(record) ||
      record.event !== ANTIGRAVITY_STREAM_JSON_EVENTS.RESULT
    ) {
      return [];
    }

    return [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }];
  }

  async answerApproval(
    _requestId: string,
    _decision: ApprovalDecision,
    _message?: string
  ): Promise<void> {
    throw new Error(
      "Antigravity stream-json does not support headless approval responses"
    );
  }

  close(): void {
    this.writer = undefined;
  }
}
