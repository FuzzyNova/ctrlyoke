import * as vscode from "vscode";
import { configService } from "../config/CtrlYokeConfigService";
import {
  meetsToastLevel,
  TOAST_LEVEL_MODES,
  USER_FEEDBACK_SEVERITY,
  type ToastLevelMode,
} from "../types/DashboardConstants";
import {
  EXTENSION_IDENTIFIERS,
  USER_FEEDBACK_ACTIONS,
} from "../types/DashboardConstants";
import {
  formatUserFeedback,
  type UserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";

interface VsCodeFeedbackApi {
  showInformationMessage(message: string): unknown;
  showWarningMessage(message: string): unknown;
  showErrorMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined> | unknown;
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
        if (message.action === USER_FEEDBACK_ACTIONS.UPDATE_EXTENSION) {
          void Promise.resolve(this.api.showErrorMessage(text, "Update")).then(
            (action) => {
              if (action === "Update") {
                void vscode.commands.executeCommand(
                  "workbench.view.extensions",
                  `@id:${EXTENSION_IDENTIFIERS.ID}`
                );
              }
            }
          );
        } else {
          this.api.showErrorMessage(text);
        }
        return;
      case USER_FEEDBACK_SEVERITY.INFO:
      case USER_FEEDBACK_SEVERITY.SUCCESS:
        this.api.showInformationMessage(text);
        return;
    }
  }
}
