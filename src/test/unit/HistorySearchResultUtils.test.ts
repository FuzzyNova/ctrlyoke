import * as assert from "assert";
import { suite, test } from "mocha";
import {
  DEFAULT_HISTORY_SEARCH_SNIPPET_CHARS,
  extractSnippet,
} from "../../core/orchestration/HistorySearchResultUtils";

suite("HistorySearchResultUtils", () => {
  test("keeps the default snippet byte-identical and splits widened context 40:60", () => {
    const text = `${"a".repeat(80)}needle${"b".repeat(90)}`;
    const defaultSnippet = extractSnippet(text, "needle");
    const explicitDefault = extractSnippet(
      text,
      "needle",
      DEFAULT_HISTORY_SEARCH_SNIPPET_CHARS
    );
    const widened = extractSnippet(text, "needle", 200);

    assert.strictEqual(defaultSnippet, explicitDefault);
    assert.strictEqual(
      defaultSnippet,
      `…${"a".repeat(40)}needle${"b".repeat(60)}…`
    );
    assert.strictEqual(widened, text);
  });

  test("uses the configured width for a non-matching head fallback", () => {
    assert.strictEqual(extractSnippet("abcdefghij", "missing", 4), "abcd");
  });
});
