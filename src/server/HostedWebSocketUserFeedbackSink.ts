import { randomUUID } from "crypto";
import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type { UserFeedbackMessage } from "../types/WebviewMessageTypes";
import type { UserFeedback, UserFeedbackSink } from "../core/UserFeedbackSink";

/** Broadcasts operational feedback to hosted browser WebSocket clients. */
export class HostedWebSocketUserFeedbackSink implements UserFeedbackSink {
  constructor(
    private readonly broadcast: (message: UserFeedbackMessage) => void
  ) {}

  notify(message: UserFeedback): void {
    const payload: UserFeedbackMessage = {
      type: MESSAGE_TYPES.USER_FEEDBACK,
      id: randomUUID(),
      severity: message.severity,
      message: message.message,
    };
    if (message.detail !== undefined) {
      payload.detail = message.detail;
    }
    if (message.dedupeKey !== undefined) {
      payload.dedupeKey = message.dedupeKey;
    }
    this.broadcast(payload);
  }
}
