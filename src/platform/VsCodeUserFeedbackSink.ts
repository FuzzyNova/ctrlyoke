import * as vscode from "vscode";
import { configService } from "../config/CtrlYokeConfigService";
import {
  meetsToastLevel,
  TOAST_LEVEL_MODES,
  USER_FEEDBACK_SEVERITY,
  type ToastLevelMode,
} from "../types/DashboardConstants";
import {
  formatUserFeedback,
  type UserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";

interface VsCodeFeedbackApi {
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
  showErrorMessage(message: string): unknown;
}

/** Delivers operational feedback through the native VS Code message APIs. */
export class VsCodeUserFeedbackSink implements UserFeedbackSink {
  constructor(
    private readonly api: VsCodeFeedbackApi = vscode.window,
    private readonly resolveToastLevel: () => ToastLevelMode = () =>
      configService.getAll().notifications?.toastLevel ?? TOAST_LEVEL_MODES.ALL
  ) {}

  notify(message: UserFeedback): void {
    if (!meetsToastLevel(message.severity, this.resolveToastLevel())) return;

    const text = formatUserFeedback(message);
    switch (message.severity) {
      case USER_FEEDBACK_SEVERITY.WARNING:
        this.api.showWarningMessage(text);
        return;
      case USER_FEEDBACK_SEVERITY.ERROR:
        this.api.showErrorMessage(text);
        return;
      case USER_FEEDBACK_SEVERITY.INFO:
      case USER_FEEDBACK_SEVERITY.SUCCESS:
        this.api.showInformationMessage(text);
        return;
    }
  }
}
