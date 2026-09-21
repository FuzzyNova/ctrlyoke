import * as assert from "assert";
import { suite, test } from "mocha";
import { createHistorySearchMatcher } from "../../core/orchestration/HistorySearchMatcher";

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
});
