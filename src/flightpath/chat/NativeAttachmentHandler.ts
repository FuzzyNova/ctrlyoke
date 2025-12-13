import * as vscode from "vscode";
import {
  FileReference,
  parseAllFileReferences,
} from "../../utils/FileReferenceParser";
import { resolveSymbol } from "../../utils/AttachmentBuilders";

/** Function type for resolving workspace-relative paths */
export type PathResolver = (relativePath: string) => string;

/**
 * Handles native VS Code file attachments for Copilot Chat.
 * Uses VS Code commands to attach files/selections for clean chat UI.
 */
export class NativeAttachmentHandler {
  constructor(private readonly resolvePath: PathResolver) {}

  /** Open document, execute action, then close */
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

    await new Promise((resolve) => setTimeout(resolve, 200));
    await action(editor);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
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
          console.log(`🔍 Resolving symbol: ${symbolRef}`);
          const resolved = await resolveSymbol(symbolRef);
          if (resolved) {
            resolvedRefs.push(resolved);
            console.log(
              `✓ Resolved to: ${resolved.path}:${resolved.startLine}-${resolved.endLine}`
            );
          } else {
            console.warn(`Could not resolve symbol: ${symbolRef}`);
          }
        } else {
          // Regular file/directory reference
          resolvedRefs.push(ref);
        }
      }

      if (resolvedRefs.length === 0) {
        return prompt;
      }

      console.log(`📎 Attaching ${resolvedRefs.length} file(s)...`);

      for (const ref of resolvedRefs) {
        const absolutePath = this.resolvePath(ref.path);
        const uri = vscode.Uri.file(absolutePath);

        if (!ref.startLine || !ref.endLine) {
          // Attach entire file
          try {
            await this.withFocusedDocument(uri, async () => {
              await vscode.commands.executeCommand(
                "github.copilot.chat.attachFile"
              );
            });
            console.log(`✅ File: ${ref.path}`);
          } catch (error) {
            console.error(`❌ Attach failed: ${ref.path}`, error);
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
            console.log(`✅ Selection: ${refDesc}`);
          } catch (error) {
            const refDesc = ref.symbolName
              ? `${ref.symbolName} (${ref.path}:${ref.startLine}-${ref.endLine})`
              : `${ref.path}:${ref.startLine}-${ref.endLine}`;
            console.error(`❌ Attach failed: ${refDesc}`, error);
          }
        }

        // Small delay between attachments
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Keep #file: references in prompt for context
      return prompt;
    } catch (error) {
      console.error("Error processing attachments:", error);
      return prompt;
    }
  }
}
