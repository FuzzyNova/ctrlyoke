import * as vscode from "vscode";
import { USER_FEEDBACK_SEVERITY } from "../types/DashboardConstants";
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
  constructor(private readonly api: VsCodeFeedbackApi = vscode.window) {}

  notify(message: UserFeedback): void {
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
