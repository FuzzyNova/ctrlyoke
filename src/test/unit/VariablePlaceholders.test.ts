import * as assert from "assert";
import { suite, test } from "mocha";
import {
  findVariablePlaceholders,
  isVariableDefined,
} from "../../utils/VariablePlaceholders";

suite("VariablePlaceholders", () => {
  test("finds each placeholder with its range and name", () => {
    const text = "Hi {{name}}, see {{other_1}}.";
    assert.deepStrictEqual(findVariablePlaceholders(text), [
      { from: 3, to: 11, name: "name", inFence: false },
      { from: 17, to: 28, name: "other_1", inFence: false },
    ]);
  });

  test("ignores braces that do not wrap a valid variable name", () => {
    assert.deepStrictEqual(
      findVariablePlaceholders("{{}} {{a-b}} {{ spaced }} {name}"),
      []
    );
  });

  test("marks fenced placeholders but not inline-code ones", () => {
    // Only block fences keep a placeholder literal at run time, so inline
    // code must not be reported as protected.
    const text = "`{{inline}}`\n```\n{{fenced}}\n```";
    assert.deepStrictEqual(
      findVariablePlaceholders(text).map(({ name, inFence }) => ({
        name,
        inFence,
      })),
      [
        { name: "inline", inFence: false },
        { name: "fenced", inFence: true },
      ]
    );
  });

  test("checks own keys only", () => {
    assert.strictEqual(isVariableDefined({ a: "" }, "a"), true);
    assert.strictEqual(isVariableDefined({}, "toString"), false);
  });
});
