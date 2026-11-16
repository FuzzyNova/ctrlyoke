import { randomUUID } from "crypto";
import {
  APPROVAL_DECISIONS,
  HEADLESS_CONTROL_OBSERVATION_KINDS,
  HEADLESS_STEER_DELIVERIES,
  FAILURE_KINDS,
  FAILURE_SOURCES,
  type ApprovalDecision,
} from "../../../types/DashboardConstants";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { CliTransportError } from "../shared/CliTransportError";
import type {
  ControlObservation,
  ControlWriter,
  IHeadlessControlChannel,
} from "../shared/IHeadlessControlChannel";
import {
  QWEN_CONTROL,
  QWEN_EVENT_TYPES,
  QWEN_INITIALIZE_TIMEOUT_MS,
} from "./QwenProtocolConstants";

/** Qwen Code's stream-json SDK channel for one headless step. */
export class QwenHeadlessControlChannel implements IHeadlessControlChannel {
  readonly spawnShape = {};
  readonly steerDelivery = HEADLESS_STEER_DELIVERIES.QUEUE;

  private writer?: ControlWriter;
  private initializeRequestId?: string;
  private initializeResolve?: () => void;
  private initializeReject?: (error: Error) => void;
  private initializeTimer?: ReturnType<typeof setTimeout>;
  private readonly userSessionId = randomUUID();

  constructor(
    private readonly initializeTimeoutMs = QWEN_INITIALIZE_TIMEOUT_MS
  ) {}

  async start(writer: ControlWriter): Promise<void> {
    this.writer = writer;
    const requestId = randomUUID();
    this.initializeRequestId = requestId;

    const initialized = new Promise<void>((resolve, reject) => {
      this.initializeResolve = resolve;
      this.initializeReject = reject;
      this.initializeTimer = setTimeout(() => {
        this.finishInitialize(
          new CliTransportError(
            `Qwen Code did not answer the headless initialize request within ${this.initializeTimeoutMs}ms`,
            FAILURE_KINDS.HARNESS_ERROR,
            undefined,
            FAILURE_SOURCES.HEADLESS_PARSE
          )
        );
      }, this.initializeTimeoutMs);
    });

    try {
      await writer.write(
        `${JSON.stringify({
          type: QWEN_CONTROL.REQUEST_TYPE,
          request_id: requestId,
          request: { subtype: QWEN_CONTROL.INITIALIZE_SUBTYPE },
        })}\n`
      );
      await initialized;
    } catch (error) {
      this.clearInitializeWait();
      throw error;
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.writer) {
      throw new Error("Qwen headless control channel has not started");
    }
    await this.writer.write(
      `${JSON.stringify({
        type: QWEN_CONTROL.USER_TYPE,
        session_id: this.userSessionId,
        message: { role: QWEN_CONTROL.USER_ROLE, content: text },
        parent_tool_use_id: null,
      })}\n`
    );
  }

  observe(record: unknown): ControlObservation[] {
    if (!isRecord(record)) return [];

    if (record.type === QWEN_CONTROL.RESPONSE_TYPE) {
      const response = isRecord(record.response) ? record.response : undefined;
      const requestId =
        (typeof record.request_id === "string" && record.request_id) ||
        (typeof response?.request_id === "string" && response.request_id);
      if (requestId && requestId === this.initializeRequestId) {
        if (
          response?.subtype === QWEN_CONTROL.ERROR_SUBTYPE ||
          record.subtype === QWEN_CONTROL.ERROR_SUBTYPE
        ) {
          this.finishInitialize(
            new CliTransportError(
              "Qwen Code rejected the headless initialize request",
              FAILURE_KINDS.HARNESS_ERROR,
              undefined,
              FAILURE_SOURCES.HEADLESS_PARSE
            )
          );
        } else {
          this.finishInitialize();
        }
      }
      return [];
    }

    if (
      record.type === QWEN_CONTROL.REQUEST_TYPE &&
      isRecord(record.request) &&
      record.request.subtype === QWEN_CONTROL.CAN_USE_TOOL_SUBTYPE &&
      typeof record.request_id === "string"
    ) {
      return [
        {
          kind: HEADLESS_CONTROL_OBSERVATION_KINDS.APPROVAL_REQUEST,
          requestId: record.request_id,
        },
      ];
    }

    if (record.type === QWEN_EVENT_TYPES.RESULT) {
      return [{ kind: HEADLESS_CONTROL_OBSERVATION_KINDS.TURN_END }];
    }
    return [];
  }

  async answerApproval(
    requestId: string,
    decision: ApprovalDecision,
    message?: string
  ): Promise<void> {
    if (!this.writer) {
      throw new Error("Qwen headless control channel has not started");
    }
    if (decision !== APPROVAL_DECISIONS.DENY) {
      throw new Error("Qwen headless approvals only support deny in Stage 1");
    }
    await this.writer.write(
      `${JSON.stringify({
        type: QWEN_CONTROL.RESPONSE_TYPE,
        response: {
          subtype: QWEN_CONTROL.SUCCESS_SUBTYPE,
          request_id: requestId,
          response: {
            behavior: QWEN_CONTROL.DENY_BEHAVIOR,
            message,
          },
        },
      })}\n`
    );
  }

  close(): void {
    this.clearInitializeWait();
    this.writer = undefined;
  }

  private finishInitialize(error?: Error): void {
    const resolve = this.initializeResolve;
    const reject = this.initializeReject;
    this.clearInitializeWait();
    if (error) reject?.(error);
    else resolve?.();
  }

  private clearInitializeWait(): void {
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    this.initializeTimer = undefined;
    this.initializeResolve = undefined;
    this.initializeReject = undefined;
  }
}
