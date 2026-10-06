import {
  LspSymbolKind,
  type IndexedSymbol,
} from "../../completions/SymbolIndex";

/** Shared contract for VS Code now and RegexSymbolIndex in standalone Stage 9. */
export const symbolCompletionGolden: IndexedSymbol = {
  name: "Widget",
  kind: LspSymbolKind.Class,
  viewerPath: "src/Widget.ts",
  startLine: 4,
  endLine: 18,
};

export const symbolCompletionGoldenResult = {
  insertText: "sym.class:src/Widget.ts:Widget:4-18",
  completionKind: 6,
  icon: "symbol-class",
} as const;
