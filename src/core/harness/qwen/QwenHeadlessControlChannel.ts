import { randomUUID } from "crypto";
import {
  HEADLESS_STEER_DELIVERIES,
  FAILURE_KINDS,
  FAILURE_SOURCES,
} from "../../../types/DashboardConstants";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { CliTransportError } from "../shared/CliTransportError";
import type { ControlWriter } from "../shared/IHeadlessControlChannel";
import { StreamJsonHeadlessControlChannel } from "../shared/StreamJsonHeadlessControlChannel";
import {
  QWEN_CONTROL,
  QWEN_EVENT_TYPES,
  QWEN_INITIALIZE_TIMEOUT_MS,
} from "./QwenProtocolConstants";

/** Qwen Code's stream-json SDK channel for one headless step. */
export class QwenHeadlessControlChannel extends StreamJsonHeadlessControlChannel {
  private initializeRequestId?: string;
  private initializeResolve?: () => void;
  private initializeReject?: (error: Error) => void;
  private initializeTimer?: ReturnType<typeof setTimeout>;
  private readonly userSessionId = randomUUID();

  constructor(
    private readonly initializeTimeoutMs = QWEN_INITIALIZE_TIMEOUT_MS
  ) {
    super(
      {
        requestType: QWEN_CONTROL.REQUEST_TYPE,
        responseType: QWEN_CONTROL.RESPONSE_TYPE,
        canUseToolSubtype: QWEN_CONTROL.CAN_USE_TOOL_SUBTYPE,
        successSubtype: QWEN_CONTROL.SUCCESS_SUBTYPE,
        denyBehavior: QWEN_CONTROL.DENY_BEHAVIOR,
        resultType: QWEN_EVENT_TYPES.RESULT,
      },
      HEADLESS_STEER_DELIVERIES.QUEUE
    );
  }

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
      await this.writeRecord({
        type: QWEN_CONTROL.REQUEST_TYPE,
        request_id: requestId,
        request: { subtype: QWEN_CONTROL.INITIALIZE_SUBTYPE },
      });
      await initialized;
    } catch (error) {
      this.clearInitializeWait();
      throw error;
    }
  }

  protected createUserMessageRecord(text: string): Record<string, unknown> {
    return {
      type: QWEN_CONTROL.USER_TYPE,
      session_id: this.userSessionId,
      message: { role: QWEN_CONTROL.USER_ROLE, content: text },
      parent_tool_use_id: null,
    };
  }

  override observe(record: unknown) {
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
    }
    return super.observe(record);
  }

  override close(): void {
    this.clearInitializeWait();
    super.close();
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
