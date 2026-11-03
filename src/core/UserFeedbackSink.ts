import {
  USER_FEEDBACK_ACTIONS,
  USER_FEEDBACK_SEVERITY,
  type UserFeedbackSeverity,
} from "../types/DashboardConstants";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";

/** Operational feedback that must remain visible regardless of notification settings. */
export interface UserFeedback {
  severity: UserFeedbackSeverity;
  message: string;
  detail?: string;
  dedupeKey?: string;
  action?: (typeof USER_FEEDBACK_ACTIONS)[keyof typeof USER_FEEDBACK_ACTIONS];
}

export function formatUserFeedback(
  message: Pick<UserFeedback, "message" | "detail">
): string {
  return message.detail
    ? `${message.message}\n${message.detail}`
    : message.message;
}

/** Host-provided destination for operational user feedback. */
export interface UserFeedbackSink {
  notify(message: UserFeedback): void;
}

/**
 * Write feedback the user is shown to the session log at its own severity, so
 * every toast or notification can be traced from the log. Callers that notify
 * through {@link emitUserFeedback}/{@link notifyUserFeedback} must not also log
 * the same message; pass the caught `error` instead so its stack is kept.
 *
 * The line is written even when the host's toast level hides the toast: the
 * feedback was still raised. Sinks never log, because the dashboard's own
 * toasts reach the native sink already logged by `notifyUser`.
 */
export function logUserFeedback(
  feedback: Pick<UserFeedback, "severity" | "message" | "detail">,
  error?: unknown
): void {
  const text = formatUserFeedback(feedback);
  let line = `[Toast] ${text}`;
  if (error !== undefined) {
    const errorText = getErrorMessage(error);
    if (errorText && !text.includes(errorText)) line += `: ${errorText}`;
    if (error instanceof Error && error.stack) {
      line += `\nStack trace: ${error.stack}`;
    }
  }
  switch (feedback.severity) {
    case USER_FEEDBACK_SEVERITY.ERROR:
      Log.error(line);
      return;
    case USER_FEEDBACK_SEVERITY.WARNING:
      Log.warn(line);
      return;
    case USER_FEEDBACK_SEVERITY.INFO:
    case USER_FEEDBACK_SEVERITY.SUCCESS:
      Log.info(line);
      return;
  }
}

/**
 * Log operational feedback, then emit it when the current host has a feedback
 * surface. Use this rather than `sink.notify()` whenever the feedback needs a
 * `dedupeKey` or `action`.
 */
export function emitUserFeedback(
  sink: UserFeedbackSink | undefined,
  feedback: UserFeedback,
  error?: unknown
): void {
  logUserFeedback(feedback, error);
  sink?.notify(feedback);
}

/**
 * Log operational feedback, then emit it when the current host has a feedback
 * surface. Pass the caught `error` instead of logging it separately.
 */
export function notifyUserFeedback(
  sink: UserFeedbackSink | undefined,
  severity: UserFeedbackSeverity,
  message: string,
  detail?: string,
  error?: unknown
): void {
  emitUserFeedback(
    sink,
    {
      severity,
      message,
      ...(detail === undefined ? {} : { detail }),
    },
    error
  );
}
