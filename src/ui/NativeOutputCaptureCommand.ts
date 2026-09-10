import * as vscode from "vscode";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";
import { savePendingOutputSnapshot } from "./OutputSnapshotService";

type NativeOutputCaptureDocument = Pick<
  vscode.TextDocument,
  "getText" | "offsetAt" | "positionAt"
>;

type NativeOutputCaptureEditor = Pick<
  vscode.TextEditor,
  "document" | "selection" | "edit"
>;

type SaveOutputSnapshot = (captureId: string) => Promise<string>;
type ReportError = (message: string) => void | Thenable<unknown>;

function findOutputPlaceholderRange(
  document: NativeOutputCaptureDocument,
  cursor: vscode.Position
): vscode.Range | undefined {
  const documentText = document.getText();
  const cursorOffset = Math.min(
    Math.max(document.offsetAt(cursor), 0),
    documentText.length
  );
  const textBeforeCursor = documentText.slice(0, cursorOffset);
  const placeholderStart = textBeforeCursor.lastIndexOf(
    CAPTURING_OUTPUT_PLACEHOLDER
  );
  if (placeholderStart < 0) {
    return undefined;
  }

  const placeholderEnd = Math.min(
    placeholderStart + CAPTURING_OUTPUT_PLACEHOLDER.length,
    documentText.length,
    cursorOffset
  );
  if (
    placeholderEnd - placeholderStart !==
    CAPTURING_OUTPUT_PLACEHOLDER.length
  ) {
    return undefined;
  }

  // VS Code's completion range (calculateCompletionRange) starts right after
  // the `@`/`#` trigger character, so that character is still sitting in the
  // document immediately before the placeholder. The resolved reference is
  // always a fresh `@<path>` (see executeNativeOutputCaptureCommand below),
  // so fold that leading trigger character into the replaced range too — or
  // picking this completion via `#` leaves a stray `#` before the inserted
  // `@path`, and picking it via `@` doubles it to `@@path`.
  let placeholderRangeStart = placeholderStart;
  const precedingChar = documentText[placeholderStart - 1];
  if (precedingChar === "@" || precedingChar === "#") {
    placeholderRangeStart -= 1;
  }

  return new vscode.Range(
    document.positionAt(placeholderRangeStart),
    document.positionAt(placeholderEnd)
  );
}

/**
 * Resolve a native-editor output completion after VS Code inserts its
 * placeholder. The cursor is the only stable anchor VS Code exposes to the
 * completion command, so search backward for the exact placeholder text.
 */
export async function executeNativeOutputCaptureCommand(
  captureId: unknown,
  editor: NativeOutputCaptureEditor | undefined,
  saveOutputSnapshot: SaveOutputSnapshot,
  reportError: ReportError
): Promise<void> {
  let placeholderRange: vscode.Range | undefined;
  try {
    if (typeof captureId !== "string" || !captureId) {
      throw new Error("Missing output capture id");
    }
    if (!editor) {
      throw new Error("No active text editor");
    }

    placeholderRange = findOutputPlaceholderRange(
      editor.document,
      editor.selection.active
    );
    if (!placeholderRange) {
      throw new Error("Output capture placeholder was not found");
    }

    const relativePath = await saveOutputSnapshot(captureId);
    const applied = await editor.edit((editBuilder) => {
      editBuilder.replace(placeholderRange!, `@${relativePath} `);
    });
    if (!applied) {
      throw new Error("Could not replace the output capture placeholder");
    }
  } catch (error) {
    if (editor && placeholderRange) {
      try {
        await editor.edit((editBuilder) => {
          editBuilder.replace(placeholderRange!, "");
        });
      } catch (cleanupError) {
        Log.error(
          `[NativeOutputCaptureCommand] Failed to remove output capture placeholder: ${getErrorMessage(
            cleanupError
          )}`
        );
      }
    }

    const errorMessage = getErrorMessage(error);
    const userMessage = `ctrlyoke: Failed to capture output: ${errorMessage}`;
    Log.error(userMessage);
    await reportError(userMessage);
  }
}

/** Register the command VS Code runs after a captured completion is inserted. */
export function registerNativeOutputCaptureCommand(
  getWorkspaceRoot: () => string,
  reportError: ReportError,
  saveOutputSnapshot: SaveOutputSnapshot = (captureId) =>
    savePendingOutputSnapshot(getWorkspaceRoot, captureId)
): vscode.Disposable {
  return vscode.commands.registerCommand(
    VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE,
    async (captureId: unknown) => {
      await executeNativeOutputCaptureCommand(
        captureId,
        vscode.window.activeTextEditor,
        saveOutputSnapshot,
        reportError
      );
    }
  );
}
