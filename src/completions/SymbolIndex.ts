/** LSP SymbolKind numbering (1-based), shared by every symbol-index host. */
export enum LspSymbolKind {
  File = 1,
  Module,
  Namespace,
  Package,
  Class,
  Method,
  Property,
  Field,
  Constructor,
  Enum,
  Interface,
  Function,
  Variable,
  Constant,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Key,
  Null,
  EnumMember,
  Struct,
  Event,
  Operator,
  TypeParameter,
}

export interface IndexedSymbol {
  name: string;
  kind: LspSymbolKind;
  viewerPath: string;
  startLine: number;
  endLine: number;
  containerName?: string;
}

export interface SymbolIndex {
  workspaceSymbols(
    query: string,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]>;
  documentSymbols(
    viewerPath: string,
    signal?: AbortSignal
  ): Promise<IndexedSymbol[]>;
}
