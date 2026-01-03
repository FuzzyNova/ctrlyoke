import * as vscode from "vscode";
import * as path from "path";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";
import { Log } from "../utils/Log";

/**
 * Plain completion item (framework-agnostic)
 * Can be converted to vscode.CompletionItem or sent to webview
 */
export interface PlainCompletionItem {
  label: string;
  kind: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
}

/**
 * Cache for workspace files to avoid repeated scans
 */
let filesCache: vscode.Uri[] = [];
let filesCacheTimestamp: number = 0;
const CACHE_DURATION_MS = 5000; // 5 seconds

/**
 * Get all workspace files (with caching)
 */
export async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const now = Date.now();

  // Return cached results if still valid
  if (
    filesCache.length > 0 &&
    filesCacheTimestamp &&
    now - filesCacheTimestamp < CACHE_DURATION_MS
  ) {
    return filesCache;
  }

  // Find all files in workspace, excluding common directories
  const files = await vscode.workspace.findFiles(
    "**/*",
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.vscode/**}"
  );

  // Update cache
  filesCache = files;
  filesCacheTimestamp = now;

  return files;
}

/**
 * Clear the workspace files cache
 */
export function clearFilesCache(): void {
  filesCache = [];
  filesCacheTimestamp = 0;
}

/**
 * Get file completions for @ trigger
 * Returns both file and directory completions
 */
export async function getFileCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const items: PlainCompletionItem[] = [];
  const files = await getWorkspaceFiles();

  // Convert filter text to lowercase and normalize path separators
  const filter = filterText.toLowerCase().replace(/\\/g, "/");

  // Track unique directories we've seen
  const directories = new Set<string>();

  for (const fileUri of files) {
    const relativePath = vscode.workspace.asRelativePath(fileUri, false);

    // Simple filtering: check if the path contains the filter text
    if (filter && !relativePath.toLowerCase().includes(filter)) {
      continue;
    }

    const fileName = path.basename(relativePath);
    const dirName = path.dirname(relativePath);

    // Add file completion
    const fileItem: PlainCompletionItem = {
      label: fileName,
      kind: "file",
      insertText: relativePath,
      detail: dirName === "." ? "Root directory" : dirName,
      documentation:
        `**Full file attachment** (CLI-native)\n\n` +
        `Insert: \`@${relativePath}\`\n\n` +
        `The CLI will automatically attach this file's content.\n\n` +
        `_For line ranges, use \`#file:${relativePath}:10-20\`_`,
      sortText: `0_${relativePath.split(path.sep).length}_${relativePath}`,
      filterText: `${relativePath} ${fileName}`,
    };

    items.push(fileItem);

    // Track directory for directory completions
    if (dirName !== ".") {
      directories.add(dirName);
    }

    // Limit to 500 items for performance
    if (items.length >= 500) {
      break;
    }
  }

  // Add directory completions (with trailing slash)
  for (const dirPath of directories) {
    if (filter && !dirPath.toLowerCase().includes(filter)) {
      continue;
    }

    const dirName = path.basename(dirPath);
    const parentDir = path.dirname(dirPath);

    const dirItem: PlainCompletionItem = {
      label: dirName + "/",
      kind: "folder",
      insertText: dirPath + "/",
      detail: parentDir === "." ? "Root directory" : parentDir,
      documentation:
        `**Directory structure attachment**\n\n` +
        `Insert: \`@${dirPath}/\`\n\n` +
        `FlightPath will attach a file tree of this directory.\n\n` +
        `_No file contents, just structure._`,
      sortText: `0_${dirPath.split(path.sep).length}_0_${dirPath}`,
      filterText: `${dirPath} ${dirName}`,
    };

    items.push(dirItem);
  }

  return items;
}

/**
 * Get symbol completions for # trigger
 * Shows workspace symbols from all file types
 */
export async function getSymbolCompletions(
  filterText: string,
  maxResults: number = 500
): Promise<PlainCompletionItem[]> {
  const items: PlainCompletionItem[] = [];

  try {
    // Query workspace symbols (all file types)
    const symbols = await getWorkspaceSymbols(filterText, maxResults);

    for (const symbol of symbols) {
      const relativePath = vscode.workspace.asRelativePath(
        symbol.location.uri,
        false
      );

      // Get line number (1-based)
      const line = symbol.location.range.start.line + 1;

      // Insert #sym:path/to/file.ts:SymbolName:123
      const insertText = `sym:${relativePath}:${symbol.name}:${line}`;

      // Show symbol kind and location
      const symbolKindName = vscode.SymbolKind[symbol.kind];

      const item: PlainCompletionItem = {
        label: symbol.name,
        kind: "reference",
        insertText: insertText,
        detail: `${symbolKindName} in ${relativePath}:${line}`,
        documentation:
          `**Symbol Reference**\n\n` +
          `Type: ${symbolKindName}\n\n` +
          `Location: \`${relativePath}:${line}\`\n\n` +
          `Insert: \`#sym:${relativePath}:${symbol.name}:${line}\`\n\n` +
          `_FlightPath will resolve this symbol to its exact location and attach the code._`,
        sortText: symbol.name,
        filterText: `${symbol.name} ${relativePath}`,
      };

      items.push(item);
    }
  } catch (error) {
    Log.error("Failed to get symbol completions:", error);
  }

  return items;
}

/**
 * Get completions for all editor selections (from all visible editors)
 */
export function getSelectionCompletions(): PlainCompletionItem[] {
  const items: PlainCompletionItem[] = [];

  // Get all visible editors (including split views)
  const visibleEditors = vscode.window.visibleTextEditors;

  // Track unique selections (avoid duplicates if same file/range appears multiple times)
  const seenSelections = new Set<string>();

  let selectionIndex = 0;

  for (const editor of visibleEditors) {
    // Skip if no selection or selection is empty
    if (editor.selection.isEmpty) {
      continue;
    }

    const selection = editor.selection;
    const document = editor.document;

    // Get workspace-relative path
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);

    // Convert to 1-based line numbers
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    // Create unique key for this selection
    const selectionKey = `${relativePath}:${startLine}-${endLine}`;

    // Skip if we've already seen this exact selection
    if (seenSelections.has(selectionKey)) {
      continue;
    }
    seenSelections.add(selectionKey);

    // Format: #file:path:startLine-endLine
    const completionText = `file:${relativePath}:${startLine}-${endLine}`;

    // Create label with file name and line range
    const fileName = path.basename(relativePath);
    const label =
      visibleEditors.length > 1
        ? `$(selection) ${fileName} (lines ${startLine}-${endLine})`
        : `$(selection) Current Selection`;

    // Get preview of selected text (first 100 chars)
    const selectedText = document.getText(selection);
    const preview =
      selectedText.length > 100
        ? selectedText.substring(0, 100) + "..."
        : selectedText;

    const item: PlainCompletionItem = {
      label: label,
      kind: "reference",
      insertText: completionText,
      detail: `Lines ${startLine}-${endLine} in ${relativePath}`,
      documentation:
        `Insert reference to selected code:\n\n\`#${completionText}\`\n\n` +
        `**Preview:**\n\`\`\`\n${preview}\n\`\`\``,
      sortText: `!000_selection_${selectionIndex.toString().padStart(3, "0")}`,
      filterText: `file selection ${relativePath} ${fileName}`,
    };

    items.push(item);
    selectionIndex++;
  }

  return items;
}

/**
 * Get all completions for # trigger (selections + symbols)
 */
export async function getHashCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const items: PlainCompletionItem[] = [];

  // 1. Add selection completions FIRST (bubbled to top with sortText)
  const selectionItems = getSelectionCompletions();
  selectionItems.forEach((item) => {
    item.sortText = `0_${item.sortText || item.label}`;
  });
  items.push(...selectionItems);

  // 2. Add workspace symbols
  const symbolItems = await getSymbolCompletions(filterText, 500);
  symbolItems.forEach((item) => {
    item.sortText = `1_${item.sortText || item.label}`;
  });
  items.push(...symbolItems);

  return items;
}

/**
 * Convert plain completion item to VS Code completion item
 */
export function toVSCodeCompletionItem(
  item: PlainCompletionItem,
  triggerChar: "@" | "#",
  range?: vscode.Range
): vscode.CompletionItem {
  // Map kind string to VS Code CompletionItemKind
  let kind: vscode.CompletionItemKind;
  switch (item.kind) {
    case "file":
      kind = vscode.CompletionItemKind.File;
      break;
    case "folder":
      kind = vscode.CompletionItemKind.Folder;
      break;
    case "reference":
      kind = vscode.CompletionItemKind.Reference;
      break;
    default:
      kind = vscode.CompletionItemKind.Text;
  }

  const vscodeItem = new vscode.CompletionItem(item.label, kind);
  vscodeItem.insertText = item.insertText;
  vscodeItem.detail = item.detail;

  if (item.documentation) {
    vscodeItem.documentation = new vscode.MarkdownString(item.documentation);
  }

  if (item.sortText) {
    vscodeItem.sortText = item.sortText;
  }

  if (item.filterText) {
    vscodeItem.filterText = item.filterText;
  }

  // Set range for YAML compatibility
  if (range) {
    vscodeItem.range = range;
  }

  return vscodeItem;
}
