import { randomUUID } from "crypto";
import {
  FAILURE_KINDS,
  FAILURE_SOURCES,
  HEADLESS_STEER_DELIVERIES,
} from "../../../types/DashboardConstants";
import {
  type ControlWriter,
  type HeadlessControlChannelOptions,
} from "../shared/IHeadlessControlChannel";
import { CliTransportError } from "../shared/CliTransportError";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { StreamJsonHeadlessControlChannel } from "../shared/StreamJsonHeadlessControlChannel";
import {
  CLAUDE_CONTROL,
  CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS,
} from "./ClaudeProtocolConstants";

/** Claude Code's stream-json input channel for one headless step. */
export class ClaudeHeadlessControlChannel extends StreamJsonHeadlessControlChannel {
  private initializeRequestId?: string;
  private initializeResolve?: () => void;
  private initializeReject?: (error: Error) => void;
  private initializeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options?: HeadlessControlChannelOptions) {
    super(
      {
        requestType: CLAUDE_CONTROL.REQUEST_TYPE,
        responseType: CLAUDE_CONTROL.RESPONSE_TYPE,
        canUseToolSubtype: CLAUDE_CONTROL.CAN_USE_TOOL_SUBTYPE,
        successSubtype: CLAUDE_CONTROL.SUCCESS_SUBTYPE,
        denyBehavior: CLAUDE_CONTROL.DENY_BEHAVIOR,
        resultType: CLAUDE_CONTROL.RESULT_TYPE,
        modelQuestionToolNames: [CLAUDE_CONTROL.ASK_USER_QUESTION_TOOL],
      },
      HEADLESS_STEER_DELIVERIES.INJECT
    );
  }

  override async start(writer: ControlWriter): Promise<void> {
    await super.start(writer);
    if (!this.options?.useApprovalControl) return;

    const requestId = randomUUID();
    this.initializeRequestId = requestId;
    const initialized = new Promise<void>((resolve, reject) => {
      this.initializeResolve = resolve;
      this.initializeReject = reject;
      this.initializeTimer = setTimeout(() => {
        this.finishInitialize(
          new CliTransportError(
            `Claude Code did not answer the headless initialize request within ${CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS}ms`,
            FAILURE_KINDS.HARNESS_ERROR,
            undefined,
            FAILURE_SOURCES.HEADLESS_PARSE
          )
        );
      }, CLAUDE_CONTROL_INITIALIZE_TIMEOUT_MS);
    });

    try {
      await this.writeRecord({
        type: CLAUDE_CONTROL.REQUEST_TYPE,
        request_id: requestId,
        request: { subtype: CLAUDE_CONTROL.INITIALIZE_SUBTYPE },
      });
      await initialized;
    } catch (error) {
      this.clearInitializeWait();
      throw error;
    }
  }

  protected createUserMessageRecord(text: string): Record<string, unknown> {
    return {
      type: CLAUDE_CONTROL.USER_TYPE,
      message: { role: CLAUDE_CONTROL.USER_ROLE, content: text },
      parent_tool_use_id: null,
    };
  }

  override observe(record: unknown) {
    if (
      isRecord(record) &&
      record.type === CLAUDE_CONTROL.RESPONSE_TYPE &&
      isRecord(record.response)
    ) {
      const requestId =
        (typeof record.request_id === "string" && record.request_id) ||
        (typeof record.response.request_id === "string" &&
          record.response.request_id);
      if (requestId && requestId === this.initializeRequestId) {
        if (
          record.response.subtype === CLAUDE_CONTROL.ERROR_SUBTYPE ||
          record.subtype === CLAUDE_CONTROL.ERROR_SUBTYPE
        ) {
          this.finishInitialize(
            new CliTransportError(
              "Claude Code rejected the headless initialize request",
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
    this.finishInitialize(
      new CliTransportError(
        "Claude Code headless initialize was interrupted",
        FAILURE_KINDS.USER_CANCELLED,
        undefined,
        FAILURE_SOURCES.HEADLESS_PARSE
      )
    );
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
