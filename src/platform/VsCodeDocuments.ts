import * as vscode from "vscode";
import { Log } from "../utils/Log";
import {
  USER_FEEDBACK_SEVERITY,
  VSCODE_URI_SCHEMES,
} from "../types/DashboardConstants";
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
  const dirtyDocument = await findDirtyDocument(filePath);
  if (!dirtyDocument) return;

  Log.info(`[VsCodeDocuments] Auto-saving dirty file: ${filePath}`);
  try {
    await dirtyDocument.save();
  } catch (error) {
    Log.error("[VsCodeDocuments] Failed to auto-save file:", error);
    notifyUserFeedback(
      userFeedbackSink,
      USER_FEEDBACK_SEVERITY.WARNING,
      "ctrlyoke: Could not auto-save file. Running with last saved version."
    );
  }
}

/** Whether `uri` is the on-disk file (not, say, a `git:` diff side of it). */
function isFileUri(uri: vscode.Uri, filePath: string): boolean {
  return (
    uri.scheme === VSCODE_URI_SCHEMES.FILE && pathsEqual(uri.fsPath, filePath)
  );
}

/**
 * The document holding unsaved changes to `filePath`, if any.
 *
 * `workspace.textDocuments` is only the extension host's mirror of the open
 * models, and a dirty document has been seen missing from it while still
 * dirty (dev/bugs: vscode-documents-dirty-save-test-flake). Skipping the save
 * then would run a workflow on stale contents, so before concluding the file
 * is not open this also checks visible editors and editor tabs. A dirty tab is
 * reopened with `openTextDocument`, which returns the editor's existing model,
 * unsaved changes included; a file that is not open is never loaded.
 */
async function findDirtyDocument(
  filePath: string
): Promise<vscode.TextDocument | undefined> {
  const known = [
    ...vscode.workspace.textDocuments,
    ...vscode.window.visibleTextEditors.map((editor) => editor.document),
  ].find((document) => !document.isClosed && isFileUri(document.uri, filePath));
  if (known) return known.isDirty ? known : undefined;

  const dirtyTabUri = findDirtyTabUri(filePath);
  if (!dirtyTabUri) return undefined;
  Log.warn(
    `[VsCodeDocuments] Dirty editor tab has no open document; reopening it to save: ${filePath}`
  );
  const reopened = await vscode.workspace.openTextDocument(dirtyTabUri);
  return reopened.isDirty ? reopened : undefined;
}

function findDirtyTabUri(filePath: string): vscode.Uri | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!tab.isDirty) continue;
      const uri =
        tab.input instanceof vscode.TabInputText
          ? tab.input.uri
          : tab.input instanceof vscode.TabInputTextDiff
            ? tab.input.modified
            : undefined;
      if (uri && isFileUri(uri, filePath)) return uri;
    }
  }
  return undefined;
}
