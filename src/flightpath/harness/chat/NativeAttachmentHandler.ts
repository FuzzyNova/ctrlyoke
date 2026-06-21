import * as vscode from "vscode";
import {
  FileReference,
  parseAllFileReferences,
} from "../../../utils/FileReferenceParser";
import { Log } from "../../../utils/Log";
import { resolveSymbol } from "../../../utils/AttachmentBuilders";
import { getVsCodeWorkspaceRoot } from "../../../platform/VsCodeWorkspaceRoot";

/** Function type for resolving workspace-relative paths */
export type PathResolver = (relativePath: string) => string;

/**
 * Handles native VS Code file attachments for Copilot Chat.
 * Uses VS Code commands to attach files/selections for clean chat UI.
 */
export class NativeAttachmentHandler {
  /** Delay (ms) after opening a document to allow focus to settle */
  private static readonly DOCUMENT_FOCUS_DELAY_MS = 200;
  /** Delay (ms) between consecutive attachment operations */
  private static readonly INTER_ATTACHMENT_DELAY_MS = 200;

  constructor(private readonly resolvePath: PathResolver) {}

  /** Open document, execute action, then close — uses try/finally for cleanup */
  private async withFocusedDocument(
    uri: vscode.Uri,
    action: (editor: vscode.TextEditor) => Promise<void>
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);

    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: false, // Need focus for attachment commands
      viewColumn: vscode.ViewColumn.Beside,
    });

    try {
      await new Promise((resolve) =>
        setTimeout(resolve, NativeAttachmentHandler.DOCUMENT_FOCUS_DELAY_MS)
      );
      await action(editor);
    } finally {
      // Always close the document, even if the action threw
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor"
      );
    }
  }

  /** Attach files via native commands; returns prompt unchanged */
  async processAttachments(prompt: string): Promise<string> {
    try {
      let fileReferences = parseAllFileReferences(prompt);

      if (fileReferences.length === 0) {
        return prompt;
      }

      // Resolve symbol references to actual file locations
      const resolvedRefs: FileReference[] = [];
      for (const ref of fileReferences) {
        if (ref.symbolName) {
          // Symbol reference - resolve to file location
          const symbolRef = `${ref.path}:${ref.symbolName}:${ref.startLine}`;
          Log.debug(`🔍 Resolving symbol: ${symbolRef}`);
          const resolved = await resolveSymbol(
            symbolRef,
            getVsCodeWorkspaceRoot()
          );
          if (resolved) {
            resolvedRefs.push(resolved);
            Log.debug(
              `✓ Resolved to: ${resolved.path}:${resolved.startLine}-${resolved.endLine}`
            );
          } else {
            Log.warn(`Could not resolve symbol: ${symbolRef}`);
          }
        } else {
          // Regular file/directory reference
          resolvedRefs.push(ref);
        }
      }

      if (resolvedRefs.length === 0) {
        return prompt;
      }

      Log.info(`📎 Attaching ${resolvedRefs.length} file(s)...`);

      for (const ref of resolvedRefs) {
        const absolutePath = this.resolvePath(ref.path);
        const uri = vscode.Uri.file(absolutePath);

        if (ref.isDirectory) {
          // Attach directory structure using native folder attachment
          try {
            await vscode.commands.executeCommand(
              "workbench.action.chat.attachFolder",
              uri
            );
            Log.debug(`✅ Directory: ${ref.path}`);
          } catch (error) {
            Log.error(`❌ Attach directory failed: ${ref.path}`, error);
          }
        } else if (!ref.startLine || !ref.endLine) {
          // Attach entire file
          try {
            await this.withFocusedDocument(uri, async () => {
              await vscode.commands.executeCommand(
                "github.copilot.chat.attachFile"
              );
            });
            Log.debug(`✅ File: ${ref.path}`);
          } catch (error) {
            Log.error(`❌ Attach failed: ${ref.path}`, error);
          }
        } else {
          // Attach line range using selection
          try {
            await this.withFocusedDocument(uri, async (editor) => {
              const selection = new vscode.Selection(
                new vscode.Position(ref.startLine! - 1, 0),
                new vscode.Position(ref.endLine! - 1, Number.MAX_SAFE_INTEGER)
              );
              editor.selection = selection;

              await vscode.commands.executeCommand(
                "github.copilot.chat.attachSelection"
              );
            });
            const refDesc = ref.symbolName
              ? `${ref.symbolName} (${ref.path}:${ref.startLine}-${ref.endLine})`
              : `${ref.path}:${ref.startLine}-${ref.endLine}`;
            Log.debug(`✅ Selection: ${refDesc}`);
          } catch (error) {
            const refDesc = ref.symbolName
              ? `${ref.symbolName} (${ref.path}:${ref.startLine}-${ref.endLine})`
              : `${ref.path}:${ref.startLine}-${ref.endLine}`;
            Log.error(`❌ Attach failed: ${refDesc}`, error);
          }
        }

        // Small delay between attachments
        await new Promise((resolve) =>
          setTimeout(resolve, NativeAttachmentHandler.INTER_ATTACHMENT_DELAY_MS)
        );
      }

      // Keep #file: references in prompt for context
      return prompt;
    } catch (error) {
      Log.error("Error processing attachments:", error);
      return prompt;
    }
  }
}
