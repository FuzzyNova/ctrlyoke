import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import type { ToastOptions } from "@store/uiStore";
import {
  MESSAGE_TYPES,
  type UserFeedbackSeverity,
} from "@root/types/DashboardConstants";

/** Route webview-originated feedback to the current host's feedback surface. */
export function notifyUser(
  message: string,
  severity: UserFeedbackSeverity,
  detail?: string
): void {
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
  useUiStore.getState().showToast(message, severity, options);
}
