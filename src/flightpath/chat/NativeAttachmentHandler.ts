import * as vscode from "vscode";

/**
 * File reference parsed from prompt text
 */
export interface FileReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** Function type for resolving workspace-relative paths */
export type PathResolver = (relativePath: string) => string;

/**
 * Handles native VS Code file attachments for Copilot Chat.
 * Uses VS Code commands to attach files/selections for clean chat UI.
 */
export class NativeAttachmentHandler {
  constructor(private readonly resolvePath: PathResolver) {}

  /** Parse #file: references from prompt text */
  parseFileReferences(prompt: string): FileReference[] {
    const references: FileReference[] = [];
    // Match #file:path or #file:path:startLine-endLine
    const regex = /#file:([^\s:]+)(?::(\d+)-(\d+))?/g;
    let match;

    while ((match = regex.exec(prompt)) !== null) {
      references.push({
        path: match[1],
        startLine: match[2] ? parseInt(match[2], 10) : undefined,
        endLine: match[3] ? parseInt(match[3], 10) : undefined,
      });
    }

    return references;
  }

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
      const fileReferences = this.parseFileReferences(prompt);

      if (fileReferences.length === 0) {
        return prompt;
      }

      console.log(`📎 Attaching ${fileReferences.length} file(s)...`);

      for (const ref of fileReferences) {
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
            console.log(
              `✅ Selection: ${ref.path}:${ref.startLine}-${ref.endLine}`
            );
          } catch (error) {
            console.error(
              `❌ Attach failed: ${ref.path}:${ref.startLine}-${ref.endLine}`,
              error
            );
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
