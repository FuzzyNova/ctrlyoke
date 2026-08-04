import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Log } from "./Log";
import { USER_FEEDBACK_SEVERITY } from "../types/DashboardConstants";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";
import { pathsEqual } from "./PathCasing";

/**
 * Read a JSON file and parse it.
 * Throws if the file cannot be read or the content is not valid JSON.
 *
 * @param filePath Absolute path to JSON file
 * @returns Parsed JSON data
 */
export async function readJsonFile(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content);
}

/**
 * Save a file if it is open in a VS Code editor with unsaved changes.
 * No-op if the file is not open or is already saved.
 *
 * @param filePath Absolute path to the file
 */
export async function saveIfDirty(
  filePath: string,
  userFeedbackSink?: UserFeedbackSink
): Promise<void> {
  const openDocument = vscode.workspace.textDocuments.find((doc) =>
    pathsEqual(doc.uri.fsPath, filePath)
  );
  if (openDocument?.isDirty) {
    Log.info(`Auto-saving dirty file: ${filePath}`);
    try {
      await openDocument.save();
    } catch (error) {
      Log.error("Failed to auto-save file:", error);
      notifyUserFeedback(
        userFeedbackSink,
        USER_FEEDBACK_SEVERITY.WARNING,
        "ctrlyoke: Could not auto-save file. Running with last saved version."
      );
    }
  }
}
