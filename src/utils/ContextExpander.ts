import * as vscode from "vscode";
import * as path from "path";
import { FileReference, parseAllFileReferences } from "./FileReferenceParser";
import {
  resolveSymbol,
  buildDirectoryAttachmentXml,
} from "./AttachmentBuilders";
import { Log } from "./Log";

/**
 * ContextExpander - Unified context expansion utility
 *
 * Handles all FlightPath context reference expansion:
 * - @path/to/file (full file)
 * - @path/to/dir/ (directory listing)
 * - #file:path (full file)
 * - #file:path:line-line (line range)
 * - #sym:path:symbol:line (symbol context)
 *
 * This class consolidates all attachment building logic that was previously
 * scattered across CopilotIntegration and CLI classes. It produces fully-expanded
 * prompt text with all context references resolved to their actual content.
 *
 * DESIGN PRINCIPLES:
 * - Single Responsibility: Only handles context expansion
 * - DRY: All attachment building in one place
 * - No duplication: Used by all CLI integrations
 * - Testable: Pure functions, no side effects
 */
export class ContextExpander {
  private workspaceRoot: string;
  private expandedFiles = new Set<string>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Expand all context references in prompt text.
   * Returns fully-expanded prompt with all files/symbols inlined as attachments.
   *
   * @param promptText Original prompt with context references
   * @returns Expanded prompt with attachment XML prepended
   */
  async expandContext(promptText: string): Promise<string> {
    try {
      // Parse all file references from prompt
      let fileReferences = parseAllFileReferences(promptText);

      if (fileReferences.length === 0) {
        return promptText; // No attachments needed
      }

      // Resolve symbol references to actual file locations
      const resolvedRefs = await this.resolveSymbolReferences(fileReferences);

      if (resolvedRefs.length === 0) {
        return promptText; // No valid attachments after resolution
      }

      // Build attachments in parallel for performance
      const attachmentPromises = resolvedRefs.map((ref) =>
        this.buildAttachmentForReference(ref).catch((err) => {
          const refDesc = this.getRefDescription(ref);
          Log.error(`Failed to attach ${refDesc}:`, err);
          return null; // Skip failed attachments
        })
      );

      const attachments = await Promise.all(attachmentPromises);
      const validAttachments = attachments.filter(
        (a) => a !== null
      ) as string[];

      if (validAttachments.length === 0) {
        return promptText; // No valid attachments
      }

      // Prepend attachments to prompt
      const attachmentsSection = validAttachments.join("\n\n");
      return `${attachmentsSection}\n\n${promptText}`;
    } catch (error) {
      Log.error("Error expanding context:", error);
      // Return original prompt on error
      return promptText;
    }
  }

  /**
   * Get human-readable description of a file reference
   */
  private getRefDescription(ref: FileReference): string {
    if (ref.symbolName) {
      return `symbol:${ref.symbolName}`;
    }
    if (ref.isDirectory) {
      return `directory:${ref.path}`;
    }
    if (ref.startLine && ref.endLine) {
      return `${ref.path}:${ref.startLine}-${ref.endLine}`;
    }
    return ref.path;
  }

  /**
   * Resolve symbol references to file locations
   * @param fileReferences Array of file references from parseAllFileReferences
   * @returns Array with symbols resolved to actual file locations
   */
  private async resolveSymbolReferences(
    fileReferences: FileReference[]
  ): Promise<FileReference[]> {
    const resolvedRefs: FileReference[] = [];

    for (const ref of fileReferences) {
      if (ref.symbolName) {
        // Symbol reference - build full reference string for resolveSymbol
        // Format: path/to/file.ts:SymbolName:123
        const symbolRef = `${ref.path}:${ref.symbolName}:${ref.startLine}`;
        const resolved = await resolveSymbol(symbolRef);
        if (resolved) {
          resolvedRefs.push(resolved);
        } else {
          Log.warn(`Could not resolve symbol: ${symbolRef}`);
        }
      } else {
        // Regular file/directory reference
        resolvedRefs.push(ref);
      }
    }

    return resolvedRefs;
  }

  /**
   * Build attachment XML for a single file reference
   * Routes to appropriate builder based on reference type
   */
  private async buildAttachmentForReference(
    ref: FileReference
  ): Promise<string> {
    if (ref.isDirectory) {
      // Directory reference - build tree structure
      return buildDirectoryAttachmentXml(ref.path, this.workspaceRoot);
    } else {
      // File reference (full file, line range, or symbol)
      return this.buildAttachmentXml(
        ref.path,
        ref.startLine,
        ref.endLine,
        ref.symbolName
      );
    }
  }

  /**
   * Build attachment XML for a file or file excerpt
   * Moved from CopilotIntegration to consolidate all attachment logic
   *
   * @param filePath Workspace-relative file path
   * @param startLine Optional start line (1-indexed)
   * @param endLine Optional end line (1-indexed)
   * @param symbolName Optional symbol name (for #sym: references)
   */
  private async buildAttachmentXml(
    filePath: string,
    startLine?: number,
    endLine?: number,
    symbolName?: string
  ): Promise<string> {
    // Resolve to absolute path
    const absolutePath = this.resolveWorkspacePath(filePath);
    const uri = vscode.Uri.file(absolutePath);

    // Read file content
    const doc = await vscode.workspace.openTextDocument(uri);
    const language = doc.languageId;

    // If no line range, attach entire file
    if (!startLine || !endLine) {
      const content = doc.getText();
      const attachmentId = symbolName
        ? `symbol:${symbolName}`
        : `file:${filePath}`;
      const description = symbolName
        ? `Symbol: ${symbolName} in ${filePath}`
        : `File: ${filePath}`;

      return `<attachment id="${attachmentId}">
${description}
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
    }

    // Extract line range (convert to 0-indexed)
    const start = new vscode.Position(startLine - 1, 0);
    const end = new vscode.Position(endLine - 1, Number.MAX_SAFE_INTEGER);
    const range = new vscode.Range(start, end);
    const content = doc.getText(range);

    // Build attachment with symbol-aware ID and description
    const attachmentId = symbolName
      ? `symbol:${symbolName}`
      : `file:${filePath}:${startLine}-${endLine}`;
    const description = symbolName
      ? `Symbol: ${symbolName} in ${filePath}, lines ${startLine} to ${endLine}`
      : `Excerpt from ${filePath}, lines ${startLine} to ${endLine}`;

    return `<attachment id="${attachmentId}">
${description}:
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
  }

  /**
   * Resolve relative path to absolute workspace path
   * Uses Node.js path.resolve for cross-platform compatibility
   */
  private resolveWorkspacePath(relativePath: string): string {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    // path.resolve handles both absolute and relative paths correctly
    // If relativePath is already absolute, it returns it as-is
    // If relative, it joins with workspaceRoot
    return path.resolve(this.workspaceRoot, relativePath);
  }
}
