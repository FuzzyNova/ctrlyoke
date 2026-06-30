import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Log } from "./Log";

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
 * Read JSON file, parse it, and delete it immediately.
 * Returns parsed data or null on any failure.
 *
 * Useful for reading notification/hook files that should be cleaned up after reading.
 *
 * @param filePath Absolute path to JSON file
 * @returns Parsed JSON data, or null if file doesn't exist or is invalid
 */
export async function readJsonFileAndDelete(
  filePath: string
): Promise<unknown | null> {
  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    return null;
  }

  try {
    // Read and parse JSON file
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);

    // Delete file immediately after reading
    try {
      await fs.unlink(filePath);
      Log.debug("🗑️ Cleaned up notification file");
    } catch (cleanupError) {
      Log.debug(`Failed to clean up notification file: ${cleanupError}`);
    }

    return data;
  } catch (error) {
    Log.debug(`Failed to read/parse notification file: ${error}`);
    return null;
  }
}

/**
 * Save a file if it is open in a VS Code editor with unsaved changes.
 * No-op if the file is not open or is already saved.
 *
 * @param filePath Absolute path to the file
 */
export async function saveIfDirty(filePath: string): Promise<void> {
  const openDocument = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.fsPath === filePath
  );
  if (openDocument?.isDirty) {
    Log.info(`Auto-saving dirty file: ${filePath}`);
    try {
      await openDocument.save();
    } catch (error) {
      Log.error("Failed to auto-save file:", error);
      vscode.window.showWarningMessage(
        "ctrlyoke: Could not auto-save file. Running with last saved version."
      );
    }
  }
}
