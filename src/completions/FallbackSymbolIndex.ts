import type { IndexedSymbol, SymbolIndex } from "./SymbolIndex";

/** Uses a secondary index only when the primary has no results. */
export class FallbackSymbolIndex implements SymbolIndex {
  constructor(
    private readonly primary: SymbolIndex,
    private readonly fallback: SymbolIndex
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
    return symbols.length > 0
      ? symbols
      : this.fallback.workspaceSymbols(query, maxResults, signal);
  }

  async documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]> {
    const symbols = await this.primary.documentSymbols(viewerPath, signal);
    return symbols.length > 0
      ? symbols
      : this.fallback.documentSymbols(viewerPath, signal);
  }
}
