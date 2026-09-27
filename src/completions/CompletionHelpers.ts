import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { getWorkspaceSymbols } from "../utils/AttachmentBuilders";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { configService } from "../config/CtrlYokeConfigService";
import { isMultiRootWorkspace } from "../platform/VsCodeWorkspaceRoot";
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
  normalizeReferencePath,
} from "./ContextReferenceBuilder";
import { SYMBOL_KIND_ICONS } from "../types/SymbolKindConstants";
import { outputCaptureCache } from "./OutputCaptureCache";
import { clearSlashTokenCompletionCache } from "./SlashTokenCompletionHelpers";
import {
  buildFuzzyIndex,
  fuzzyMatches,
  rankByFuzzyQuery,
  rankIndexByFuzzyQuery,
  type FuzzyIndex,
} from "./FuzzyRanking";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  VSCODE_COMMANDS,
  WORKSPACE_ENTRY_KINDS,
  VSCODE_URI_SCHEMES,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";

export {
  clearSlashTokenCompletionCache,
  getCtrlYokeSlashCompletions,
  getMcpTokenCompletions,
  getSkillTokenCompletions,
  type McpTokenCompletionItem,
  type SkillTokenCompletionItem,
  type SlashTokenCompletionItem,
} from "./SlashTokenCompletionHelpers";

/**
 * Plain completion item (framework-agnostic)
 * Can be converted to vscode.CompletionItem or sent to webview
 */
export interface PlainCompletionItem {
  label: string;
  kind: vscode.CompletionItemKind;
  insertText: string;
  // Set only on output-capture completion items; the picker resolves it via SAVE_OUTPUT_SNAPSHOT.
  captureId?: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  /**
   * 0-based position in this response's fuzzy relevance ranking (see
   * FuzzyRanking.ts). Set only by sources that rank against the typed query.
   * A response containing ranked items is shown by the webview dropdown in the
   * order sent, with no client-side filtering or re-sorting (see
   * buildCodeMirrorCompletionResult) — so every other item in that response
   * must already be filtered against the query too.
   */
  rank?: number;
  /**
   * Explicit codicon name overriding the webview dropdown's default
   * kind-derived icon (see COMPLETION_KIND_ICONS in CodeMirrorEditor.tsx).
   * `vscode.CompletionItemKind` has too few free values to give every atomic
   * reference kind (secret, prior-context, condition-output) its own icon
   * without colliding with a symbol/file/git meaning already assigned to that
   * kind, so this field is the escape hatch — it must name one of the icons
   * in SYMBOL_ICON_COLORS (atomicReferences.ts) to pick up matching color/
   * accent CSS, and should match the icon the same reference's chip uses
   * (see describeContextReferenceChip / describePriorContextChip /
   * describeConditionOutputChip / describeSlashTokenChip) so the completion
   * and the chip it inserts always agree. Ignored by toVSCodeCompletionItem —
   * VS Code's native IntelliSense has no per-item custom icon support, so
   * `kind` alone still drives that surface.
   */
  icon?: string;
}

/** Build value-free completion items for managed or declared secret names. */
export function getSecretCompletions(
  secretNames: readonly string[],
  filterText: string
): PlainCompletionItem[] {
  return [...new Set(secretNames)]
    .filter((name) => fuzzyMatches(name, filterText))
    .sort()
    .map((name) => ({
      label: name,
      kind: vscode.CompletionItemKind.Variable,
      insertText: name,
      detail: "Secret name (value is never shown)",
      icon: "key",
    }));
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
 * Convert a vscode.SymbolKind enum value to the persisted kind name used in a
 * #sym.<kind>: reference. Unknown enum values intentionally remain unkinded so
 * a newer VS Code kind cannot produce a token the renderer does not recognize.
 */
export function mapSymbolKindToReferenceKind(
  symbolKind: vscode.SymbolKind
): string | undefined {
  const enumName = vscode.SymbolKind[symbolKind];
  if (typeof enumName !== "string") {
    return undefined;
  }

  const kindName = enumName
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    .replace(/^-/, "");
  return Object.prototype.hasOwnProperty.call(SYMBOL_KIND_ICONS, kindName)
    ? kindName
    : undefined;
}

/**
 * Resolve the CompletionItemKind for an already-inserted #sym: reference, by
 * its exact name and 1-based line range, for icon purposes (the reference
 * text itself carries no kind — only a live completion item does). Used by
 * WebviewMessageRouter's context-reference validation to let the dashboard
 * chip show the real symbol-kind icon instead of a generic fallback.
 *
 * Tries executeDocumentSymbolProvider first (cheap, single file), then falls
 * back to executeWorkspaceSymbolProvider. The fallback matters: the #sym:
 * completion list itself is built from getWorkspaceSymbols() (below), whose
 * navigateTo-style index frequently surfaces symbols — deeply nested object
 * keys, CSS custom properties inside a JS style object, etc. — that the
 * document outline (executeDocumentSymbolProvider) never includes at all, and
 * even when both include a symbol, the two providers aren't guaranteed to
 * report the same range for it. Without this fallback, any reference created
 * from such a completion item can never resolve and is stuck on the generic
 * icon forever.
 */
export async function findSymbolKindForReference(
  uri: vscode.Uri,
  symbolName: string,
  startLine: number,
  endLine: number
): Promise<vscode.CompletionItemKind | undefined> {
  try {
    const documentMatch = await findSymbolKindViaDocumentSymbols(
      uri,
      symbolName,
      startLine,
      endLine
    );
    if (documentMatch !== undefined) {
      return documentMatch;
    }
    return await findSymbolKindViaWorkspaceSymbols(
      uri,
      symbolName,
      startLine,
      endLine
    );
  } catch (error) {
    Log.error(
      "[Completions] Failed to resolve symbol kind for reference:",
      error
    );
    return undefined;
  }
}

async function findSymbolKindViaDocumentSymbols(
  uri: vscode.Uri,
  symbolName: string,
  startLine: number,
  endLine: number
): Promise<vscode.CompletionItemKind | undefined> {
  const symbols = (await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    uri
  )) as vscode.DocumentSymbol[] | undefined;
  if (!symbols?.length) {
    return undefined;
  }

  const match = findDocumentSymbolByNameAndRange(
    symbols,
    symbolName,
    startLine,
    endLine
  );
  return match ? mapSymbolKindToCompletionKind(match.kind) : undefined;
}

// Mirrors getSymbolCompletions()'s own provider call (same command, same
// query-by-name) so the range comparison below is apples-to-apples with
// whatever range that function used to build the original reference.
async function findSymbolKindViaWorkspaceSymbols(
  uri: vscode.Uri,
  symbolName: string,
  startLine: number,
  endLine: number
): Promise<vscode.CompletionItemKind | undefined> {
  const symbols = (await vscode.commands.executeCommand(
    "vscode.executeWorkspaceSymbolProvider",
    symbolName
  )) as vscode.SymbolInformation[] | undefined;
  if (!symbols?.length) {
    return undefined;
  }

  const match = findWorkspaceSymbolByUriNameAndRange(
    symbols,
    uri,
    symbolName,
    startLine,
    endLine
  );
  return match ? mapSymbolKindToCompletionKind(match.kind) : undefined;
}

// Exported for unit testing only; findSymbolKindForReference is the real entry point.
export function findWorkspaceSymbolByUriNameAndRange(
  symbols: vscode.SymbolInformation[],
  uri: vscode.Uri,
  name: string,
  startLine: number,
  endLine: number
): vscode.SymbolInformation | undefined {
  return symbols.find(
    (symbol) =>
      symbol.name === name &&
      symbol.location.uri.toString() === uri.toString() &&
      symbol.location.range.start.line + 1 === startLine &&
      symbol.location.range.end.line + 1 === endLine
  );
}

// Exported for unit testing only; findSymbolKindForReference is the real entry point.
export function findDocumentSymbolByNameAndRange(
  symbols: vscode.DocumentSymbol[],
  name: string,
  startLine: number,
  endLine: number
): vscode.DocumentSymbol | undefined {
  for (const symbol of symbols) {
    if (
      symbol.name === name &&
      symbol.range.start.line + 1 === startLine &&
      symbol.range.end.line + 1 === endLine
    ) {
      return symbol;
    }
    const childMatch = findDocumentSymbolByNameAndRange(
      symbol.children,
      name,
      startLine,
      endLine
    );
    if (childMatch) {
      return childMatch;
    }
  }
  return undefined;
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
  pathIndexCache = undefined;
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
    clearSlashTokenCompletionCache();
    Log.debug("[Completions] Cache cleared due to config change");
  });
  configWatcher = { dispose: unsubscribe };
  context.subscriptions.push(configWatcher);
}

interface PathCompletionFilter {
  normalized: string;
  hasPathContext: boolean;
  parentPath: string;
  childPrefix: string;
}

function getNormalizedWorkspaceRelativePath(fileUri: vscode.Uri): string {
  // Multi-root: folder-name-prefixed (`root2/src/index.ts`) so the ref is
  // unambiguous and resolvable without probing every root. Single-root keeps
  // today's unprefixed form.
  return normalizeReferencePath(
    vscode.workspace.asRelativePath(fileUri, isMultiRootWorkspace())
  );
}

function getNormalizedParentDirectory(relativePath: string): string {
  const parentPath = path.posix.dirname(relativePath);
  return parentPath === "." ? "" : parentPath;
}

function buildPathCompletionFilter(
  filterText: string,
  options?: {
    stripLeadingQuote?: boolean;
    stripPromptPathPrefixes?: boolean;
  }
): PathCompletionFilter {
  let normalized = normalizeReferencePath(filterText).toLowerCase();

  if (options?.stripLeadingQuote && normalized.startsWith('"')) {
    normalized = normalized.slice(1);
  }

  if (options?.stripPromptPathPrefixes) {
    normalized = normalized.replace(/^\.\.?\//, "").replace(/^\//, "");
  }

  if (!normalized.includes("/")) {
    return {
      normalized,
      hasPathContext: false,
      parentPath: "",
      childPrefix: normalized,
    };
  }

  const endsWithSlash = normalized.endsWith("/");
  const parentPath = (
    endsWithSlash
      ? normalized.slice(0, -1)
      : normalized.slice(0, normalized.lastIndexOf("/"))
  ).replace(/\/+$/, "");

  return {
    normalized,
    hasPathContext: true,
    parentPath,
    childPrefix: endsWithSlash
      ? ""
      : normalized.slice(normalized.lastIndexOf("/") + 1),
  };
}

/** One file or directory in the workspace, as offered by path completions. */
interface WorkspacePathEntry {
  kind:
    typeof WORKSPACE_ENTRY_KINDS.FILE | typeof WORKSPACE_ENTRY_KINDS.DIRECTORY;
  /** Normalized, workspace-relative (folder-prefixed in multi-root). */
  relativePath: string;
  name: string;
  parentPath: string;
  /** Lowercased parentPath, for matching a typed directory case-insensitively. */
  parentPathLower: string;
}

interface WorkspacePathIndex {
  /** The getWorkspaceFiles() result this index was built from. */
  source: vscode.Uri[];
  multiRoot: boolean;
  /** Files, then every ancestor directory of a file. */
  entries: WorkspacePathEntry[];
  /** Built lazily on the first non-empty query. */
  fuzzy?: FuzzyIndex<WorkspacePathEntry>;
}

let pathIndexCache: WorkspacePathIndex | undefined;

function createWorkspacePathEntry(
  kind: WorkspacePathEntry["kind"],
  relativePath: string
): WorkspacePathEntry {
  const parentPath = getNormalizedParentDirectory(relativePath);
  return {
    kind,
    relativePath,
    name: path.posix.basename(relativePath),
    parentPath,
    parentPathLower: parentPath.toLowerCase(),
  };
}

/**
 * Every workspace file and directory, rebuilt only when getWorkspaceFiles()
 * refreshes its own cache, so per-keystroke completion requests reuse the
 * relative paths and fuzzy index instead of recomputing them.
 */
async function getWorkspacePathIndex(): Promise<WorkspacePathIndex> {
  const files = await getWorkspaceFiles();
  const multiRoot = isMultiRootWorkspace();
  if (
    pathIndexCache?.source === files &&
    pathIndexCache.multiRoot === multiRoot
  ) {
    return pathIndexCache;
  }

  const entries: WorkspacePathEntry[] = [];
  const directories = new Set<string>();
  for (const fileUri of files) {
    const relativePath = getNormalizedWorkspaceRelativePath(fileUri);
    collectWorkspaceDirectories(relativePath, directories);
    entries.push(
      createWorkspacePathEntry(WORKSPACE_ENTRY_KINDS.FILE, relativePath)
    );
  }
  for (const directory of directories) {
    entries.push(
      createWorkspacePathEntry(WORKSPACE_ENTRY_KINDS.DIRECTORY, directory)
    );
  }

  pathIndexCache = { source: files, multiRoot, entries };
  return pathIndexCache;
}

function getWorkspacePathFuzzyIndex(
  index: WorkspacePathIndex
): FuzzyIndex<WorkspacePathEntry> {
  // Basename first so a name match outranks a match spread across the path.
  index.fuzzy ??= buildFuzzyIndex(index.entries, [
    (entry) => entry.name,
    (entry) => entry.relativePath,
  ]);
  return index.fuzzy;
}

/**
 * The path entries a typed filter selects. `ranked` is true when `entries` is
 * already in fuzzy relevance order (best first); otherwise the caller owns the
 * ordering (an empty query, or a typed directory with no child name yet).
 *
 * A typed directory (`src/ui/co`) restricts candidates to that directory's
 * direct children and fuzzy-matches only the child name; a bare query
 * (`codeeditor`) fuzzy-matches every entry's name and full path.
 */
function selectWorkspacePathEntries(
  index: WorkspacePathIndex,
  filter: PathCompletionFilter,
  include: (entry: WorkspacePathEntry) => boolean
): { entries: WorkspacePathEntry[]; ranked: boolean } {
  if (filter.hasPathContext) {
    const siblings = index.entries.filter(
      (entry) => entry.parentPathLower === filter.parentPath && include(entry)
    );
    return filter.childPrefix
      ? {
          entries: rankByFuzzyQuery(filter.childPrefix, siblings, [
            (entry) => entry.name,
          ]),
          ranked: true,
        }
      : { entries: siblings, ranked: false };
  }

  if (!filter.normalized) {
    return { entries: index.entries.filter(include), ranked: false };
  }

  return {
    entries: rankIndexByFuzzyQuery(
      filter.normalized,
      getWorkspacePathFuzzyIndex(index)
    ).filter(include),
    ranked: true,
  };
}

/** Whether a single path (e.g. an output channel slug) passes the typed filter. */
function matchesPathCompletionFilter(
  candidatePath: string,
  filter: PathCompletionFilter
): boolean {
  const entry = createWorkspacePathEntry(
    WORKSPACE_ENTRY_KINDS.FILE,
    candidatePath
  );
  if (filter.hasPathContext) {
    return (
      entry.parentPathLower === filter.parentPath &&
      fuzzyMatches(entry.name, filter.childPrefix)
    );
  }
  return (
    fuzzyMatches(entry.name, filter.normalized) ||
    fuzzyMatches(entry.relativePath, filter.normalized)
  );
}

/** Zero-padded so rank-derived sortText sorts lexically in rank order. */
function formatRankSortKey(rank: number): string {
  return rank.toString().padStart(6, "0");
}

function collectWorkspaceDirectories(
  relativePath: string,
  directories: Set<string>
): void {
  const segments = relativePath.split("/");
  for (let index = 1; index < segments.length; index++) {
    directories.add(segments.slice(0, index).join("/"));
  }
}

export function getOutputChannelSlug(document: vscode.TextDocument): string {
  return vscode.workspace.asRelativePath(document.uri, isMultiRootWorkspace());
}

function cacheOutputCapture(
  document: vscode.TextDocument,
  text: string,
  range: { startLine: number; endLine: number } | undefined
): { captureId: string; channel: string } {
  const captureId = crypto.randomUUID();
  const channel = getOutputChannelSlug(document);
  outputCaptureCache.set(captureId, { text, channel, range });
  return { captureId, channel };
}

/**
 * Get file completions for @ trigger
 * Returns both file and directory completions
 */
export async function getFileCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const index = await getWorkspacePathIndex();
  const filter = buildPathCompletionFilter(filterText, {
    stripLeadingQuote: true,
  });

  const MAX_TOTAL_ITEMS = 500;
  const MAX_FILE_ITEMS = 450; // Leave room for directories so they don't get buried

  const outputItems = getOutputChannelCompletions(filter);
  const { entries, ranked } = selectWorkspacePathEntries(
    index,
    filter,
    () => true
  );

  if (ranked) {
    // Truncate only after ranking, so the best matches always survive the cap.
    const rankedItems = entries
      .slice(0, MAX_TOTAL_ITEMS - outputItems.length)
      .map((entry, rank) => ({
        ...buildWorkspacePathCompletion(entry),
        sortText: `0_${formatRankSortKey(rank)}`,
        rank,
      }));
    return [...outputItems, ...rankedItems];
  }

  const bySortText = (
    a: PlainCompletionItem,
    b: PlainCompletionItem
  ): number => {
    const aKey = a.sortText ?? a.label;
    const bKey = b.sortText ?? b.label;
    return aKey.localeCompare(bKey);
  };

  // Unfiltered listing: sort by sortText (matches VS Code behavior) so
  // directories bubble up consistently, and return them first so UIs that
  // don't honor sortText still surface them.
  const dirItems = entries
    .filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY)
    .map(buildWorkspacePathCompletion)
    .sort(bySortText);
  const fileItems = [
    ...outputItems,
    ...entries
      .filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.FILE)
      .map(buildWorkspacePathCompletion),
  ]
    .sort(bySortText)
    .slice(0, MAX_FILE_ITEMS);

  const remainingForFiles = Math.max(0, MAX_TOTAL_ITEMS - dirItems.length);
  return [...dirItems, ...fileItems.slice(0, remainingForFiles)];
}

function getOutputChannelCompletions(
  filter: PathCompletionFilter
): PlainCompletionItem[] {
  const items: PlainCompletionItem[] = [];
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== VSCODE_URI_SCHEMES.OUTPUT) {
      continue;
    }

    const channel = getOutputChannelSlug(editor.document);
    if (!matchesPathCompletionFilter(channel, filter)) {
      continue;
    }

    const { captureId } = cacheOutputCapture(
      editor.document,
      editor.document.getText(),
      undefined
    );
    items.push({
      label: `${channel} (Output)`,
      kind: vscode.CompletionItemKind.File,
      insertText: CAPTURING_OUTPUT_PLACEHOLDER,
      captureId,
      detail: "Output channel snapshot",
      documentation:
        `**Output channel attachment**\n\n` +
        `Capture the current contents of the '${channel}' output channel ` +
        `and attach it as a file.\n\n` +
        `_The snapshot is captured when this completion is listed and saved when it is picked._`,
      sortText: `0_0_output_${channel}`,
      filterText: `${channel} output`,
    });
  }
  return items;
}

function buildWorkspacePathCompletion(
  entry: WorkspacePathEntry
): PlainCompletionItem {
  const depth = entry.relativePath.split("/").length;
  if (entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY) {
    return {
      label: entry.name + "/",
      kind: vscode.CompletionItemKind.Folder,
      // Quote directory paths with spaces so the parser can handle them correctly
      insertText: buildDirectoryReferenceValue(entry.relativePath),
      detail: entry.parentPath ? entry.parentPath : "Root directory",
      documentation:
        `**Directory structure attachment**\n\n` +
        `Insert: \`${buildDirectoryReference(entry.relativePath)}\`\n\n` +
        `ctrlyoke will attach a file tree of this directory.\n\n` +
        `_No file contents, just structure._`,
      sortText: `0_${depth}_0_${entry.relativePath}`,
      filterText: `${entry.name} ${entry.relativePath}`,
    };
  }

  return {
    label: entry.name,
    kind: vscode.CompletionItemKind.File,
    // Quote paths with spaces so the parser can handle them correctly
    insertText: buildFileReferenceValue(entry.relativePath),
    detail: entry.parentPath ? entry.parentPath : "Root directory",
    documentation:
      `**Full file attachment** (CLI-native)\n\n` +
      `Insert: \`${buildFileReference(entry.relativePath)}\`\n\n` +
      `The CLI will automatically attach this file's content.\n\n` +
      `_For line ranges, use \`${buildSelectionReference(entry.relativePath, 10, 20)}\`_`,
    sortText: `0_${depth}_${entry.relativePath}`,
    filterText: `${entry.name} ${entry.relativePath}`,
  };
}

// Count leading path segments (case-insensitive) two relative paths share,
// excluding the basename itself — a proximity measure for tie-breaking a moved
// file toward the nearest match to where it was typed.
function sharedPathPrefixLength(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length) - 1;
  let shared = 0;
  for (let index = 0; index < limit; index++) {
    if (a[index].toLowerCase() !== b[index].toLowerCase()) break;
    shared++;
  }
  return shared;
}

/**
 * Rank workspace paths as "did you mean?" suggestions for an @file / @directory
 * reference whose typed path did not resolve — powers the lint quick-fixes in
 * CodeMirrorEditor (createContextReferenceLintExtension). Returns ready-to-insert
 * reference tokens (e.g. `@src/foo/Bar.ts`, quoting applied) so reference
 * formatting stays single-sourced in ContextReferenceBuilder.
 *
 * Ranking (highest signal first), deduped and capped at maxResults:
 *   0. Same directory + a prefix relationship between the typed and candidate
 *      basename — catches the token-collapse bug (`Foo.tsxbar` → `Foo.tsx`) and
 *      truncation (`CodeMirrorEdi` → `CodeMirrorEditor.tsx`) with no false hits.
 *   1. Same directory + a fuzzy basename match (typos/transpositions).
 *   2. Exact basename anywhere — a moved file or a wrong middle path segment.
 *   3. A basename prefix relationship anywhere — a moved + slightly-renamed file.
 * Plain fuzzy-anywhere is deliberately excluded to keep suggestions high-precision.
 * Within a tier: closest basename length first, then nearest by shared path
 * prefix, then lexical for determinism.
 */
export async function getPathSuggestions(
  typedPath: string,
  kind: WorkspaceFileTreeEntryKind,
  maxResults = 3
): Promise<string[]> {
  const normalizedTyped = normalizeReferencePath(typedPath)
    .replace(/^\.\.?\//, "")
    .replace(/\/+$/, "");
  const typedBase = path.posix.basename(normalizedTyped).toLowerCase();
  if (!typedBase) {
    return [];
  }
  const typedParent = getNormalizedParentDirectory(normalizedTyped);
  const typedSegments = normalizedTyped.split("/");

  // Candidates: files for @file; unique ancestor directories for @directory.
  const candidateKind =
    kind === WORKSPACE_ENTRY_KINDS.DIRECTORY
      ? WORKSPACE_ENTRY_KINDS.DIRECTORY
      : WORKSPACE_ENTRY_KINDS.FILE;
  const candidatePaths = (await getWorkspacePathIndex()).entries
    .filter((entry) => entry.kind === candidateKind)
    .map((entry) => entry.relativePath);

  const ranked: Array<{
    relativePath: string;
    tier: number;
    lengthDelta: number;
    sharedPrefix: number;
  }> = [];

  for (const relativePath of candidatePaths) {
    if (relativePath === normalizedTyped) {
      continue; // identical to the (non-resolving) input — nothing to suggest
    }
    const candBase = path.posix.basename(relativePath).toLowerCase();
    if (!candBase) continue;

    const sameDir = getNormalizedParentDirectory(relativePath) === typedParent;
    const prefixRel =
      typedBase.startsWith(candBase) || candBase.startsWith(typedBase);
    const basenameExact = candBase === typedBase;
    const fuzzy = fuzzyMatches(candBase, typedBase);

    let tier: number;
    if (sameDir && prefixRel) {
      tier = 0;
    } else if (sameDir && fuzzy) {
      tier = 1;
    } else if (basenameExact) {
      tier = 2;
    } else if (prefixRel) {
      tier = 3;
    } else {
      continue;
    }

    ranked.push({
      relativePath,
      tier,
      lengthDelta: Math.abs(candBase.length - typedBase.length),
      sharedPrefix: sharedPathPrefixLength(
        typedSegments,
        relativePath.split("/")
      ),
    });
  }

  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.lengthDelta - b.lengthDelta ||
      b.sharedPrefix - a.sharedPrefix ||
      a.relativePath.localeCompare(b.relativePath)
  );

  return ranked
    .slice(0, maxResults)
    .map((entry) =>
      kind === WORKSPACE_ENTRY_KINDS.DIRECTORY
        ? buildDirectoryReference(entry.relativePath)
        : buildFileReference(entry.relativePath)
    );
}

/**
 * Length of the extra, shortened workspace-symbol query sent alongside the
 * full one. `vscode.executeWorkspaceSymbolProvider` applies no matching of its
 * own — it returns exactly what each language's provider returns — and
 * tsserver's `navto` (the TS/JS provider) only matches an all-lowercase query
 * as one contiguous run, so `usecontext` never returns
 * `useFinalStepContextMenu` (only `useContext` would). Querying the first few
 * characters as well widens the candidate set enough for our own fuzzy
 * ranking to find it. Kept short but not a single character, since tsserver
 * caps navto at 256 results and a one-letter query would fill that cap with
 * noise.
 */
const SYMBOL_CANDIDATE_PREFIX_LENGTH = 3;

/**
 * Workspace symbols for the full query plus its short prefix (see
 * SYMBOL_CANDIDATE_PREFIX_LENGTH), de-duplicated, with `matchedFullQuery`
 * marking the ones the provider itself returned for the full query.
 */
async function getWorkspaceSymbolCandidates(
  filterText: string
): Promise<
  Array<{ symbol: vscode.SymbolInformation; matchedFullQuery: boolean }>
> {
  const prefix = filterText.slice(0, SYMBOL_CANDIDATE_PREFIX_LENGTH);
  const [fullMatches, prefixMatches] = await Promise.all([
    getWorkspaceSymbols(filterText),
    prefix === filterText ? [] : getWorkspaceSymbols(prefix),
  ]);

  const candidates = new Map<
    string,
    { symbol: vscode.SymbolInformation; matchedFullQuery: boolean }
  >();
  const add = (
    symbol: vscode.SymbolInformation,
    matchedFullQuery: boolean
  ): void => {
    const { uri, range } = symbol.location;
    const key = `${uri.toString()}::${symbol.name}::${symbol.kind}::${range.start.line}:${range.start.character}`;
    if (!candidates.has(key)) {
      candidates.set(key, { symbol, matchedFullQuery });
    }
  };
  fullMatches.forEach((symbol) => add(symbol, true));
  prefixMatches.forEach((symbol) => add(symbol, false));
  return [...candidates.values()];
}

/**
 * Get symbol completions for # trigger
 * Shows workspace symbols from all file types, fuzzy-ranked against the query
 */
async function getSymbolCompletions(
  filterText: string,
  maxResults: number = 500
): Promise<PlainCompletionItem[]> {
  const items: PlainCompletionItem[] = [];

  try {
    const multiRoot = isMultiRootWorkspace();
    const candidates = (await getWorkspaceSymbolCandidates(filterText)).map(
      (candidate) => ({
        ...candidate,
        relativePath: vscode.workspace.asRelativePath(
          candidate.symbol.location.uri,
          multiRoot
        ),
      })
    );
    let ranked = candidates;
    if (filterText) {
      const fuzzyRanked = rankByFuzzyQuery(filterText, candidates, [
        (candidate) => candidate.symbol.name,
        (candidate) => candidate.relativePath,
      ]);
      // Keep anything the provider matched on the full query that fuzzysort
      // can't see (e.g. a `Container.member` query), after the ranked matches.
      const rankedSet = new Set(fuzzyRanked);
      ranked = [
        ...fuzzyRanked,
        ...candidates.filter(
          (candidate) => candidate.matchedFullQuery && !rankedSet.has(candidate)
        ),
      ];
    }

    for (const [rank, { symbol, relativePath }] of ranked
      .slice(0, maxResults)
      .entries()) {
      const startLine = symbol.location.range.start.line + 1;
      const endLine = symbol.location.range.end.line + 1;
      const symbolKindName = vscode.SymbolKind[symbol.kind];
      const referenceKind = mapSymbolKindToReferenceKind(symbol.kind);

      // Insert #sym:path/to/file.ts:SymbolName:123-145
      // Quote paths with spaces so FileReferenceParser can handle them correctly
      const insertText = buildSymbolReferenceValue(
        relativePath,
        symbol.name,
        startLine,
        endLine,
        referenceKind
      );

      // Show symbol kind and location
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
          `Insert: \`${buildSymbolReference(relativePath, symbol.name, startLine, endLine, referenceKind)}\`\n\n` +
          `_ctrlyoke will attach this symbol's recorded line range._`,
        sortText: filterText ? formatRankSortKey(rank) : symbol.name,
        filterText: `${symbol.name} ${relativePath}`,
        ...(filterText ? { rank } : {}),
      };

      items.push(item);
    }
  } catch (error) {
    Log.error("[Completions] Failed to get symbol completions:", error);
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
    const relativePath = vscode.workspace.asRelativePath(
      document.uri,
      isMultiRootWorkspace()
    );

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
    const isOutputEditor = document.uri.scheme === VSCODE_URI_SCHEMES.OUTPUT;

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

    const outputCapture = isOutputEditor
      ? cacheOutputCapture(document, selectedText, { startLine, endLine })
      : undefined;
    const completionText = isOutputEditor
      ? CAPTURING_OUTPUT_PLACEHOLDER
      : buildSelectionReferenceValue(relativePath, startLine, endLine);

    const item: PlainCompletionItem = {
      label: label,
      // Unit is otherwise unused by any provider in this file, which makes it
      // a stable, collision-free marker for "this is the selection entry" —
      // git (~) completions use Reference, and without a distinct kind the
      // two were indistinguishable to clients picking an icon by kind.
      kind: vscode.CompletionItemKind.Unit,
      insertText: completionText,
      ...(outputCapture ? { captureId: outputCapture.captureId } : {}),
      detail: `Lines ${startLine}-${endLine} in ${relativePath}`,
      documentation: isOutputEditor
        ? `Capture the selected lines from the '${outputCapture?.channel ?? relativePath}' output channel as an attachment.\n\n` +
          `**Preview:**\n\`\`\`\n${preview}\n\`\`\``
        : `Insert reference to selected code:\n\n\`${buildSelectionReference(relativePath, startLine, endLine)}\`\n\n` +
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
 * Get the selection completions for the # trigger, prefixed with the same
 * sortText the full {@link getHashCompletions} result uses so they bubble to
 * the top consistently.
 *
 * This is synchronous and instant. It is split out from {@link getHashCompletions}
 * so callers can populate the dropdown with the current selection immediately,
 * before the (potentially slow, on large codebases) workspace-symbol query
 * resolves. See the progressive `#` completion flow in the webview router and
 * CodeMirror editor.
 */
export function getHashSelectionCompletions(): PlainCompletionItem[] {
  const selectionItems = getSelectionCompletions();
  selectionItems.forEach((item) => {
    item.sortText = `0_${item.sortText || item.label}`;
  });
  return selectionItems;
}

/**
 * Get all completions for # trigger (selections + symbols)
 */
export async function getHashCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const items: PlainCompletionItem[] = [];

  // 1. Add selection completions FIRST (bubbled to top with sortText).
  // Filtered here because a ranked response is shown unfiltered by the
  // webview (see PlainCompletionItem.rank).
  items.push(
    ...getHashSelectionCompletions().filter((item) =>
      fuzzyMatches(item.filterText ?? item.label, filterText)
    )
  );

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
  // icon mirrors the chip icon the inserted reference will render with (see
  // describePriorContextChip/describeConditionOutputChip in atomicReferences.ts)
  // so the completion never disagrees with what picking it produces.
  const keywords = [
    { label: "previous", detail: "Output of the previous step", icon: "book" },
    { label: "all", detail: "Outputs of all prior steps", icon: "book" },
    {
      label: "finalStep",
      detail: "Previous finalStep output",
      icon: "book",
    },
    {
      label: "allFinalStep",
      detail: "All finalStep outputs",
      icon: "book",
    },
    {
      label: "step:",
      detail: "Specific steps, e.g. $step:1,3-5",
      icon: "book",
    },
    ...[
      SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
      SCRIPT_OUTPUT_SOURCES.END_CONDITION,
    ].flatMap((phase) =>
      Object.values(RETRY_PROMPT_PLACEHOLDERS).map((field) => ({
        label: `${phase}:${field}`,
        detail: `${
          phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
            ? "Pre-condition"
            : "End-condition"
        } script ${field}`,
        icon:
          phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
            ? "shield"
            : "checklist",
      }))
    ),
  ];

  return keywords
    .filter((keyword) => fuzzyMatches(keyword.label, filterText))
    .map((keyword) => ({
      label: keyword.label,
      kind: vscode.CompletionItemKind.Keyword,
      insertText: keyword.label,
      detail: keyword.detail,
      icon: keyword.icon,
    }));
}

/**
 * Convert plain completion item to VS Code completion item
 */
export function toVSCodeCompletionItem(
  item: PlainCompletionItem,
  _triggerChar: "@" | "#" | "~" | "$" | "/" | "!",
  range?: vscode.Range
): vscode.CompletionItem {
  const vscodeItem = new vscode.CompletionItem(item.label, item.kind);
  vscodeItem.insertText = item.captureId
    ? CAPTURING_OUTPUT_PLACEHOLDER
    : item.insertText;
  vscodeItem.detail = item.detail;

  if (item.captureId) {
    vscodeItem.command = {
      command: VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE,
      title: "Resolve output capture",
      arguments: [item.captureId],
    };
  }

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
 * Only returns .prompt.md / .md / .txt files. Single-root workspaces emit
 * ./relative paths; multi-root workspaces emit folder-qualified paths such as
 * root2/path/to/file.prompt.md, matching the other context completions.
 */
export async function getPromptFileCompletions(
  filterText: string
): Promise<PlainCompletionItem[]> {
  const MAX_ITEMS = 200;
  const index = await getWorkspacePathIndex();
  const isMultiRoot = isMultiRootWorkspace();
  const filter = buildPathCompletionFilter(filterText, {
    stripPromptPathPrefixes: true,
  });

  const { entries, ranked } = selectWorkspacePathEntries(
    index,
    filter,
    (entry) =>
      entry.kind === WORKSPACE_ENTRY_KINDS.FILE &&
      PROMPT_REF_EXTENSIONS.some((ext) =>
        entry.relativePath.toLowerCase().endsWith(ext)
      )
  );

  const items = entries.map((entry): PlainCompletionItem => {
    const insertPath = isMultiRoot
      ? entry.relativePath
      : `./${entry.relativePath}`;
    return {
      label: entry.name,
      kind: vscode.CompletionItemKind.File,
      insertText: insertPath,
      detail: entry.parentPath ? entry.parentPath : "Root",
      documentation: `**Prompt file reference**\n\nPath: \`${insertPath}\``,
      sortText: `${entry.relativePath.split("/").length}_${entry.relativePath}`,
      filterText: `${entry.name} ${entry.relativePath}`,
    };
  });

  if (!ranked) {
    return items
      .sort((a, b) => (a.sortText ?? "").localeCompare(b.sortText ?? ""))
      .slice(0, MAX_ITEMS);
  }
  // Truncate only after ranking, so the best matches always survive the cap.
  return items.slice(0, MAX_ITEMS).map((item, rank) => ({
    ...item,
    sortText: formatRankSortKey(rank),
    rank,
  }));
}
