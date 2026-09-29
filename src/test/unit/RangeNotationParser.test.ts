import * as assert from "assert";
import { suite, test } from "mocha";
import {
  MAX_RANGE_NOTATION_INDICES,
  parseRangeNotation,
} from "../../utils/RangeNotationParser";

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

  test("returns null for a range above the sanity bound", () => {
    assert.strictEqual(parseRangeNotation("1-30000000"), null);
    assert.strictEqual(
      parseRangeNotation(`1-${MAX_RANGE_NOTATION_INDICES + 1}`),
      null
    );
  });

  test("returns null when multiple ranges exceed the sanity bound", () => {
    assert.strictEqual(parseRangeNotation("1-6000,6001-10001"), null);
  });

  test("counts unique indices when ranges overlap or repeat", () => {
    assert.deepStrictEqual(
      parseRangeNotation("1-100,1"),
      Array.from({ length: 100 }, (_, i) => i + 1)
    );
    assert.deepStrictEqual(
      parseRangeNotation("1-60,50-100"),
      Array.from({ length: 100 }, (_, i) => i + 1)
    );
  });

  test("supports ranges above the default workflow step limit", () => {
    assert.deepStrictEqual(
      parseRangeNotation("1-101"),
      Array.from({ length: 101 }, (_, i) => i + 1)
    );
    assert.deepStrictEqual(
      parseRangeNotation("1-150"),
      Array.from({ length: 150 }, (_, i) => i + 1)
    );
  });

  test("returns null for values outside the safe integer range", () => {
    assert.strictEqual(parseRangeNotation("9007199254740992"), null);
    assert.strictEqual(parseRangeNotation("1-9007199254740992"), null);
  });
});
