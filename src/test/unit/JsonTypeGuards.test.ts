import * as assert from "assert";
import {
  finiteNumber,
  isRecord,
  isStringArray,
  isStringRecord,
  parseFiniteNumber,
} from "../../utils/JsonTypeGuards";

suite("JsonTypeGuards", () => {
  suite("isStringArray", () => {
    test("accepts an empty array and rejects mixed arrays and non-arrays", () => {
      assert.strictEqual(isStringArray([]), true);
      assert.strictEqual(isStringArray(["text", 1]), false);
      assert.strictEqual(isStringArray("text"), false);
    });
  });

  suite("isStringRecord", () => {
    test("accepts objects with only string values and rejects everything else", () => {
      assert.strictEqual(isStringRecord({}), true);
      assert.strictEqual(isStringRecord({ a: "1", b: "" }), true);
      assert.strictEqual(isStringRecord({ a: "1", b: 2 }), false);
      assert.strictEqual(isStringRecord(["a"]), false);
      assert.strictEqual(isStringRecord(null), false);
      assert.strictEqual(isStringRecord("a"), false);
    });
  });

  suite("isRecord", () => {
    test("accepts non-null, non-array objects including class instances", () => {
      class Example {}

      assert.strictEqual(isRecord(null), false);
      assert.strictEqual(isRecord([]), false);
      assert.strictEqual(isRecord(new Example()), true);
      assert.strictEqual(isRecord({}), true);
    });
  });

  suite("finiteNumber", () => {
    test("accepts only finite numbers", () => {
      assert.strictEqual(finiteNumber(12), 12);
      assert.strictEqual(finiteNumber(NaN), undefined);
      assert.strictEqual(finiteNumber(Infinity), undefined);
      assert.strictEqual(finiteNumber("12"), undefined);
      assert.strictEqual(finiteNumber(" "), undefined);
      assert.strictEqual(finiteNumber(""), undefined);
      assert.strictEqual(finiteNumber("1e3"), undefined);
      assert.strictEqual(finiteNumber("abc"), undefined);
    });
  });

  suite("parseFiniteNumber", () => {
    test("accepts finite numbers and non-blank numeric strings", () => {
      assert.strictEqual(parseFiniteNumber(12), 12);
      assert.strictEqual(parseFiniteNumber(NaN), undefined);
      assert.strictEqual(parseFiniteNumber(Infinity), undefined);
      assert.strictEqual(parseFiniteNumber("12"), 12);
      assert.strictEqual(parseFiniteNumber(" "), undefined);
      assert.strictEqual(parseFiniteNumber(""), undefined);
      assert.strictEqual(parseFiniteNumber("1e3"), 1000);
      assert.strictEqual(parseFiniteNumber("abc"), undefined);
    });
  });
});
