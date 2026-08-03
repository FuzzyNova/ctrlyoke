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

/** Emit operational feedback when the current host has a feedback surface. */
export function notifyUserFeedback(
  sink: UserFeedbackSink | undefined,
  severity: UserFeedbackSeverity,
  message: string,
  detail?: string
): void {
  sink?.notify({
    severity,
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}
