import type { UserFeedbackSeverity } from "../types/DashboardConstants";

/** Operational feedback that must remain visible regardless of notification settings. */
export interface UserFeedback {
  severity: UserFeedbackSeverity;
  message: string;
  detail?: string;
  dedupeKey?: string;
}

export function formatUserFeedback(message: UserFeedback): string {
  return message.detail
    ? `${message.message}\n${message.detail}`
    : message.message;
}

/** Host-provided destination for operational user feedback. */
export interface UserFeedbackSink {
  notify(message: UserFeedback): void;
}
