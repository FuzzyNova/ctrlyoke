import * as assert from "assert";
import { suite, test } from "mocha";
import {
  createHistorySearchMatcher,
  disposeHistorySearchMatcher,
  findHistorySearchMatch,
  HistorySearchRegexTimeoutError,
  InvalidHistorySearchPatternError,
} from "../../core/orchestration/HistorySearchMatcher";

suite("HistorySearchMatcher", () => {
  test("returns a match at the start of the text", () => {
    const matcher = createHistorySearchMatcher("needle", false);

    assert.deepStrictEqual(matcher.find("needle in text"), {
      index: 0,
      length: 6,
    });
  });

  test("returns a match in the middle of the text", () => {
    const matcher = createHistorySearchMatcher("needle", false);

    assert.deepStrictEqual(matcher.find("find the needle here"), {
      index: 9,
      length: 6,
    });
  });

  test("returns no match when the query is absent", () => {
    const matcher = createHistorySearchMatcher("needle", false);

    assert.strictEqual(matcher.find("nothing relevant"), undefined);
  });

  test("matches without regard to case", () => {
    const matcher = createHistorySearchMatcher("NeEdLe", false);

    assert.deepStrictEqual(matcher.find("prefix NEEDLE suffix"), {
      index: 7,
      length: 6,
    });
  });

  test("returns no match when the query is longer than the text", () => {
    const matcher = createHistorySearchMatcher("long query", false);

    assert.strictEqual(matcher.find("short"), undefined);
  });

  test("matches regexes case-insensitively with variable match length", () => {
    const matcher = createHistorySearchMatcher("error[: ]+\\d+", true);

    assert.deepStrictEqual(matcher.find("prefix ERROR: 404 suffix"), {
      index: 7,
      length: 10,
    });
    disposeHistorySearchMatcher(matcher);
  });

  test("extracts only literals required by every regex branch", () => {
    assert.strictEqual(
      createHistorySearchMatcher("(foo|foobar)\\s+barcode", true)
        .requiredLiteral,
      "barcode"
    );
    assert.strictEqual(
      createHistorySearchMatcher("foo|bar", true).requiredLiteral,
      undefined
    );
    assert.strictEqual(
      createHistorySearchMatcher("prefix-a|prefix-b", true).requiredLiteral,
      "prefix-"
    );
    assert.strictEqual(
      createHistorySearchMatcher("(?!secret)public", true).requiredLiteral,
      "public"
    );
  });

  test("rejects an invalid regex as a typed error", () => {
    assert.throws(
      () => createHistorySearchMatcher("[", true),
      InvalidHistorySearchPatternError
    );
  });

  test("bounds a catastrophic regex against deep-sized text", async () => {
    const matcher = createHistorySearchMatcher("(a+)+$", true);
    const startedAt = Date.now();
    await assert.rejects(
      findHistorySearchMatch(matcher, `${"a".repeat(30)}!`),
      HistorySearchRegexTimeoutError
    );
    assert.ok(Date.now() - startedAt < 5000);
    disposeHistorySearchMatcher(matcher);
  });
});
