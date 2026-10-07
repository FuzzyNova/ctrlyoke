import * as assert from "assert";
import { suite, test } from "mocha";
import { FallbackSymbolIndex } from "../../completions/FallbackSymbolIndex";
import type { IndexedSymbol, SymbolIndex } from "../../completions/SymbolIndex";
import { LspSymbolKind } from "../../completions/SymbolIndex";

const primarySymbol: IndexedSymbol = {
  name: "primary",
  kind: LspSymbolKind.Class,
  viewerPath: "src/primary.ts",
  startLine: 1,
  endLine: 2,
};
const fallbackSymbol: IndexedSymbol = {
  name: "fallback",
  kind: LspSymbolKind.Function,
  viewerPath: "src/fallback.ts",
  startLine: 3,
  endLine: 4,
};

class FakeSymbolIndex implements SymbolIndex {
  workspaceCalls = 0;
  documentCalls = 0;

  constructor(
    private readonly workspaceResults: IndexedSymbol[],
    private readonly documentResults: IndexedSymbol[]
  ) {}

  async workspaceSymbols(): Promise<IndexedSymbol[]> {
    this.workspaceCalls++;
    return this.workspaceResults;
  }

  async documentSymbols(): Promise<IndexedSymbol[]> {
    this.documentCalls++;
    return this.documentResults;
  }
}

suite("FallbackSymbolIndex", () => {
  test("uses fallback workspace symbols only when primary is empty", async () => {
    const primary = new FakeSymbolIndex([], []);
    const fallback = new FakeSymbolIndex([fallbackSymbol], []);
    const index = new FallbackSymbolIndex(primary, fallback);

    assert.deepStrictEqual(await index.workspaceSymbols("query", 10), [
      fallbackSymbol,
    ]);
    assert.strictEqual(fallback.workspaceCalls, 1);

    const populatedPrimary = new FakeSymbolIndex([primarySymbol], []);
    const unusedFallback = new FakeSymbolIndex([fallbackSymbol], []);
    assert.deepStrictEqual(
      await new FallbackSymbolIndex(
        populatedPrimary,
        unusedFallback
      ).workspaceSymbols("query", 10),
      [primarySymbol]
    );
    assert.strictEqual(unusedFallback.workspaceCalls, 0);
  });

  test("uses fallback document symbols only when primary is empty", async () => {
    const primary = new FakeSymbolIndex([], []);
    const fallback = new FakeSymbolIndex([], [fallbackSymbol]);
    const index = new FallbackSymbolIndex(primary, fallback);

    assert.deepStrictEqual(await index.documentSymbols("src/file.ts"), [
      fallbackSymbol,
    ]);
    assert.strictEqual(fallback.documentCalls, 1);

    const populatedPrimary = new FakeSymbolIndex([], [primarySymbol]);
    const unusedFallback = new FakeSymbolIndex([], [fallbackSymbol]);
    assert.deepStrictEqual(
      await new FallbackSymbolIndex(
        populatedPrimary,
        unusedFallback
      ).documentSymbols("src/file.ts"),
      [primarySymbol]
    );
    assert.strictEqual(unusedFallback.documentCalls, 0);
  });

  test("merges regex results only for languages without a ready primary", async () => {
    const fallbackForUnavailableLanguage = new FallbackSymbolIndex(
      new FakeSymbolIndex([primarySymbol], []),
      new FakeSymbolIndex([primarySymbol, fallbackSymbol], []),
      (symbol) => symbol.viewerPath === fallbackSymbol.viewerPath
    );

    assert.deepStrictEqual(
      await fallbackForUnavailableLanguage.workspaceSymbols("query", 10),
      [primarySymbol, fallbackSymbol]
    );
  });
});
