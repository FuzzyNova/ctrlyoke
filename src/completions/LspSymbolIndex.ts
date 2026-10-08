import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { toServerFileUri } from "../server/lsp/LspProtocol";
import {
  LANGUAGE_SERVER_CATALOG,
  type LanguageServerCatalogEntry,
} from "../server/lsp/LanguageServerCatalog";
import {
  LANGUAGE_SERVER_STATUSES,
  LSP_METHODS,
} from "../types/DashboardConstants";
import {
  LspSymbolKind,
  type IndexedSymbol,
  type SymbolIndex,
} from "./SymbolIndex";

export interface LspSymbolQueryHost {
  startLanguages(languageIds: readonly string[]): Promise<void>;
  openWarmupDocument(viewerPath: string, languageId: string): Promise<void>;
  requestForPath(
    viewerPath: string,
    method: string,
    params: unknown
  ): Promise<
    | { descriptor: { capabilities: Record<string, unknown> }; result: unknown }
    | undefined
  >;
  resolveForPath?(viewerPath: string): Promise<
    | {
        id: string;
        languageId: string;
        rootPath: string;
      }
    | undefined
  >;
  onStatusChanged?(listener: (event: { status: string }) => void): {
    dispose(): void;
  };
}

/** Standalone symbol source backed by the managed language-server host. */
export class LspSymbolIndex implements SymbolIndex {
  private warmup?: Promise<void>;
  private ready = false;
  private lifecycleGeneration = 0;
  private readonly servedLanguages = new Set<string>();
  private readonly servedExtensions = new Set<string>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly getFiles: () => Promise<string[]>,
    private readonly host: LspSymbolQueryHost,
    private readonly catalog: readonly LanguageServerCatalogEntry[] = LANGUAGE_SERVER_CATALOG
  ) {
    host.onStatusChanged?.((event) => {
      if (
        event.status === LANGUAGE_SERVER_STATUSES.STOPPED ||
        event.status === LANGUAGE_SERVER_STATUSES.CRASHED
      ) {
        this.ready = false;
        this.lifecycleGeneration++;
        this.warmup = undefined;
        this.servedLanguages.clear();
        this.servedExtensions.clear();
      } else if (event.status === LANGUAGE_SERVER_STATUSES.RUNNING) {
        void this.ensureWarmup().catch(() => undefined);
      }
    });
  }

  isReadyForPath(viewerPath: string): boolean {
    const entry = this.entryForFile(viewerPath);
    return (
      this.servedExtensions.has(path.posix.extname(viewerPath).toLowerCase()) ||
      (!!entry &&
        entry.languages.some((language) => this.servedLanguages.has(language)))
    );
  }

  shouldUseRegexFallback(symbol: IndexedSymbol): boolean {
    return !this.isReadyForPath(symbol.viewerPath);
  }

  async workspaceSymbols(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    if (signal?.aborted) return [];
    const files = await this.getFiles();
    if (!this.ready) {
      void this.ensureWarmup(files).catch(() => undefined);
      return [];
    }
    const symbols: IndexedSymbol[] = [];
    const seenServers = new Set<string>();
    const rootMarkerCache = new Map<string, Promise<boolean>>();
    for (const file of files) {
      if (signal?.aborted) break;
      const entry = this.entryForFile(file);
      const descriptor = await this.host.resolveForPath?.(file);
      if (this.host.resolveForPath && !descriptor) continue;
      const key = descriptor
        ? `${descriptor.id}\n${path.resolve(descriptor.rootPath)}`
        : entry?.id;
      if (!key) continue;
      if (seenServers.has(key)) continue;
      if (
        !this.host.resolveForPath &&
        entry &&
        !(await this.cachedRootMarker(entry, files, rootMarkerCache))
      )
        continue;
      seenServers.add(key);
      try {
        const response = await this.host.requestForPath(
          file,
          LSP_METHODS.WORKSPACE_SYMBOL,
          { query }
        );
        if (!response || signal?.aborted) continue;
        const entries = Array.isArray(response.result)
          ? (response.result as unknown[])
          : [];
        const resultCount = symbols.length;
        for (const rawItem of entries) {
          if (!isWorkspaceSymbol(rawItem)) continue;
          let item: WorkspaceSymbolLike = rawItem;
          if (!item.location.range) {
            try {
              const resolved = await this.host.requestForPath(
                file,
                LSP_METHODS.WORKSPACE_SYMBOL_RESOLVE,
                item
              );
              if (!resolved || !isWorkspaceSymbol(resolved.result)) continue;
              item = resolved.result as WorkspaceSymbolLike;
            } catch {
              continue;
            }
          }
          const symbol = toIndexedSymbol(item, this.workspaceRoot);
          if (symbol) symbols.push(symbol);
        }
        if (symbols.length > resultCount) {
          const language = descriptor?.languageId ?? entry?.languages[0];
          if (language) this.servedLanguages.add(language);
          this.servedExtensions.add(path.posix.extname(file).toLowerCase());
        }
      } catch {
        /* one unavailable server must not hide other languages */
      }
    }
    const unique = new Map<string, IndexedSymbol>();
    for (const symbol of symbols) unique.set(symbolKey(symbol), symbol);
    const results = [...unique.values()].slice(0, Math.max(0, maxResults));
    return results;
  }

  async documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    if (signal?.aborted || !this.ready) return [];
    const uri = toServerFileUri(path.resolve(this.workspaceRoot, viewerPath));
    try {
      const response = await this.host.requestForPath(
        viewerPath,
        LSP_METHODS.DOCUMENT_SYMBOL,
        { textDocument: { uri } }
      );
      if (signal?.aborted || !response || !Array.isArray(response.result))
        return [];
      const symbols: IndexedSymbol[] = [];
      flattenDocumentSymbols(response.result, viewerPath, symbols);
      const entry = this.entryForFile(viewerPath);
      if (entry && symbols.length > 0) {
        for (const language of entry.languages)
          this.servedLanguages.add(language);
        this.servedExtensions.add(path.posix.extname(viewerPath).toLowerCase());
      }
      return symbols;
    } catch {
      return [];
    }
  }

  private async ensureWarmup(files?: string[]): Promise<void> {
    if (this.ready) return;
    if (this.warmup) return this.warmup;
    const pending = (async () => {
      const generation = this.lifecycleGeneration;
      await this.startDetected(files ?? (await this.getFiles()));
      if (generation === this.lifecycleGeneration) this.ready = true;
    })();
    this.warmup = pending;
    try {
      await pending;
    } catch (error) {
      if (this.warmup === pending) this.warmup = undefined;
      throw error;
    }
  }

  private async startDetected(files: string[]): Promise<void> {
    const markerCache = new Map<string, Promise<boolean>>();
    const entries = await Promise.all(
      this.catalog.map(async (entry) =>
        (await this.cachedRootMarker(entry, files, markerCache)) &&
        files.some((file) => this.matchesExtension(entry, file))
          ? entry
          : undefined
      )
    ).then((entries) =>
      entries.filter((entry): entry is LanguageServerCatalogEntry => !!entry)
    );
    const languages = [...new Set(entries.flatMap((entry) => entry.languages))];
    // Startup is requested only once per workspace and the managed backend enforces its global cap.
    await this.host.startLanguages(languages);
    for (const entry of entries) {
      if (!entry.warmup) continue;
      for (const anchor of this.findAnchors(entry, files)) {
        try {
          await this.host.openWarmupDocument(
            anchor,
            this.languageForAnchor(entry, anchor)
          );
        } catch {
          /* unavailable/unapproved servers retain regex fallback */
        }
      }
    }
    if (this.host.resolveForPath) {
      const seen = new Set<string>();
      for (const file of files) {
        const descriptor = await this.host.resolveForPath(file);
        if (!descriptor) continue;
        const key = `${descriptor.id}\n${path.resolve(descriptor.rootPath)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await this.host.openWarmupDocument(file, descriptor.languageId);
        } catch {
          /* unavailable or deleted custom-server anchors retain regex fallback */
        }
      }
    }
  }

  private cachedRootMarker(
    entry: LanguageServerCatalogEntry,
    files: string[],
    cache: Map<string, Promise<boolean>>
  ): Promise<boolean> {
    let result = cache.get(entry.id);
    if (!result) {
      result = this.hasRootMarker(entry, files);
      cache.set(entry.id, result);
    }
    return result;
  }

  private entryForFile(file: string): LanguageServerCatalogEntry | undefined {
    return this.catalog.find((entry) => this.matchesExtension(entry, file));
  }

  private languageForAnchor(
    entry: LanguageServerCatalogEntry,
    viewerPath: string
  ): string {
    const extension = path.posix.extname(viewerPath).toLowerCase();
    const preferred: Record<string, string> = {
      ".tsx": "typescriptreact",
      ".jsx": "javascriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    };
    const language = preferred[extension];
    return language && entry.languages.includes(language)
      ? language
      : entry.languages[0];
  }

  private matchesExtension(
    entry: LanguageServerCatalogEntry,
    file: string
  ): boolean {
    const basename = path.posix.basename(file).toLowerCase();
    return entry.extensions.some(
      (ext) =>
        basename.endsWith(`.${ext.toLowerCase()}`) ||
        basename === ext.toLowerCase()
    );
  }

  private async hasRootMarker(
    entry: LanguageServerCatalogEntry,
    files: string[]
  ): Promise<boolean> {
    for (const marker of entry.rootMarkers) {
      const inFileList = files.some((file) => {
        const base = path.posix.basename(file).toLowerCase();
        return marker.startsWith("*.")
          ? base.endsWith(marker.slice(1).toLowerCase())
          : base === marker.toLowerCase();
      });
      if (inFileList) return true;
      if (
        !marker.includes("*") &&
        !marker.includes("/") &&
        !marker.includes("\\")
      ) {
        try {
          await fs.access(path.join(this.workspaceRoot, marker));
          return true;
        } catch {
          /* marker is absent at the workspace root */
        }
      }
    }
    return false;
  }

  private findAnchors(
    entry: LanguageServerCatalogEntry,
    files: string[]
  ): string[] {
    const warmup = entry.warmup;
    if (!warmup) return [];
    const configDirs = files
      .filter((file) =>
        warmup.configMarkers.some(
          (marker) =>
            path.posix.basename(file).toLowerCase() === marker.toLowerCase()
        )
      )
      .map((file) => path.posix.dirname(file));
    const anchors = configDirs
      .map((dir) =>
        files.find(
          (file) =>
            warmup.anchorExtensions.some((ext) =>
              file.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
            ) &&
            (dir === "." || file.startsWith(`${dir}/`))
        )
      )
      .filter((file): file is string => !!file);
    if (anchors.length) return [...new Set(anchors)];
    const fallback = files.find((file) =>
      warmup.anchorExtensions.some((ext) =>
        file.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
      )
    );
    return fallback ? [fallback] : [];
  }
}

interface RangeLike {
  start: { line: number };
  end: { line: number };
}
interface WorkspaceSymbolLike {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range?: RangeLike };
}
function isWorkspaceSymbol(value: unknown): value is WorkspaceSymbolLike {
  const item = value as WorkspaceSymbolLike;
  return (
    typeof item?.name === "string" &&
    typeof item?.kind === "number" &&
    typeof item?.location?.uri === "string"
  );
}
function toIndexedSymbol(
  item: WorkspaceSymbolLike,
  workspaceRoot: string
): IndexedSymbol | undefined {
  const range = item.location.range;
  if (!range) return undefined;
  let absolute: string;
  try {
    absolute = fileURLToPath(item.location.uri);
  } catch {
    return undefined;
  }
  const relative = path
    .relative(workspaceRoot, absolute)
    .split(path.sep)
    .join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
  return {
    name: item.name,
    kind: item.kind as LspSymbolKind,
    viewerPath: relative,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    ...(item.containerName ? { containerName: item.containerName } : {}),
  };
}
function flattenDocumentSymbols(
  items: unknown[],
  viewerPath: string,
  output: IndexedSymbol[],
  containerName?: string
): void {
  for (const raw of items) {
    const item = raw as {
      name?: string;
      kind?: number;
      range?: RangeLike;
      location?: { range?: RangeLike };
      children?: unknown[];
    };
    const range = item.range ?? item.location?.range;
    if (item.name && typeof item.kind === "number" && range)
      output.push({
        name: item.name,
        kind: item.kind as LspSymbolKind,
        viewerPath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        ...(containerName ? { containerName } : {}),
      });
    if (Array.isArray(item.children))
      flattenDocumentSymbols(
        item.children,
        viewerPath,
        output,
        item.name ?? containerName
      );
  }
}
function symbolKey(symbol: IndexedSymbol): string {
  return `${symbol.viewerPath}\n${symbol.name}\n${symbol.kind}\n${symbol.startLine}:${symbol.endLine}`;
}
