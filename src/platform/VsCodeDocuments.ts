import * as vscode from "vscode";
import { Log } from "../utils/Log";
import { USER_FEEDBACK_SEVERITY } from "../types/DashboardConstants";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";
import { pathsEqual } from "../utils/PathCasing";

/** Save a file when its open VS Code document contains unsaved changes. */
export async function saveIfDirty(
  filePath: string,
  userFeedbackSink?: UserFeedbackSink
): Promise<void> {
  const openDocument = vscode.workspace.textDocuments.find((doc) =>
    pathsEqual(doc.uri.fsPath, filePath)
  );
  if (!openDocument?.isDirty) return;

  Log.info(`[VsCodeDocuments] Auto-saving dirty file: ${filePath}`);
  try {
    await openDocument.save();
  } catch (error) {
    Log.error("[VsCodeDocuments] Failed to auto-save file:", error);
    notifyUserFeedback(
      userFeedbackSink,
      USER_FEEDBACK_SEVERITY.WARNING,
      "ctrlyoke: Could not auto-save file. Running with last saved version."
    );
  }
}
