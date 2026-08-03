import * as vscode from "vscode";
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
    private readonly api: VsCodeFeedbackApi = vscode.window
  ) {}

  notify(message: UserFeedback): void {
    const text = formatUserFeedback(message);
    switch (message.severity) {
      case "warning":
        this.api.showWarningMessage(text);
        return;
      case "error":
        this.api.showErrorMessage(text);
        return;
      case "info":
      case "success":
        this.api.showInformationMessage(text);
        return;
    }
  }
}
