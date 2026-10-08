import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getDocumentPromptCodeRanges,
  getPromptCodeRanges,
  isRangeInPromptCode,
  type PromptCodeRangeDocument,
} from "../../completions/PromptCodeRanges";

const FILE = "case.ctrlyoke.yaml";

function isLiteral(text: string, needle: string): boolean {
  const from = text.indexOf(needle);
  assert.ok(from >= 0, `fixture lacks ${needle}`);
  return isRangeInPromptCode(
    from,
    from + needle.length,
    getPromptCodeRanges(text, FILE, "yaml")
  );
}

suite("PromptCodeRanges", () => {
  test("maps code in a YAML block scalar back to the document", () => {
    const text = "steps:\n  - prompt: |\n      see @a.ts and `@b.ts`\n";
    assert.strictEqual(isLiteral(text, "@a.ts"), false);
    assert.strictEqual(isLiteral(text, "@b.ts"), true);
  });

  test("an inexactly decoded span falls back to its raw source", () => {
    // An indentation indicator (`|2`) is a decoder gap: offsets would be
    // shifted by the block indent and suppress the wrong reference.
    const text =
      "steps:\n  - prompt: |2\n      see @a.ts ok `literal @code.ts`\n";
    assert.strictEqual(isLiteral(text, "@a.ts"), false);
    assert.strictEqual(isLiteral(text, "@code.ts"), true);
  });

  test("caches per document version", () => {
    let reads = 0;
    const document = (version: number, text: string) =>
      ({
        uri: { toString: () => "file:///cache-case.ctrlyoke.yaml" },
        version,
        fileName: FILE,
        languageId: "yaml",
        getText: () => {
          reads++;
          return text;
        },
      }) satisfies PromptCodeRangeDocument;
    const first = document(1, "prompt: `a`\n");
    const ranges = getDocumentPromptCodeRanges(first);
    assert.strictEqual(getDocumentPromptCodeRanges(first), ranges);
    assert.strictEqual(reads, 1);
    const edited = getDocumentPromptCodeRanges(document(2, "prompt: plain\n"));
    assert.deepStrictEqual(edited, []);
    assert.strictEqual(reads, 2);
  });
});
