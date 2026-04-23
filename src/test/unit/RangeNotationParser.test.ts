import * as assert from "assert";
import { suite, test } from "mocha";
import { parseRangeNotation } from "../../utils/RangeNotationParser";

suite("RangeNotationParser", () => {
  test("parses comma-separated numbers", () => {
    assert.deepStrictEqual(parseRangeNotation("1,3,5"), [1, 3, 5]);
  });

  test("parses ranges", () => {
    assert.deepStrictEqual(parseRangeNotation("1,3-5,8"), [1, 3, 4, 5, 8]);
  });

  test("sorts and deduplicates values", () => {
    assert.deepStrictEqual(parseRangeNotation("5,1,3-5,1"), [1, 3, 4, 5]);
  });

  test("returns null for empty input", () => {
    assert.strictEqual(parseRangeNotation(""), null);
    assert.strictEqual(parseRangeNotation("   "), null);
  });

  test("returns null for invalid ranges", () => {
    assert.strictEqual(parseRangeNotation("3-1"), null);
    assert.strictEqual(parseRangeNotation("0"), null);
    assert.strictEqual(parseRangeNotation("1,,2"), null);
    assert.strictEqual(parseRangeNotation("abc"), null);
  });
});
