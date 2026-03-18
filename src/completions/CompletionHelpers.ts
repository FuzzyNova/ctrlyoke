import * as vscode from "vscode";
import * as path from "path";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import {
  getRecentCommits,
  getStashList,
  type CommitInfo,
  type StashInfo,
} from "../utils/GitUtils";

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
 * Get all workspace files (with caching)
 */
async function getWorkspaceFiles(): Promise<vscode.Uri[]> {
  const now = Date.now();

  // Return cached results if still valid
  if (
    filesCache.length > 0 &&
    filesCacheTimestamp &&
    now - filesCacheTimestamp < CACHE_DURATION_MS
  ) {
    Log.debug(
      `[Completions] Returning cached files (${filesCache.length} files)`
    );
    return filesCache;
  }

  const respectGitignore =
    ConfigurationUtils.shouldRespectGitignoreForCompletions();

  // Get ALL files (only exclude .git database directory - never useful in prompts)
  // NOTE: VS Code's findFiles() does NOT respect .gitignore regardless of exclude parameter
  // See: https://github.com/microsoft/vscode/issues/48674
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/.git/**" // Only exclude Git database directory
  );

  Log.trace(`[Completions] Found ${files.length} total files before filtering`);

  // OFF: Return ALL files (node_modules, dist, logs, everything)
  // ON:  Filter out gitignored files using Git extension API
  const filteredFiles = respectGitignore
    ? await filterGitIgnoredFiles(files)
    : files;

  Log.trace(
    `[Completions] Returning ${filteredFiles.length} files (respectGitignore=${respectGitignore}, filtered out ${files.length - filteredFiles.length})`
  );

  // Sample a few files for debugging (first 10)
  if (filteredFiles.length > 0) {
    const sample = filteredFiles
      .slice(0, 10)
      .map((f) => vscode.workspace.asRelativePath(f));
    Log.debug(`[Completions] Sample files: ${sample.join(", ")}`);
  }

  // Update cache
  filesCache = filteredFiles;
  filesCacheTimestamp = now;

  return filteredFiles;
}

/**
 * Track if we're currently filtering to prevent recursive calls
 */
let isFiltering = false;

/**
 * Filter out gitignored files using Git extension API
 * @param files All workspace files
 * @returns Files that are NOT gitignored
 */
async function filterGitIgnoredFiles(
  files: vscode.Uri[]
): Promise<vscode.Uri[]> {
  // Guard against recursive or concurrent calls
  if (isFiltering) {
    Log.warn(
      "[Completions] filterGitIgnoredFiles called recursively - returning files unfiltered"
    );
    return files;
  }

  isFiltering = true;
  try {
    Log.debug("[Completions] Starting gitignore filtering");

    // Get Git extension
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) {
      Log.warn(
        "[Completions] Git extension not found, cannot filter .gitignore files"
      );
      return files;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const gitApi = gitExtension.exports.getAPI(1);
    if (!gitApi) {
      Log.warn("[Completions] Git API not available");
      return files;
    }

    Log.debug(
      `[Completions] Git API available, repositories: ${gitApi.repositories.length}`
    );

    // Group files by repository (using repo path as key to avoid object identity issues)
    const filesByRepoPath = new Map<
      string,
      { repo: any; files: vscode.Uri[] }
    >();
    const nonGitFiles: vscode.Uri[] = [];

    for (const file of files) {
      const repo = gitApi.getRepository(file);
      if (repo) {
        const repoPath = repo.rootUri.fsPath;
        if (!filesByRepoPath.has(repoPath)) {
          filesByRepoPath.set(repoPath, { repo, files: [] });
        }
        filesByRepoPath.get(repoPath)!.files.push(file);
      } else {
        // Not in a Git repo - keep it
        nonGitFiles.push(file);
      }
    }

    Log.debug(
      `[Completions] Grouped into ${filesByRepoPath.size} repositories, ${nonGitFiles.length} non-git files`
    );

    // Check gitignore status per repository
    const filteredFiles: vscode.Uri[] = [...nonGitFiles];
    let repoIndex = 0;

    for (const [
      repoPath,
      { repo, files: repoFiles },
    ] of filesByRepoPath.entries()) {
      repoIndex++;
      Log.debug(
        `[Completions] Processing repo ${repoIndex}/${filesByRepoPath.size}: ${repoFiles.length} files from ${repoPath}`
      );

      // Process in batches to avoid overwhelming the Git API
      const BATCH_SIZE = 500;
      const keptFiles: vscode.Uri[] = [];

      for (let i = 0; i < repoFiles.length; i += BATCH_SIZE) {
        const batch = repoFiles.slice(i, i + BATCH_SIZE);
        const filePaths = batch.map((uri) => uri.fsPath);

        Log.debug(
          `[Completions] Checking batch ${i}-${Math.min(i + BATCH_SIZE, repoFiles.length)} (${batch.length} files)`
        );

        try {
          const ignoredSet = await repo.checkIgnore(filePaths);
          Log.debug(
            `[Completions] checkIgnore returned ${ignoredSet.size} ignored files`
          );

          // Keep only non-ignored files
          const kept = batch.filter((uri) => !ignoredSet.has(uri.fsPath));
          keptFiles.push(...kept);
        } catch (batchError) {
          Log.error(
            `[Completions] Failed to check batch ${i}-${i + BATCH_SIZE}:`,
            batchError
          );
          // On error, keep all files in this batch (fail open)
          keptFiles.push(...batch);
        }
      }

      filteredFiles.push(...keptFiles);

      const filteredCount = repoFiles.length - keptFiles.length;
      Log.debug(
        `[Completions] Filtered ${filteredCount} gitignored files from ${repoPath} (kept ${keptFiles.length})`
      );
    }

    Log.debug("[Completions] Gitignore filtering complete");
    return filteredFiles;
  } catch (error) {
    Log.error("[Completions] Failed to filter gitignored files:", error);
    return files; // Fallback: return all files
  } finally {
    isFiltering = false;
  }
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
let configWatcher: vscode.Disposable | undefined;

/**
 * Initialize configuration watcher to clear cache on setting change
 */
export function initializeCompletionHelpers(
  context: vscode.ExtensionContext
): void {
  // Clear cache when gitignore setting changes
  configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("flightpath.respectGitignoreForCompletions")) {
      clearFilesCache();
      Log.debug("[Completions] Cache cleared due to gitignore setting change");
    }
  });

  context.subscriptions.push(configWatcher);
}

/**
 * Dispose resources
 * NOTE: Dead code — configWatcher is pushed to context.subscriptions and
 * disposed automatically by VS Code. Kept as private for potential future use.
 */
function disposeCompletionHelpers(): void {
  configWatcher?.dispose();
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

  // Convert filter text to lowercase and normalize path separators
  const filter = filterText.toLowerCase().replace(/\\/g, "/");

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
      const insertPath = relativePath.includes(" ")
        ? `"${relativePath}"`
        : relativePath;
      const fileItem: PlainCompletionItem = {
        label: fileName,
        kind: vscode.CompletionItemKind.File,
        insertText: insertPath,
        detail: dirName === "." ? "Root directory" : dirName,
        documentation:
          `**Full file attachment** (CLI-native)\n\n` +
          `Insert: \`@${insertPath}\`\n\n` +
          `The CLI will automatically attach this file's content.\n\n` +
          `_For line ranges, use \`#selection:${insertPath}:10-20\`_`,
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
    const insertDirPath = dirPath.includes(" ")
      ? `"${dirPath}/"`
      : dirPath + "/";
    const dirItem: PlainCompletionItem = {
      label: dirName + "/",
      kind: vscode.CompletionItemKind.Folder,
      insertText: insertDirPath,
      detail: parentDir === "." ? "Root directory" : parentDir,
      documentation:
        `**Directory structure attachment**\n\n` +
        `Insert: \`@${insertDirPath}\`\n\n` +
        `FlightPath will attach a file tree of this directory.\n\n` +
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
      // Quote paths with spaces so FileReferenceParser can handle them correctly
      const quotedPath = relativePath.includes(" ")
        ? `"${relativePath}"`
        : relativePath;
      const insertText = `sym:${quotedPath}:${symbol.name}:${line}`;

      // Show symbol kind and location
      const symbolKindName = vscode.SymbolKind[symbol.kind];

      // Map SymbolKind to CompletionItemKind for proper icon/color
      const completionKind = mapSymbolKindToCompletionKind(symbol.kind);

      const item: PlainCompletionItem = {
        label: symbol.name,
        kind: completionKind,
        insertText: insertText,
        detail: `${symbolKindName} in ${relativePath}:${line}`,
        documentation:
          `**Symbol Reference**\n\n` +
          `Type: ${symbolKindName}\n\n` +
          `Location: \`${relativePath}:${line}\`\n\n` +
          `Insert: \`#sym:${quotedPath}:${symbol.name}:${line}\`\n\n` +
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

    // Format: #selection:path:startLine-endLine
    // Quote paths with spaces so FileReferenceParser can handle them correctly
    const quotedPath = relativePath.includes(" ")
      ? `"${relativePath}"`
      : relativePath;
    const completionText = `selection:${quotedPath}:${startLine}-${endLine}`;

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
        `Insert reference to selected code:\n\n\`#${completionText}\`\n\n` +
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

let gitCache: GitCache | null = null;
const GIT_CACHE_DURATION_MS = 10_000; // 10 seconds

/**
 * Get completions for ~ trigger (git change context: diff, staged, stash, commits)
 */
export async function getGitChangeCompletions(
  workspaceRoot: string,
  filterText: string
): Promise<PlainCompletionItem[]> {
  const now = Date.now();

  // Refresh cache if stale
  if (!gitCache || now - gitCache.timestamp >= GIT_CACHE_DURATION_MS) {
    try {
      const [commits, stashes] = await Promise.all([
        getRecentCommits(workspaceRoot, 30),
        getStashList(workspaceRoot),
      ]);
      gitCache = { commits, stashes, timestamp: now };
    } catch {
      gitCache = { commits: [], stashes: [], timestamp: now };
    }
  }

  const { commits, stashes } = gitCache;

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

/**
 * Convert plain completion item to VS Code completion item
 */
export function toVSCodeCompletionItem(
  item: PlainCompletionItem,
  triggerChar: "@" | "#" | "~",
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
