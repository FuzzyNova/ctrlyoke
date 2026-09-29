import * as assert from "assert";
import { suite, test } from "mocha";
import { isPositionInsideYamlBlockScalar } from "../../completions/YamlBlockScalarContext";

function isInside(text: string, line: number, key = "prompt"): boolean {
  const lines = text.split("\n");
  return isPositionInsideYamlBlockScalar(
    (lineNumber) => lines[lineNumber],
    line,
    lines[line].length,
    key
  );
}

suite("YamlBlockScalarContext", () => {
  test("keeps reference completion context after prose containing a colon", () => {
    const text = "steps:\n  - prompt: |\n      Task: review\n      @";
    assert.strictEqual(isInside(text, 3), true);
  });

  test("recognizes chomping and indentation indicators", () => {
    for (const indicator of ["|-", ">-", "|+", "|2"]) {
      const text = `steps:\n  - prompt: ${indicator}\n      Review this\n      @`;
      assert.strictEqual(isInside(text, 3), true, indicator);
    }
  });

  test("does not treat following workflow keys as block content", () => {
    const text = "steps:\n  - prompt: |\n      Review this\n    model: gpt";
    assert.strictEqual(isInside(text, 3), false);
  });

  test("does not treat inline prompt values as block scalars", () => {
    assert.strictEqual(isInside("steps:\n  - prompt: inline\n    @", 2), false);
  });
});
