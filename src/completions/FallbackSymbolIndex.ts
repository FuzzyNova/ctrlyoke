import type { IndexedSymbol, SymbolIndex } from "./SymbolIndex";

/** Uses a secondary index only when the primary has no results. */
export class FallbackSymbolIndex implements SymbolIndex {
  constructor(
    private readonly primary: SymbolIndex,
    private readonly fallback: SymbolIndex,
    private readonly shouldUseFallbackForSymbol?: (symbol: IndexedSymbol) => boolean
  ) {}

  async workspaceSymbols(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    const symbols = await this.primary.workspaceSymbols(
      query,
      maxResults,
      signal
    );
    if (symbols.length === 0) {
      const fallback = await this.fallback.workspaceSymbols(query, maxResults, signal);
      return this.shouldUseFallbackForSymbol
        ? fallback.filter((symbol) => this.shouldUseFallbackForSymbol?.(symbol))
        : fallback;
    }
    if (!this.shouldUseFallbackForSymbol) return symbols;
    const keys = new Set(symbols.map(symbolKey));
    const missing = (await this.fallback.workspaceSymbols(query, maxResults, signal))
      .filter((symbol) => this.shouldUseFallbackForSymbol?.(symbol) && !keys.has(symbolKey(symbol)));
    return [...symbols, ...missing].slice(0, Math.max(0, maxResults));
  }

  async documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    const symbols = await this.primary.documentSymbols(viewerPath, signal);
    if (symbols.length === 0) {
      const fallback = await this.fallback.documentSymbols(viewerPath, signal);
      return this.shouldUseFallbackForSymbol
        ? fallback.filter((symbol) => this.shouldUseFallbackForSymbol?.(symbol))
        : fallback;
    }
    if (!this.shouldUseFallbackForSymbol) return symbols;
    const keys = new Set(symbols.map(symbolKey));
    const missing = (await this.fallback.documentSymbols(viewerPath, signal))
      .filter((symbol) => this.shouldUseFallbackForSymbol?.(symbol) && !keys.has(symbolKey(symbol)));
    return [...symbols, ...missing];
  }
}

function symbolKey(symbol: IndexedSymbol): string {
  return `${symbol.viewerPath}\n${symbol.name}\n${symbol.kind}\n${symbol.startLine}:${symbol.endLine}`;
}
