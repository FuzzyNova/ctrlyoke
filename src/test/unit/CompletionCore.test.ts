import * as assert from "assert";
import { suite, test } from "mocha";
import { CompletionCore } from "../../completions/CompletionCore";
import type { EditorContextSource } from "../../completions/EditorContextSource";
import type { SymbolIndex } from "../../completions/SymbolIndex";
import {
  symbolCompletionGolden,
  symbolCompletionGoldenResult,
} from "../fixtures/SymbolCompletionGolden";

suite("CompletionCore", () => {
  test("keeps the #sym insertion and symbol icon kind stable", async () => {
    const symbols: SymbolIndex = {
      workspaceSymbols: async () => [symbolCompletionGolden],
      documentSymbols: async () => [symbolCompletionGolden],
    };
    const core = new CompletionCore({
      getFiles: async () => [],
      isMultiRoot: () => false,
      symbols,
    });
    const item = (await core.getHashCompletions("Wid"))[0];
    assert.strictEqual(
      item.insertText,
      symbolCompletionGoldenResult.insertText
    );
    assert.strictEqual(item.kind, symbolCompletionGoldenResult.completionKind);
    assert.strictEqual(
      item.kind === 6 ? "symbol-class" : "",
      symbolCompletionGoldenResult.icon
    );
  });

  test("keeps the panel partial response populated from the current editor selection", () => {
    const source: EditorContextSource = {
      getSelections: () => [
        {
          viewerPath: "src/Widget.ts",
          startLine: 4,
          endLine: 8,
          text: "class Widget {}",
          isOutput: false,
        },
      ],
      getVisibleOutputChannels: () => [],
    };
    const core = new CompletionCore({
      getFiles: async () => [],
      isMultiRoot: () => false,
      editorContext: source,
    });
    const [item] = core.getHashSelectionCompletions();
    assert.strictEqual(item.label, "selection: Current Selection");
    assert.strictEqual(item.insertText, "selection:src/Widget.ts:4-8");
    assert.strictEqual(item.kind, 10);
  });
});
