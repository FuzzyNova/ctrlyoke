import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { FileReference } from "./FileReferenceParser";
import { Log } from "./Log";
import { getErrorMessage } from "./ErrorUtils";
import { findSymbolRange } from "./SymbolRangeFinder";

/**
 * Utility functions for building XML attachments for various reference types
 */

/**
 * Resolve a symbol reference to its file location
 *
 * Format: "path/to/file.ts:SymbolName:123"
 * - File path (workspace-relative)
 * - Symbol name
 * - Line number (1-based)
 *
 * This format ensures unique identification when:
 * - Same symbol name exists in multiple files
 * - Same symbol name appears multiple times in same file
 *
 * @param symbolRef Symbol reference string (e.g., "src/utils/AttachmentBuilders.ts:resolveSymbol:10")
 * @param workspaceRoot Absolute workspace root used to resolve workspace-relative
 *   paths. Passed in by the caller (the resolved root in VS Code, the CLI cwd in
 *   the standalone binary) so this shared helper never depends on the VS Code
 *   workspace-resolution layer.
 * @returns FileReference with path and line range, or null if not found
 *
 * Symbol resolution reads the file directly and derives the symbol's extent from
 * its text (see {@link findSymbolRange}). It deliberately does NOT use VS Code's
 * symbol provider, so symbol attachments expand identically in the editor and the
 * standalone CLI.
 */
export async function resolveSymbol(
  symbolRef: string,
  workspaceRoot: string
): Promise<FileReference | null> {
  try {
    Log.debug(`[resolveSymbol] Resolving: ${symbolRef}`);

    // Parse format: path/to/file.ts:SymbolName:123
    // Use lastIndexOf to handle the line number (last colon), then second-to-last for symbol name
    const lastColonIndex = symbolRef.lastIndexOf(":");
    if (lastColonIndex === -1) {
      Log.warn(`Invalid symbol reference (no colons): ${symbolRef}`);
      return null;
    }

    const lineStr = symbolRef.substring(lastColonIndex + 1);
    const targetLine = parseInt(lineStr, 10);

    if (isNaN(targetLine)) {
      Log.warn(`Invalid line number in symbol reference: ${symbolRef}`);
      return null;
    }

    // Now find the second-to-last colon (separates path from symbol name)
    const remainingRef = symbolRef.substring(0, lastColonIndex);
    const secondLastColonIndex = remainingRef.lastIndexOf(":");

    if (secondLastColonIndex === -1) {
      Log.warn(`Invalid symbol reference (missing symbol name): ${symbolRef}`);
      return null;
    }

    const filePath = remainingRef.substring(0, secondLastColonIndex);
    const symbolName = remainingRef.substring(secondLastColonIndex + 1);

    Log.debug(
      `[resolveSymbol] Parsed: filePath="${filePath}", symbolName="${symbolName}", line=${targetLine}`
    );

    if (!workspaceRoot) {
      Log.warn("No workspace root provided");
      return null;
    }

    // Read the file directly (Node fs — works in both VS Code and the CLI).
    const absolutePath = path.join(workspaceRoot, filePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch (err) {
      Log.warn(
        `[resolveSymbol] Could not read ${filePath}: ${getErrorMessage(err)}`
      );
      return null;
    }

    // Derive the symbol's extent from the file text — no symbol provider needed.
    const { startLine, endLine } = findSymbolRange(
      content,
      symbolName,
      targetLine,
      path.extname(filePath)
    );

    Log.debug(
      `[resolveSymbol] Resolved "${symbolName}" to lines ${startLine}-${endLine} in ${filePath}`
    );

    return {
      path: filePath,
      startLine,
      endLine,
      symbolName: symbolName.replace(/\(\)$/, ""),
    };
  } catch (error) {
    Log.error(`Failed to resolve symbol '${symbolRef}':`, error);
    return null;
  }
}

/**
 * Build a directory tree structure as a string
 *
 * @param dirUri The directory URI to scan
 * @param maxDepth Maximum depth to scan (default: 3)
 * @param currentDepth Internal recursion tracker
 * @param prefix Internal line prefix for tree formatting
 * @returns Formatted directory tree string
 */
async function buildDirectoryTree(
  dirUri: vscode.Uri,
  maxDepth: number = 3,
  currentDepth: number = 0,
  prefix: string = ""
): Promise<string> {
  if (currentDepth >= maxDepth) {
    return "";
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      const aIsDir = a[1] === vscode.FileType.Directory;
      const bIsDir = b[1] === vscode.FileType.Directory;

      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a[0].localeCompare(b[0]);
    });

    let tree = "";
    const lastIndex = entries.length - 1;

    for (let i = 0; i < entries.length; i++) {
      const [name, type] = entries[i];
      const isLast = i === lastIndex;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (type === vscode.FileType.Directory) {
        tree += `${prefix}${connector}${name}/\n`;

        // Recurse into subdirectory
        const subDirUri = vscode.Uri.joinPath(dirUri, name);
        const subTree = await buildDirectoryTree(
          subDirUri,
          maxDepth,
          currentDepth + 1,
          prefix + childPrefix
        );
        tree += subTree;
      } else {
        tree += `${prefix}${connector}${name}\n`;
      }
    }

    return tree;
  } catch (error) {
    Log.error(`Failed to read directory ${dirUri.fsPath}:`, error);
    return `${prefix}[Error reading directory]\n`;
  }
}

/**
 * Build XML attachment for a directory structure
 *
 * @param dirPath Workspace-relative directory path (with or without trailing slash)
 * @param workspaceRoot Absolute path to workspace root
 * @returns XML string with directory tree
 */
export async function buildDirectoryAttachmentXml(
  dirPath: string,
  workspaceRoot: string
): Promise<string> {
  // Remove trailing slash for consistent path handling
  const normalizedPath = dirPath.replace(/[/\\]+$/, "");

  // Build absolute URI
  const absolutePath = path.join(workspaceRoot, normalizedPath);
  const dirUri = vscode.Uri.file(absolutePath);

  // Check if directory exists
  try {
    const stat = await vscode.workspace.fs.stat(dirUri);
    if (stat.type !== vscode.FileType.Directory) {
      throw new Error("Path is not a directory");
    }
  } catch (error) {
    Log.error(`Directory not found: ${dirPath}`, error);
    return `<attachment id="directory:${normalizedPath}">
Directory not found: ${normalizedPath}
</attachment>`;
  }

  // Build tree
  const tree = await buildDirectoryTree(dirUri);
  const fileCount = (tree.match(/\n/g) || []).length;

  return `<attachment id="directory:${normalizedPath}">
Directory structure: ${normalizedPath}/ (${fileCount} items)

${normalizedPath}/
${tree}
</attachment>`;
}

/**
 * Get all workspace symbols matching a query
 * Used for completion provider
 *
 * @param query Search query (empty string returns all symbols)
 * @param maxResults Maximum number of results (default: 100)
 * @returns Array of symbol information from all file types
 */
export async function getWorkspaceSymbols(
  query: string = "",
  maxResults: number = 100
): Promise<vscode.SymbolInformation[]> {
  try {
    const allSymbols = (await vscode.commands.executeCommand(
      "vscode.executeWorkspaceSymbolProvider",
      query
    )) as vscode.SymbolInformation[];

    if (!allSymbols || allSymbols.length === 0) {
      return [];
    }

    return allSymbols.slice(0, maxResults);
  } catch (error) {
    Log.error("Failed to get workspace symbols:", error);
    return [];
  }
}
