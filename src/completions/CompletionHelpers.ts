import * as vscode from "vscode";
import * as path from "path";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { configService } from "../config/CtrlYokeConfigService";
import {
  getRecentCommits,
  getGitTrackedFiles,
  getStashList,
  searchCommitsBySubject,
  type CommitInfo,
  type StashInfo,
} from "../utils/GitUtils";
import {
  buildDirectoryReference,
  buildDirectoryReferenceValue,
  buildFileReference,
  buildFileReferenceValue,
  buildSelectionReference,
  buildSelectionReferenceValue,
  buildSymbolReference,
  buildSymbolReferenceValue,
} from "./ContextReferenceBuilder";

/**
 * Plain completion item (framework-agnostic)
 * Can be converted to vscode.CompletionItem or sent to webview
 */
export interface PlainCompletionItem {
  label: string;
  kind: vscode.CompletionItemKind;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
}

/**
 * Map VS Code SymbolKind to CompletionItemKind
 * SymbolKind and CompletionItemKind are different enums with different values
 */
function mapSymbolKindToCompletionKind(
  symbolKind: vscode.SymbolKind
): vscode.CompletionItemKind {
  switch (symbolKind) {
    case vscode.SymbolKind.File:
      return vscode.CompletionItemKind.File;
    case vscode.SymbolKind.Module:
      return vscode.CompletionItemKind.Module;
    case vscode.SymbolKind.Namespace:
      return vscode.CompletionItemKind.Module;
    case vscode.SymbolKind.Package:
      return vscode.CompletionItemKind.Module;
    case vscode.SymbolKind.Class:
      return vscode.CompletionItemKind.Class;
    case vscode.SymbolKind.Method:
      return vscode.CompletionItemKind.Method;
    case vscode.SymbolKind.Property:
      return vscode.CompletionItemKind.Property;
    case vscode.SymbolKind.Field:
      return vscode.CompletionItemKind.Field;
    case vscode.SymbolKind.Constructor:
      return vscode.CompletionItemKind.Constructor;
    case vscode.SymbolKind.Enum:
      return vscode.CompletionItemKind.Enum;
    case vscode.SymbolKind.Interface:
      return vscode.CompletionItemKind.Interface;
    case vscode.SymbolKind.Function:
      return vscode.CompletionItemKind.Function;
    case vscode.SymbolKind.Variable:
      return vscode.CompletionItemKind.Variable;
    case vscode.SymbolKind.Constant:
      return vscode.CompletionItemKind.Constant;
    case vscode.SymbolKind.String:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.Number:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.Boolean:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.Array:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.Object:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.Key:
      return vscode.CompletionItemKind.Property;
    case vscode.SymbolKind.Null:
      return vscode.CompletionItemKind.Value;
    case vscode.SymbolKind.EnumMember:
      return vscode.CompletionItemKind.EnumMember;
    case vscode.SymbolKind.Struct:
      return vscode.CompletionItemKind.Struct;
    case vscode.SymbolKind.Event:
      return vscode.CompletionItemKind.Event;
    case vscode.SymbolKind.Operator:
      return vscode.CompletionItemKind.Operator;
    case vscode.SymbolKind.TypeParameter:
      return vscode.CompletionItemKind.TypeParameter;
    default:
      return vscode.CompletionItemKind.Reference;
  }
}

/**
 * Cache for workspace files to avoid repeated scans
 */
let filesCache: vscode.Uri[] = [];
let filesCacheTimestamp: number = 0;
const CACHE_DURATION_MS = 5000; // 5 seconds

/**
 * Get all workspace files (with caching).
 *
 * When respectGitignore is ON, uses `git ls-files` directly instead of
 * findFiles+checkIgnore batching. This is correct by definition (git knows
 * what's ignored), handles nested .gitignore files and global gitignore, and
 * avoids the VS Code Git API errors that occur on repos with 100k+ files.
 */
async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const now = Date.now();

  if (
    filesCache.length > 0 &&
    filesCacheTimestamp &&
    now - filesCacheTimestamp < CACHE_DURATION_MS
  ) {
    Log.trace(
      `[Completions] Returning cached files (${filesCache.length} files)`
    );
    return filesCache;
  }

  const respectGitignore =
    ConfigurationUtils.shouldRespectGitignoreForCompletions();

  let files: vscode.Uri[];
  if (respectGitignore) {
    files = await getGitAwareFiles();
  } else {
    // NOTE: VS Code's findFiles() does NOT respect .gitignore regardless of
    // the exclude parameter. See: https://github.com/microsoft/vscode/issues/48674
    files = await vscode.workspace.findFiles("**/*", "**/.git/**");
  }

  Log.debug(
    `[Completions] ${files.length} files (respectGitignore=${respectGitignore})`
  );

  filesCache = files;
  filesCacheTimestamp = now;
  return files;
}

/**
 * Returns all non-gitignored files across all workspace folders by running
 * `git ls-files --cached --others --exclude-standard` per folder.
 * Falls back to findFiles (unfiltered) for any folder that isn't a git repo.
 */
async function getGitAwareFiles(): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const relativePaths = await getGitTrackedFiles(folder.uri.fsPath);
      for (const relPath of relativePaths) {
        result.push(vscode.Uri.joinPath(folder.uri, relPath));
      }
      Log.debug(
        `[Completions] git ls-files: ${relativePaths.length} files from ${folder.name}`
      );
    } catch (error) {
      Log.warn(
        `[Completions] git ls-files failed for ${folder.name}, falling back to findFiles:`,
        error
      );
      const fallback = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*"),
        "**/.git/**"
      );
      for (const file of fallback) {
        result.push(file);
      }
    }
  }
  return result;
}

/**
 * Clear the workspace files cache
 */
export function clearFilesCache(): void {
  filesCache = [];
  filesCacheTimestamp = 0;
}

/**
 * Configuration change watcher for cache invalidation
 */
let configWatcher: { dispose(): void } | undefined;

/**
 * Initialize configuration watcher to clear cache on setting change
 */
export function initializeCompletionHelpers(
  context: vscode.ExtensionContext
): void {
  // Clear cache when the gitignore setting changes (or any config changes)
  const unsubscribe = configService.subscribe(() => {
    clearFilesCache();
    Log.debug("[Completions] Cache cleared due to config change");
  });
  configWatcher = { dispose: unsubscribe };
  context.subscriptions.push(configWatcher);
}

/**
 * Get file completions for @ trigger
 * Returns both file and directory completions
 */
export async function getFileCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const fileItems: PlainCompletionItem[] = [];
  const files = await getWorkspaceFiles();

  // Strip leading quote from quoted-path filter (@"path with spaces/...) so
  // the actual path fragment is matched against relative paths (which never
  // contain a literal double-quote character).
  const normalizedFilterText = filterText.startsWith('"')
    ? filterText.slice(1)
    : filterText;

  // Convert filter text to lowercase and normalize path separators
  const filter = normalizedFilterText.toLowerCase().replace(/\\/g, "/");

  // Track unique directories we've seen
  const directories = new Set<string>();

  const MAX_TOTAL_ITEMS = 500;
  const MAX_FILE_ITEMS = 450; // Leave room for directories so they don't get buried

  for (const fileUri of files) {
    const relativePath = vscode.workspace.asRelativePath(fileUri, false);

    // Simple filtering: check if the path contains the filter text
    if (filter && !relativePath.toLowerCase().includes(filter)) {
      continue;
    }

    const fileName = path.basename(relativePath);
    const dirName = path.dirname(relativePath);

    // Track directory for directory completions (even if we stop adding file items)
    if (dirName !== ".") {
      directories.add(dirName);
    }

    // Add file completion (but don't let files crowd out directory entries)
    if (fileItems.length < MAX_FILE_ITEMS) {
      // Quote paths with spaces so the parser can handle them correctly
      const insertPath = buildFileReferenceValue(relativePath);
      const fileItem: PlainCompletionItem = {
        label: fileName,
        kind: vscode.CompletionItemKind.File,
        insertText: insertPath,
        detail: dirName === "." ? "Root directory" : dirName,
        documentation:
          `**Full file attachment** (CLI-native)\n\n` +
          `Insert: \`${buildFileReference(relativePath)}\`\n\n` +
          `The CLI will automatically attach this file's content.\n\n` +
          `_For line ranges, use \`${buildSelectionReference(relativePath, 10, 20)}\`_`,
        sortText: `0_${relativePath.split(path.sep).length}_${relativePath}`,
        filterText: `${relativePath} ${fileName}`,
      };

      fileItems.push(fileItem);
    }
  }

  // Add directory completions (with trailing slash)
  const dirItems: PlainCompletionItem[] = [];
  for (const dirPath of directories) {
    if (filter && !dirPath.toLowerCase().includes(filter)) {
      continue;
    }

    const dirName = path.basename(dirPath);
    const parentDir = path.dirname(dirPath);

    // Quote directory paths with spaces so the parser can handle them correctly
    const insertDirPath = buildDirectoryReferenceValue(dirPath);
    const dirItem: PlainCompletionItem = {
      label: dirName + "/",
      kind: vscode.CompletionItemKind.Folder,
      insertText: insertDirPath,
      detail: parentDir === "." ? "Root directory" : parentDir,
      documentation:
        `**Directory structure attachment**\n\n` +
        `Insert: \`${buildDirectoryReference(dirPath)}\`\n\n` +
        `ctrlyoke will attach a file tree of this directory.\n\n` +
        `_No file contents, just structure._`,
      sortText: `0_${dirPath.split(path.sep).length}_0_${dirPath}`,
      filterText: `${dirPath} ${dirName}`,
    };

    dirItems.push(dirItem);
  }

  // Sort by sortText (matches VS Code behavior) so directories bubble up consistently
  const bySortText = (
    a: PlainCompletionItem,
    b: PlainCompletionItem
  ): number => {
    const aKey = a.sortText ?? a.label;
    const bKey = b.sortText ?? b.label;
    return aKey.localeCompare(bKey);
  };

  dirItems.sort(bySortText);
  fileItems.sort(bySortText);

  // Return directories first so UIs that don't honor sortText still surface them
  const remainingForFiles = Math.max(0, MAX_TOTAL_ITEMS - dirItems.length);
  return [...dirItems, ...fileItems.slice(0, remainingForFiles)];
}

/**
 * Get symbol completions for # trigger
 * Shows workspace symbols from all file types
 */
async function getSymbolCompletions(
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

      const startLine = symbol.location.range.start.line + 1;
      const endLine = symbol.location.range.end.line + 1;

      // Insert #sym:path/to/file.ts:SymbolName:123-145
      // Quote paths with spaces so FileReferenceParser can handle them correctly
      const insertText = buildSymbolReferenceValue(
        relativePath,
        symbol.name,
        startLine,
        endLine
      );

      // Show symbol kind and location
      const symbolKindName = vscode.SymbolKind[symbol.kind];

      // Map SymbolKind to CompletionItemKind for proper icon/color
      const completionKind = mapSymbolKindToCompletionKind(symbol.kind);

      const item: PlainCompletionItem = {
        label: symbol.name,
        kind: completionKind,
        insertText: insertText,
        detail: `${symbolKindName} in ${relativePath}:${startLine}-${endLine}`,
        documentation:
          `**Symbol Reference**\n\n` +
          `Type: ${symbolKindName}\n\n` +
          `Location: \`${relativePath}:${startLine}-${endLine}\`\n\n` +
          `Insert: \`${buildSymbolReference(relativePath, symbol.name, startLine, endLine)}\`\n\n` +
          `_ctrlyoke will attach this symbol's recorded line range._`,
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
function getSelectionCompletions(): PlainCompletionItem[] {
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

    // Format: #selection:path:startLine-endLine
    // Quote paths with spaces so FileReferenceParser can handle them correctly
    const completionText = buildSelectionReferenceValue(
      relativePath,
      startLine,
      endLine
    );

    // Create label with file name and line range
    // Label must start with "selection" so both VS Code and CodeMirror can
    // prefix-match it when the user types #s, #sel, #selection, etc.
    const fileName = path.basename(relativePath);
    const label =
      visibleEditors.length > 1
        ? `selection: ${fileName} (lines ${startLine}-${endLine})`
        : `selection: Current Selection`;

    // Get preview of selected text (first 100 chars)
    const selectedText = document.getText(selection);
    const preview =
      selectedText.length > 100
        ? selectedText.substring(0, 100) + "..."
        : selectedText;

    const item: PlainCompletionItem = {
      label: label,
      kind: vscode.CompletionItemKind.Reference,
      insertText: completionText,
      detail: `Lines ${startLine}-${endLine} in ${relativePath}`,
      documentation:
        `Insert reference to selected code:\n\n\`${buildSelectionReference(relativePath, startLine, endLine)}\`\n\n` +
        `**Preview:**\n\`\`\`\n${preview}\n\`\`\``,
      sortText: `!000_selection_${selectionIndex.toString().padStart(3, "0")}`,
      filterText: `selection ${relativePath} ${fileName} current`,
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

// ============================================================================
// Git change completions (~ trigger)
// ============================================================================

interface GitCache {
  commits: CommitInfo[];
  stashes: StashInfo[];
  timestamp: number;
}

interface GitSearchCache {
  query: string;
  commits: CommitInfo[];
  timestamp: number;
}

let gitCache: GitCache | null = null;
let gitSearchCache: GitSearchCache | null = null;
const GIT_CACHE_DURATION_MS = 10_000; // 10 seconds

/**
 * Get completions for ~ trigger (git change context: diff, staged, stash, commits)
 */
export async function getGitChangeCompletions(
  workspaceRoot: string,
  filterText: string
): Promise<PlainCompletionItem[]> {
  const now = Date.now();

  // Always keep stashes + recent commits in the base cache
  if (!gitCache || now - gitCache.timestamp >= GIT_CACHE_DURATION_MS) {
    try {
      const [commits, stashes] = await Promise.all([
        getRecentCommits(workspaceRoot, 50),
        getStashList(workspaceRoot),
      ]);
      gitCache = { commits, stashes, timestamp: now };
    } catch {
      gitCache = { commits: [], stashes: [], timestamp: now };
    }
  }

  // When the user is actively filtering, search all history via git --grep
  // so they can find any commit regardless of how far back it is.
  let commits: CommitInfo[];
  if (filterText) {
    const searchStale =
      !gitSearchCache ||
      gitSearchCache.query !== filterText ||
      now - gitSearchCache.timestamp >= GIT_CACHE_DURATION_MS;

    if (searchStale) {
      try {
        commits = await searchCommitsBySubject(workspaceRoot, filterText, 200);
        gitSearchCache = { query: filterText, commits, timestamp: now };
      } catch {
        // Fall back to local filtering of base cache
        commits = gitCache.commits;
        gitSearchCache = null;
      }
    } else {
      commits = gitSearchCache!.commits;
    }
  } else {
    commits = gitCache.commits;
  }

  const { stashes } = gitCache;

  const items: PlainCompletionItem[] = [];

  // Always-present: ~diff and ~staged
  items.push({
    label: "diff — Working tree changes",
    kind: vscode.CompletionItemKind.Reference,
    insertText: "diff",
    detail: "All uncommitted changes",
    sortText: "!000_git_0",
    filterText: "diff working tree changes uncommitted",
  });

  items.push({
    label: "staged — Staged changes",
    kind: vscode.CompletionItemKind.Reference,
    insertText: "staged",
    detail: "Changes in the index (git add)",
    sortText: "!000_git_1",
    filterText: "staged index git add cached",
  });

  // Stash items
  for (const stash of stashes) {
    items.push({
      label: `stash:${stash.index} — ${stash.subject}`,
      kind: vscode.CompletionItemKind.Reference,
      insertText: `stash:${stash.index}`,
      detail: stash.relativeDate,
      sortText: `!000_git_stash_${String(stash.index).padStart(3, "0")}`,
      filterText: `stash ${stash.index} ${stash.subject} ${stash.relativeDate}`,
    });
  }

  // Commit items — most recent first
  commits.forEach((commit, idx) => {
    items.push({
      label: `${commit.shortHash} — ${commit.subject}`,
      kind: vscode.CompletionItemKind.Reference,
      insertText: commit.hash,
      detail: `${commit.author}, ${commit.relativeDate}`,
      sortText: `!001_git_commit_${String(idx).padStart(3, "0")}`,
      filterText: `${commit.hash} ${commit.shortHash} ${commit.subject} ${commit.author}`,
    });
  });

  // Apply filter if provided
  if (!filterText) {
    return items;
  }
  const lower = filterText.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      (item.detail?.toLowerCase().includes(lower) ?? false) ||
      (item.filterText?.toLowerCase().includes(lower) ?? false)
  );
}

export function getPriorContextCompletions(
  filterText: string
): PlainCompletionItem[] {
  const keywords = [
    { label: "previous", detail: "Output of the previous step" },
    { label: "all", detail: "Outputs of all prior steps" },
    { label: "finalStep", detail: "Previous finalStep output" },
    { label: "allFinalStep", detail: "All finalStep outputs" },
    { label: "step:", detail: "Specific steps, e.g. $step:1,3-5" },
  ];

  return keywords
    .filter((keyword) => keyword.label.startsWith(filterText))
    .map((keyword) => ({
      label: keyword.label,
      kind: vscode.CompletionItemKind.Keyword,
      insertText: keyword.label,
      detail: keyword.detail,
    }));
}

/**
 * Convert plain completion item to VS Code completion item
 */
export function toVSCodeCompletionItem(
  item: PlainCompletionItem,
  _triggerChar: "@" | "#" | "~" | "$",
  range?: vscode.Range
): vscode.CompletionItem {
  const vscodeItem = new vscode.CompletionItem(item.label, item.kind);
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

/**
 * Extensions recognized as prompt file references when the entire prompt
 * value is a lone file path (no surrounding text).
 */
const PROMPT_REF_EXTENSIONS = [".prompt.md", ".md", ".txt"];

/**
 * Get completions for the file-path trigger in the prompt editor.
 * Only returns .prompt.md / .md / .txt files, with full ./relative paths as
 * insertText so the completion replaces the entire typed path.
 */
export async function getPromptFileCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const files = await getWorkspaceFiles();

  // Strip any leading ./ ../ or / from the filter so we compare against bare relative paths
  const normalizedFilter = filterText
    .replace(/^\.\.?\//, "")
    .replace(/^\//, "")
    .toLowerCase()
    .replace(/\\/g, "/");

  const items: PlainCompletionItem[] = [];

  for (const fileUri of files) {
    const relativePath = vscode.workspace
      .asRelativePath(fileUri, false)
      .replace(/\\/g, "/");
    const lower = relativePath.toLowerCase();

    if (!PROMPT_REF_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      continue;
    }

    if (normalizedFilter && !lower.includes(normalizedFilter)) {
      continue;
    }

    const fileName = path.basename(relativePath);
    const dirName = path.dirname(relativePath);
    const insertPath = `./${relativePath}`;

    items.push({
      label: fileName,
      kind: vscode.CompletionItemKind.File,
      insertText: insertPath,
      detail: dirName === "." ? "Root" : dirName,
      documentation: `**Prompt file reference**\n\nPath: \`${insertPath}\``,
      sortText: `${relativePath.split("/").length}_${relativePath}`,
      filterText: `${relativePath} ${fileName}`,
    });

    if (items.length >= 200) break;
  }

  return items;
}
