import * as vscode from "vscode";
import * as path from "path";
import { FileReference } from "./FileReferenceParser";
import { Log } from "./Log";

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

    // Resolve workspace-relative path to URI against the caller-provided root.
    if (!workspaceRoot) {
      Log.warn("No workspace root provided");
      return null;
    }

    const fileUri = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceRoot),
      filePath
    );

    // Open document to query symbols (needed for symbol provider to work)
    await vscode.workspace.openTextDocument(fileUri);

    // Get document symbols
    const symbols = (await vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      fileUri
    )) as vscode.DocumentSymbol[];

    if (!symbols || symbols.length === 0) {
      Log.warn(`No symbols found in ${filePath}`);
      return null;
    }

    Log.debug(
      `[resolveSymbol] Found ${symbols.length} top-level symbols, searching for "${symbolName}" at line ${targetLine}...`
    );

    // Find symbol at or near the target line
    const targetSymbol = findSymbolAtLine(symbols, symbolName, targetLine);

    if (!targetSymbol) {
      Log.warn(
        `Symbol '${symbolName}' not found at line ${targetLine} in ${filePath}`
      );
      return null;
    }

    Log.debug(
      `[resolveSymbol] Found symbol: ${targetSymbol.name} (lines ${targetSymbol.range.start.line + 1}-${targetSymbol.range.end.line + 1})`
    );

    return {
      path: filePath,
      startLine: targetSymbol.range.start.line + 1,
      endLine: targetSymbol.range.end.line + 1,
      symbolName: targetSymbol.name,
    };
  } catch (error) {
    Log.error(`Failed to resolve symbol '${symbolRef}':`, error);
    return null;
  }
}

/**
 * Recursively find a symbol at a specific line in a symbol tree
 * @param symbols Array of document symbols to search
 * @param symbolName Name of the symbol to find (may include () for methods)
 * @param targetLine Line number to match (1-based)
 * @returns Matching symbol or null
 */
function findSymbolAtLine(
  symbols: vscode.DocumentSymbol[],
  symbolName: string,
  targetLine: number
): vscode.DocumentSymbol | null {
  // Normalize symbol names for comparison:
  // - VS Code returns "methodName" but user may search for "methodName()"
  // - Strip trailing () from search term for matching
  const normalizedSearchName = symbolName.replace(/\(\)$/, "");

  for (const symbol of symbols) {
    // Check if this symbol matches (name and line)
    const symbolStartLine = symbol.range.start.line + 1; // Convert to 1-based
    const normalizedSymbolName = symbol.name.replace(/\(\)$/, "");

    // Only log individual checks at debug level to reduce verbosity
    // (checking dozens of symbols is normal for large files)

    if (
      normalizedSymbolName === normalizedSearchName &&
      symbolStartLine === targetLine
    ) {
      Log.debug(
        `[findSymbolAtLine] ✓ Found: ${symbol.name} at line ${symbolStartLine}`
      );
      return symbol;
    }

    // Recursively check children
    if (symbol.children && symbol.children.length > 0) {
      const childMatch = findSymbolAtLine(
        symbol.children,
        symbolName,
        targetLine
      );
      if (childMatch) {
        return childMatch;
      }
    }
  }

  return null;
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
