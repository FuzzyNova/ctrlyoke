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
 * Every error the dashboard shows the user also lands in the session log, so
 * callers never log before notifying. `WebviewLog` forwards to the extension
 * host, which writes it as `[<client>] …`.
 */
function logShownError(
  message: string,
  severity: UserFeedbackSeverity,
  detail?: string
): void {
  if (severity !== USER_FEEDBACK_SEVERITY.ERROR) return;
  WebviewLog.error(
    detail ? `[Toast] ${message}\n${detail}` : `[Toast] ${message}`
  );
}

/** Route webview-originated feedback to the current host's feedback surface. */
export function notifyUser(
  message: string,
  severity: UserFeedbackSeverity,
  detail?: string
): void {
  logShownError(message, severity, detail);
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
  logShownError(message, severity, options?.detail);
  useUiStore.getState().showToast(message, severity, options);
}
