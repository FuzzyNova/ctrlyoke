import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import type { ToastOptions } from "@store/uiStore";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  type UserFeedbackSeverity,
} from "@root/types/DashboardConstants";
import { WebviewLog } from "@utils/logger";

/**
 * Every toast the dashboard shows the user also lands in the session log at
 * its own severity, so callers never log before notifying. `WebviewLog`
 * forwards to the extension host, which writes it as `[<client>] …`. The host
 * does not log these again: `SHOW_NATIVE_FEEDBACK` goes straight to its sink.
 */
function logShownToast(
  message: string,
  severity: UserFeedbackSeverity,
  detail?: string
): void {
  const line = detail ? `[Toast] ${message}\n${detail}` : `[Toast] ${message}`;
  switch (severity) {
    case USER_FEEDBACK_SEVERITY.ERROR:
      WebviewLog.error(line);
      return;
    case USER_FEEDBACK_SEVERITY.WARNING:
      WebviewLog.warn(line);
      return;
    case USER_FEEDBACK_SEVERITY.INFO:
    case USER_FEEDBACK_SEVERITY.SUCCESS:
      WebviewLog.info(line);
      return;
  }
}

/** Route webview-originated feedback to the current host's feedback surface. */
export function notifyUser(
  message: string,
  severity: UserFeedbackSeverity,
  detail?: string
): void {
  logShownToast(message, severity, detail);
  if (isStandalone) {
    useUiStore.getState().showToast(message, severity, { detail });
    return;
  }

  getVsCodeApi().postMessage({
    type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
    severity,
    message,
    detail,
  });
}

/** Show an in-app toast that may include a webview-only action callback. */
export function showWebviewToast(
  message: string,
  severity: UserFeedbackSeverity,
  options?: ToastOptions
): void {
  logShownToast(message, severity, options?.detail);
  useUiStore.getState().showToast(message, severity, options);
}
