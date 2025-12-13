import * as vscode from "vscode";
import * as path from "path";
import { FileReference } from "./FileReferenceParser";

/**
 * Utility functions for building XML attachments for various reference types
 */

/**
 * Resolve a symbol name to its file location using VS Code's workspace symbol provider
 *
 * @param symbolName The symbol name to resolve (e.g., "FlightPathManager")
 * @returns FileReference with path and line range, or null if not found
 */
export async function resolveSymbol(
  symbolName: string
): Promise<FileReference | null> {
  try {
    // Query workspace symbols
    const symbols = (await vscode.commands.executeCommand(
      "vscode.executeWorkspaceSymbolProvider",
      symbolName
    )) as vscode.SymbolInformation[];

    if (!symbols || symbols.length === 0) {
      console.warn(`Symbol not found: ${symbolName}`);
      return null;
    }

    // Find exact match (prefer exact name match over partial)
    let targetSymbol = symbols.find((s) => s.name === symbolName);

    // If no exact match, use first result (partial match)
    if (!targetSymbol) {
      targetSymbol = symbols[0];
      console.log(
        `No exact match for '${symbolName}', using '${targetSymbol.name}' instead`
      );
    }

    // Get workspace-relative path
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      targetSymbol.location.uri
    );
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(targetSymbol.location.uri, false)
      : targetSymbol.location.uri.fsPath;

    // Extract line range from symbol location
    const range = targetSymbol.location.range;

    return {
      path: relativePath,
      startLine: range.start.line + 1, // Convert to 1-based
      endLine: range.end.line + 1,
      symbolName: targetSymbol.name,
    };
  } catch (error) {
    console.error(`Failed to resolve symbol '${symbolName}':`, error);
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
    console.error(`Failed to read directory ${dirUri.fsPath}:`, error);
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
    console.error(`Directory not found: ${dirPath}`, error);
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
    console.error("Failed to get workspace symbols:", error);
    return [];
  }
}
