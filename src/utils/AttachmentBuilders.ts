import * as vscode from "vscode";
import * as path from "path";
import { Log } from "./Log";
import { isPathWithinAnyDirectory } from "./PathSecurity";
import {
  resolveReferencePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";

/**
 * Utility functions for building XML attachments for various reference types
 */

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
    Log.warn(
      `[AttachmentBuilders] Failed to read directory ${dirUri.fsPath}; returning partial tree:`,
      error
    );
    return `${prefix}[Error reading directory]\n`;
  }
}

/**
 * Build XML attachment for a directory structure
 *
 * @param dirPath Workspace-relative directory path (with or without trailing slash),
 *   optionally folder-name-prefixed for multi-root (`root2/src/`)
 * @param workspaceRoot Absolute path to workspace root, used to resolve relative refs
 * @param additionalTrustedRoots Extra absolute directories to also trust (e.g. every
 *   folder of a multi-root `.code-workspace`, which need not be descendants of
 *   `workspaceRoot`). Defaults to just `workspaceRoot`.
 * @param namedRoots Named roots for folder-name-prefixed resolution (see
 *   `resolveReferencePath`). Defaults to none (primary-root-only resolution).
 * @param effectiveAbsolute When true, render the resolved absolute directory path
 *   in the attachment body instead of the as-typed relative path (the id is
 *   unaffected — it only needs to be stable for deduplication).
 * @param sourceDefinitionDir Directory containing the authored workflow, used
 *   for `./` and `../` references.
 * @returns XML string with directory tree
 */
export async function buildDirectoryAttachmentXml(
  dirPath: string,
  workspaceRoot: string,
  additionalTrustedRoots: string[] = [],
  namedRoots: ResolverWorkspaceFolder[] = [],
  effectiveAbsolute: boolean = false,
  sourceDefinitionDir?: string
): Promise<string> {
  // Remove trailing slash for consistent path handling
  const normalizedPath = dirPath.replace(/[/\\]+$/, "");

  // Build absolute URI
  const resolvedRoot = path.resolve(workspaceRoot);
  const absolutePath = resolveReferencePath(normalizedPath, {
    primaryRoot: resolvedRoot,
    namedRoots,
    sourceDefinitionDir,
  }).absolutePath;
  const trustedRoots = [
    resolvedRoot,
    ...additionalTrustedRoots.map((root) => path.resolve(root)),
  ];

  // @dir/ references come from prompt/workflow file content, which may not
  // have been authored by the person running it — reject traversal outside
  // every trusted root rather than listing an arbitrary directory on disk.
  if (!isPathWithinAnyDirectory(absolutePath, trustedRoots)) {
    Log.warn(
      `[AttachmentBuilders] Security: Directory reference "${dirPath}" resolves outside the workspace and was blocked`
    );
    return `<attachment id="directory:${normalizedPath}">
Directory reference is outside the workspace and was blocked: ${normalizedPath}
</attachment>`;
  }

  const dirUri = vscode.Uri.file(absolutePath);

  // Check if directory exists
  try {
    const stat = await vscode.workspace.fs.stat(dirUri);
    if (stat.type !== vscode.FileType.Directory) {
      throw new Error("Path is not a directory");
    }
  } catch (error) {
    Log.warn(`[AttachmentBuilders] Directory not found: ${dirPath}`, error);
    return `<attachment id="directory:${normalizedPath}">
Directory not found: ${normalizedPath}
</attachment>`;
  }

  // Build tree
  const tree = await buildDirectoryTree(dirUri);
  const fileCount = (tree.match(/\n/g) || []).length;

  const displayPath = effectiveAbsolute ? absolutePath : normalizedPath;

  return `<attachment id="directory:${normalizedPath}">
Directory structure: ${displayPath}/ (${fileCount} items)

${displayPath}/
${tree}
</attachment>`;
}

/**
 * Get all workspace symbols matching a query
 * Used for completion provider
 *
 * @param query Search query, passed to every provider verbatim (each
 *   provider decides what matches; VS Code itself filters nothing)
 * @returns Array of symbol information from all file types, in provider order
 */
export async function getWorkspaceSymbols(
  query: string = ""
): Promise<vscode.SymbolInformation[]> {
  try {
    const allSymbols = (await vscode.commands.executeCommand(
      "vscode.executeWorkspaceSymbolProvider",
      query
    )) as vscode.SymbolInformation[];

    return allSymbols ?? [];
  } catch (error) {
    Log.warn(
      "[AttachmentBuilders] Failed to get workspace symbols; returning no symbols:",
      error
    );
    return [];
  }
}
