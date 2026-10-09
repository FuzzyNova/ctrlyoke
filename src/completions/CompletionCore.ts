import * as path from "path";
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
import { fuzzyMatches, rankByFuzzyQuery } from "./FuzzyRanking";
import { getPriorContextCompletionItems } from "./PriorContextCompletions";
import {
  COMPLETION_ITEM_KINDS,
  GIT_CHANGE_KINDS,
  GIT_REFERENCE_ICONS,
  WORKSPACE_ENTRY_KINDS,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";
import { SYMBOL_KIND_ICONS } from "../types/SymbolKindConstants";
import { CAPTURING_OUTPUT_PLACEHOLDER } from "../types/DashboardConstants";
import {
  LspSymbolKind,
  type IndexedSymbol,
  type SymbolIndex,
} from "./SymbolIndex";
import type {
  EditorContextSource,
  EditorSelection,
} from "./EditorContextSource";
import {
  getCommitByHash,
  getRecentCommits,
  getStashList,
  searchCommitsBySubject,
  type CommitInfo,
  type StashInfo,
} from "../utils/GitUtils";

export interface PlainCompletionItem {
  label: string;
  kind: number;
  insertText: string;
  /**
   * Set only on output-capture completion items; the picker resolves it via
   * the output snapshot save command.
   */
  captureId?: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  /**
   * 0-based position in this response's fuzzy relevance ranking (see
   * FuzzyRanking.ts). A response containing ranked items is shown by the
   * webview dropdown in the order sent, with no client-side filtering or
   * re-sorting, so every other item in that response must already match.
   */
  rank?: number;
  /**
   * Explicit codicon name overriding the webview dropdown's default
   * kind-derived icon. It must name an icon supported by the atomic-reference
   * icon/color map and should match the icon of the reference it inserts.
   * VS Code's native IntelliSense has no per-item custom icon support, so its
   * adapter uses `kind` instead.
   */
  icon?: string;
}

export interface CompletionWorkspace {
  /** Git-aware tracked and non-ignored untracked paths, normalized per root. */
  getFiles(): Promise<string[]>;
  isMultiRoot(): boolean;
  symbols?: SymbolIndex;
  editorContext?: EditorContextSource;
}

const SYMBOL_PREFIX_LENGTH = 3;
const PROMPT_EXTENSIONS = [".prompt.md", ".md", ".txt"];
const GIT_CACHE_DURATION_MS = 10_000;
interface GitCache {
  workspaceRoot: string;
  commits: CommitInfo[];
  stashes: StashInfo[];
  timestamp: number;
}
interface GitSearchCache {
  workspaceRoot: string;
  query: string;
  commits: CommitInfo[];
  timestamp: number;
}

export function mapSymbolKindToCompletionKind(kind: LspSymbolKind): number {
  switch (kind) {
    case LspSymbolKind.File:
      return COMPLETION_ITEM_KINDS.FILE;
    case LspSymbolKind.Module:
    case LspSymbolKind.Namespace:
    case LspSymbolKind.Package:
      return COMPLETION_ITEM_KINDS.SYMBOL_MODULE;
    case LspSymbolKind.Class:
      return COMPLETION_ITEM_KINDS.CLASS;
    case LspSymbolKind.Method:
      return COMPLETION_ITEM_KINDS.METHOD;
    case LspSymbolKind.Property:
    case LspSymbolKind.Key:
      return COMPLETION_ITEM_KINDS.PROPERTY;
    case LspSymbolKind.Field:
      return COMPLETION_ITEM_KINDS.FIELD;
    case LspSymbolKind.Constructor:
      return COMPLETION_ITEM_KINDS.CONSTRUCTOR;
    case LspSymbolKind.Enum:
      return COMPLETION_ITEM_KINDS.ENUM;
    case LspSymbolKind.Interface:
      return COMPLETION_ITEM_KINDS.INTERFACE;
    case LspSymbolKind.Function:
      return COMPLETION_ITEM_KINDS.FUNCTION;
    case LspSymbolKind.Variable:
      return COMPLETION_ITEM_KINDS.VARIABLE;
    case LspSymbolKind.Constant:
      return COMPLETION_ITEM_KINDS.CONSTANT;
    case LspSymbolKind.EnumMember:
      return COMPLETION_ITEM_KINDS.ENUM_MEMBER;
    case LspSymbolKind.Struct:
      return COMPLETION_ITEM_KINDS.STRUCT;
    case LspSymbolKind.Event:
      return COMPLETION_ITEM_KINDS.EVENT;
    case LspSymbolKind.Operator:
      return COMPLETION_ITEM_KINDS.OPERATOR;
    case LspSymbolKind.TypeParameter:
      return COMPLETION_ITEM_KINDS.TYPE_PARAMETER;
    case LspSymbolKind.String:
    case LspSymbolKind.Number:
    case LspSymbolKind.Boolean:
    case LspSymbolKind.Array:
    case LspSymbolKind.Object:
    case LspSymbolKind.Null:
      return COMPLETION_ITEM_KINDS.VALUE;
    default:
      return COMPLETION_ITEM_KINDS.GENERIC_REFERENCE;
  }
}

export function mapSymbolKindToReferenceKind(
  kind: LspSymbolKind
): string | undefined {
  const enumName = LspSymbolKind[kind];
  if (!enumName) return undefined;
  const name = enumName
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    .replace(/^-/, "");
  return Object.prototype.hasOwnProperty.call(SYMBOL_KIND_ICONS, name)
    ? name
    : undefined;
}

export class CompletionCore {
  private files: string[] = [];
  private filesAt = 0;
  private paths: Array<{
    kind: string;
    relativePath: string;
    name: string;
    parent: string;
  }> = [];
  private pathsFor?: string[];
  private gitCache: GitCache | null = null;
  private gitSearchCache: GitSearchCache | null = null;

  constructor(private readonly workspace: CompletionWorkspace) {}

  setSymbolIndex(symbols: SymbolIndex): void {
    this.workspace.symbols = symbols;
  }

  clearCache(): void {
    this.files = [];
    this.filesAt = 0;
    this.pathsFor = undefined;
  }

  private async pathEntries(): Promise<typeof this.paths> {
    const now = Date.now();
    if (this.files.length && now - this.filesAt < 5000) return this.paths;
    const files = await this.workspace.getFiles();
    if (this.pathsFor === files) return this.paths;
    const dirs = new Set<string>();
    const entries: typeof this.paths = [];
    for (const raw of files) {
      const relativePath = normalizeReferencePath(raw);
      if (!relativePath || relativePath.startsWith("../")) continue;
      let parent = path.posix.dirname(relativePath);
      while (parent !== "." && parent !== "") {
        dirs.add(parent);
        parent = path.posix.dirname(parent);
      }
      entries.push({
        kind: WORKSPACE_ENTRY_KINDS.FILE,
        relativePath,
        name: path.posix.basename(relativePath),
        parent: path.posix.dirname(relativePath),
      });
    }
    for (const relativePath of dirs)
      entries.push({
        kind: WORKSPACE_ENTRY_KINDS.DIRECTORY,
        relativePath,
        name: path.posix.basename(relativePath),
        parent: path.posix.dirname(relativePath),
      });
    this.files = files;
    this.filesAt = now;
    this.pathsFor = files;
    this.paths = entries;
    return entries;
  }

  async getFileCompletions(query: string): Promise<PlainCompletionItem[]> {
    const entries = await this.pathEntries();
    const filter = normalizeReferencePath(query)
      .replace(/^"/, "")
      .toLowerCase();
    const hasPath = filter.includes("/");
    const endsInSlash = filter.endsWith("/");
    const parentPath = hasPath
      ? (endsInSlash
          ? filter.slice(0, -1)
          : filter.slice(0, filter.lastIndexOf("/"))
        ).replace(/\/+$/, "")
      : "";
    const childPrefix =
      hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
    const candidates = entries.filter((entry) => {
      if (!filter) return true;
      if (!hasPath)
        return fuzzyMatches(`${entry.name} ${entry.relativePath}`, filter);
      return (
        entry.parent.toLowerCase() === parentPath &&
        (!childPrefix || fuzzyMatches(entry.name, childPrefix))
      );
    });
    const queryForRank = hasPath ? childPrefix : filter;
    const ranked = queryForRank
      ? rankByFuzzyQuery(queryForRank, candidates, [
          (entry) => entry.name,
          (entry) => entry.relativePath,
        ])
      : candidates;
    const outputItems = this.outputCompletions(filter);
    const toItem = (
      entry: (typeof entries)[number],
      rank: number
    ): PlainCompletionItem => {
      const directory = entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY;
      const depth = entry.relativePath.split("/").length;
      return {
        label: entry.name + (directory ? "/" : ""),
        kind: directory
          ? COMPLETION_ITEM_KINDS.FOLDER
          : COMPLETION_ITEM_KINDS.FILE,
        insertText: directory
          ? buildDirectoryReferenceValue(entry.relativePath)
          : buildFileReferenceValue(entry.relativePath),
        detail: entry.parent === "." ? "Root directory" : entry.parent,
        documentation: directory
          ? `**Directory structure attachment**\n\nInsert: \`${buildDirectoryReference(entry.relativePath)}\`\n\nctrlyoke will attach a file tree of this directory.\n\n_No file contents, just structure._`
          : `**Full file attachment** (CLI-native)\n\nInsert: \`${buildFileReference(entry.relativePath)}\`\n\nThe CLI will automatically attach this file's content.\n\n_For line ranges, use \`${buildSelectionReference(entry.relativePath, 10, 20)}\`_`,
        sortText: queryForRank
          ? `0_${String(rank).padStart(6, "0")}`
          : `0_${depth}_${entry.relativePath}`,
        filterText: `${entry.name} ${entry.relativePath}`,
        ...(queryForRank ? { rank } : {}),
      };
    };
    if (queryForRank) {
      return [
        ...outputItems,
        ...ranked.slice(0, Math.max(0, 500 - outputItems.length)).map(toItem),
      ].map((item, rank) =>
        item.rank === undefined
          ? item
          : { ...item, rank: rank - outputItems.length }
      );
    }
    const directories = ranked
      .filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY)
      .map((entry, rank) => toItem(entry, rank));
    const files = [
      ...outputItems,
      ...ranked
        .filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.FILE)
        .map((entry, rank) => toItem(entry, rank)),
    ];
    return [...directories, ...files].slice(0, 500);
  }

  async getPromptFileCompletions(
    query: string
  ): Promise<PlainCompletionItem[]> {
    const entries = await this.pathEntries();
    const filter = normalizeReferencePath(query)
      .replace(/^\.\.?\//, "")
      .replace(/^\//, "")
      .toLowerCase();
    const hasPath = filter.includes("/");
    const endsInSlash = filter.endsWith("/");
    const parent = hasPath
      ? (endsInSlash
          ? filter.slice(0, -1)
          : filter.slice(0, filter.lastIndexOf("/"))
        ).replace(/\/+$/, "")
      : "";
    const child =
      hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
    const selected = entries.filter(
      (entry) =>
        entry.kind === WORKSPACE_ENTRY_KINDS.FILE &&
        PROMPT_EXTENSIONS.some((ext) =>
          entry.relativePath.toLowerCase().endsWith(ext)
        ) &&
        (!filter ||
          (hasPath
            ? entry.parent.toLowerCase() === parent &&
              (!child || fuzzyMatches(entry.name, child))
            : fuzzyMatches(`${entry.name} ${entry.relativePath}`, filter)))
    );
    const shouldRank = Boolean(child || (filter && !hasPath));
    const ranked = child
      ? rankByFuzzyQuery(child, selected, [(e) => e.name])
      : filter && !hasPath
        ? rankByFuzzyQuery(filter, selected, [
            (e) => e.name,
            (e) => e.relativePath,
          ])
        : [...selected].sort((a, b) =>
            `${a.relativePath.split("/").length}_${a.relativePath}`.localeCompare(
              `${b.relativePath.split("/").length}_${b.relativePath}`
            )
          );
    return ranked.slice(0, 200).map((entry, rank) => {
      const insertPath = this.workspace.isMultiRoot()
        ? entry.relativePath
        : `./${entry.relativePath}`;
      return {
        label: entry.name,
        kind: COMPLETION_ITEM_KINDS.FILE,
        insertText: insertPath,
        detail: entry.parent === "." ? "Root" : entry.parent,
        documentation: `**Prompt file reference**\n\nPath: \`${insertPath}\``,
        sortText: shouldRank
          ? String(rank).padStart(6, "0")
          : `${entry.relativePath.split("/").length}_${entry.relativePath}`,
        filterText: `${entry.name} ${entry.relativePath}`,
        ...(shouldRank ? { rank } : {}),
      };
    });
  }

  getHashSelectionCompletions(): PlainCompletionItem[] {
    const sourceSelections =
      this.workspace.editorContext?.getSelections() ?? [];
    const seen = new Set<string>();
    const selections = sourceSelections.filter((selection) => {
      const key = `${selection.viewerPath}:${selection.startLine}-${selection.endLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return selections.map((selection, index) =>
      this.selectionItem(
        selection,
        index,
        selection.visibleEditorCount ?? selections.length
      )
    );
  }

  async getHashCompletions(query: string): Promise<PlainCompletionItem[]> {
    const selections = this.getHashSelectionCompletions().filter((item) =>
      fuzzyMatches(item.filterText ?? item.label, query)
    );
    const symbols = await this.getSymbolCompletions(query);
    return [...selections, ...symbols];
  }

  async findSymbolKindForReference(
    viewerPath: string,
    name: string,
    startLine: number,
    endLine: number
  ): Promise<number | undefined> {
    const index = this.workspace.symbols;
    if (!index) return undefined;
    const find = (symbols: IndexedSymbol[]) =>
      symbols.find(
        (symbol) =>
          symbol.name === name &&
          symbol.viewerPath === viewerPath &&
          symbol.startLine === startLine &&
          symbol.endLine === endLine
      );
    try {
      const document = find(await index.documentSymbols(viewerPath));
      if (document) return mapSymbolKindToCompletionKind(document.kind);
      const workspace = find(await index.workspaceSymbols(name, 500));
      return workspace
        ? mapSymbolKindToCompletionKind(workspace.kind)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async getGitChangeCompletions(
    workspaceRoot: string,
    filterText: string
  ): Promise<PlainCompletionItem[]> {
    const now = Date.now();
    if (
      !this.gitCache ||
      this.gitCache.workspaceRoot !== workspaceRoot ||
      now - this.gitCache.timestamp >= GIT_CACHE_DURATION_MS
    ) {
      try {
        const [commits, stashes] = await Promise.all([
          getRecentCommits(workspaceRoot, 50),
          getStashList(workspaceRoot),
        ]);
        this.gitCache = { workspaceRoot, commits, stashes, timestamp: now };
      } catch {
        this.gitCache = {
          workspaceRoot,
          commits: [],
          stashes: [],
          timestamp: now,
        };
      }
    }
    let commits = this.gitCache!.commits;
    if (filterText) {
      const stale =
        !this.gitSearchCache ||
        this.gitSearchCache.workspaceRoot !== workspaceRoot ||
        this.gitSearchCache.query !== filterText ||
        now - this.gitSearchCache.timestamp >= GIT_CACHE_DURATION_MS;
      if (stale) {
        try {
          const [searched, byHash] = await Promise.all([
            searchCommitsBySubject(workspaceRoot, filterText, 200),
            getCommitByHash(workspaceRoot, filterText),
          ]);
          const seen = new Set<string>();
          commits = [
            ...this.gitCache.commits,
            ...searched,
            ...(byHash ? [byHash] : []),
          ].filter((commit) => {
            if (seen.has(commit.hash)) return false;
            seen.add(commit.hash);
            return true;
          });
          this.gitSearchCache = {
            workspaceRoot,
            query: filterText,
            commits,
            timestamp: now,
          };
        } catch {
          this.gitSearchCache = null;
        }
      } else commits = this.gitSearchCache!.commits;
    }
    const cache = this.gitCache!;
    const items: PlainCompletionItem[] = [
      {
        label: "diff — Working tree changes",
        kind: COMPLETION_ITEM_KINDS.REFERENCE,
        insertText: "diff",
        icon: GIT_REFERENCE_ICONS[GIT_CHANGE_KINDS.DIFF],
        detail: "All uncommitted changes",
        sortText: "!000_git_0",
        filterText: "diff working tree changes uncommitted",
      },
      {
        label: "staged — Staged changes",
        kind: COMPLETION_ITEM_KINDS.REFERENCE,
        insertText: "staged",
        icon: GIT_REFERENCE_ICONS[GIT_CHANGE_KINDS.STAGED],
        detail: "Changes in the index (git add)",
        sortText: "!000_git_1",
        filterText: "staged index git add cached",
      },
      ...cache.stashes.map((stash) => ({
        label: `stash:${stash.index} — ${stash.subject}`,
        kind: COMPLETION_ITEM_KINDS.REFERENCE,
        insertText: `stash:${stash.index}`,
        icon: GIT_REFERENCE_ICONS[GIT_CHANGE_KINDS.STASH],
        detail: stash.relativeDate,
        sortText: `!000_git_stash_${String(stash.index).padStart(3, "0")}`,
        filterText: `stash ${stash.index} ${stash.subject} ${stash.relativeDate}`,
      })),
      ...commits.map((commit, index) => ({
        label: `${commit.shortHash} — ${commit.subject}`,
        kind: COMPLETION_ITEM_KINDS.REFERENCE,
        insertText: commit.hash,
        icon: GIT_REFERENCE_ICONS[GIT_CHANGE_KINDS.COMMIT],
        detail: `${commit.author}, ${commit.relativeDate}`,
        sortText: `!001_git_commit_${String(index).padStart(3, "0")}`,
        filterText: `${commit.hash} ${commit.shortHash} ${commit.subject} ${commit.author}`,
      })),
    ];
    if (!filterText) return items;
    const lower = filterText.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) ||
        (item.detail?.toLowerCase().includes(lower) ?? false) ||
        (item.filterText?.toLowerCase().includes(lower) ?? false)
    );
  }

  getSecretCompletions(
    secretNames: readonly string[],
    filterText: string
  ): PlainCompletionItem[] {
    return [...new Set(secretNames)]
      .filter((name) => fuzzyMatches(name, filterText))
      .sort()
      .map((name) => ({
        label: name,
        kind: COMPLETION_ITEM_KINDS.VARIABLE,
        insertText: name,
        detail: "Secret name (value is never shown)",
        icon: "key",
      }));
  }

  getPriorContextCompletions(filterText: string): PlainCompletionItem[] {
    return getPriorContextCompletionItems(filterText);
  }

  async getPathSuggestions(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults = 3
  ): Promise<string[]> {
    const normalized = normalizeReferencePath(typedPath)
      .replace(/^\.\.?\//, "")
      .replace(/\/+$/, "");
    const base = path.posix.basename(normalized).toLowerCase();
    if (!base) return [];
    const parent = path.posix.dirname(normalized);
    const directory = kind === WORKSPACE_ENTRY_KINDS.DIRECTORY;
    const entries = (await this.pathEntries()).filter(
      (entry) =>
        entry.kind ===
        (directory
          ? WORKSPACE_ENTRY_KINDS.DIRECTORY
          : WORKSPACE_ENTRY_KINDS.FILE)
    );
    const ranked = entries
      .flatMap((entry) => {
        const candidate = entry.name.toLowerCase();
        const sameDir = entry.parent === parent;
        const prefix = base.startsWith(candidate) || candidate.startsWith(base);
        const tier =
          sameDir && prefix
            ? 0
            : sameDir && fuzzyMatches(candidate, base)
              ? 1
              : candidate === base
                ? 2
                : prefix
                  ? 3
                  : -1;
        return tier < 0 || entry.relativePath === normalized
          ? []
          : [{ entry, tier, delta: Math.abs(candidate.length - base.length) }];
      })
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          a.delta - b.delta ||
          a.entry.relativePath.localeCompare(b.entry.relativePath)
      );
    return ranked
      .slice(0, maxResults)
      .map(({ entry }) =>
        directory
          ? buildDirectoryReference(entry.relativePath)
          : buildFileReference(entry.relativePath)
      );
  }

  private outputCompletions(query: string): PlainCompletionItem[] {
    return (this.workspace.editorContext?.getVisibleOutputChannels() ?? [])
      .filter((channel) => fuzzyMatches(`${channel.channel} output`, query))
      .map((channel) => ({
        label: `${channel.channel} (Output)`,
        kind: COMPLETION_ITEM_KINDS.FILE,
        insertText: CAPTURING_OUTPUT_PLACEHOLDER,
        captureId: channel.captureId,
        detail: "Output channel snapshot",
        documentation: `**Output channel attachment**\n\nCapture the current contents of the '${channel.channel}' output channel and attach it as a file.\n\n_The snapshot is captured when this completion is listed and saved when it is picked._`,
        sortText: `0_0_output_${channel.channel}`,
        filterText: `${channel.channel} output`,
      }));
  }

  private selectionItem(
    selection: EditorSelection,
    index: number,
    selectionCount: number
  ): PlainCompletionItem {
    const isOutput = selection.isOutput;
    const channel = selection.outputChannel ?? selection.viewerPath;
    const preview =
      selection.text.length > 100
        ? `${selection.text.substring(0, 100)}...`
        : selection.text;
    return {
      label:
        selectionCount > 1
          ? `selection: ${path.posix.basename(selection.viewerPath)} (lines ${selection.startLine}-${selection.endLine})`
          : "selection: Current Selection",
      kind: COMPLETION_ITEM_KINDS.UNIT,
      insertText: isOutput
        ? CAPTURING_OUTPUT_PLACEHOLDER
        : buildSelectionReferenceValue(
            selection.viewerPath,
            selection.startLine,
            selection.endLine
          ),
      captureId: selection.captureId,
      detail: `Lines ${selection.startLine}-${selection.endLine} in ${selection.viewerPath}`,
      documentation: isOutput
        ? `Capture the selected lines from the '${channel}' output channel as an attachment.\n\n**Preview:**\n\n\`${preview}\``
        : `Insert reference to selected code:\n\n\`${buildSelectionReference(selection.viewerPath, selection.startLine, selection.endLine)}\`\n\n**Preview:**\n\n\`${preview}\``,
      sortText: `0_!000_selection_${index.toString().padStart(3, "0")}`,
      filterText: `selection ${selection.viewerPath} ${path.posix.basename(selection.viewerPath)} current`,
    };
  }

  private async getSymbolCompletions(
    query: string
  ): Promise<PlainCompletionItem[]> {
    if (!this.workspace.symbols) return [];
    try {
      const prefix = query.slice(0, SYMBOL_PREFIX_LENGTH);
      const [full, abbreviated] = await Promise.all([
        this.workspace.symbols.workspaceSymbols(query, 500),
        prefix === query
          ? []
          : this.workspace.symbols.workspaceSymbols(prefix, 500),
      ]);
      const key = (s: IndexedSymbol) =>
        `${s.viewerPath}::${s.name}::${s.kind}::${s.startLine}:${s.endLine}`;
      const fullKeys = new Set(full.map(key));
      const union = new Map<string, IndexedSymbol>();
      [...full, ...abbreviated].forEach((symbol) =>
        union.set(key(symbol), symbol)
      );
      const candidates = [...union.values()].map((symbol) => ({
        symbol,
        matchedFull: fullKeys.has(key(symbol)),
      }));
      let ranked = candidates;
      if (query) {
        const fuzzy = rankByFuzzyQuery(query, candidates, [
          (c) => c.symbol.name,
          (c) => c.symbol.viewerPath,
        ]);
        const set = new Set(fuzzy);
        ranked = [
          ...fuzzy,
          ...candidates.filter(
            (candidate) => candidate.matchedFull && !set.has(candidate)
          ),
        ];
      }
      return ranked.slice(0, 500).map(({ symbol }, rank) => {
        const kind = LspSymbolKind[symbol.kind] ?? "Unknown";
        const referenceKind = mapSymbolKindToReferenceKind(symbol.kind);
        return {
          label: symbol.name,
          kind: mapSymbolKindToCompletionKind(symbol.kind),
          insertText: buildSymbolReferenceValue(
            symbol.viewerPath,
            symbol.name,
            symbol.startLine,
            symbol.endLine,
            referenceKind
          ),
          detail: `${kind} in ${symbol.viewerPath}:${symbol.startLine}-${symbol.endLine}`,
          documentation: `**Symbol Reference**\n\nType: ${kind}\n\nLocation: \`${symbol.viewerPath}:${symbol.startLine}-${symbol.endLine}\`\n\nInsert: \`${buildSymbolReference(symbol.viewerPath, symbol.name, symbol.startLine, symbol.endLine, referenceKind)}\`\n\n_ctrlyoke will attach this symbol's recorded line range._`,
          sortText: query
            ? `1_${String(rank).padStart(6, "0")}`
            : `1_${symbol.name}`,
          filterText: `${symbol.name} ${symbol.viewerPath}`,
          ...(query ? { rank } : {}),
        };
      });
    } catch {
      return [];
    }
  }
}
