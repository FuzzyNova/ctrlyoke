import * as assert from "assert";
import { suite, test } from "mocha";
import { WEB_SEARCH_ACTIONS } from "../../types/DashboardConstants";
import {
  getWebSearchLabel,
  getWebSearchResultText,
  getWebSearchToolResult,
  hasWebSearchTarget,
} from "../../utils/WebSearchText";

suite("WebSearchText", () => {
  test("labels searches, page opens and finds in page", () => {
    assert.strictEqual(
      getWebSearchLabel({ query: "vitest" }),
      'Web search: "vitest"'
    );
    assert.strictEqual(
      getWebSearchLabel({
        query: "",
        action: WEB_SEARCH_ACTIONS.OPEN_PAGE,
        url: "https://example.test",
      }),
      "Open page: https://example.test"
    );
    assert.strictEqual(
      getWebSearchLabel({
        query: "restart",
        action: WEB_SEARCH_ACTIONS.FIND_IN_PAGE,
        url: "https://example.test",
      }),
      'Find in page: "restart" in https://example.test'
    );
  });

  test("needs a query or a page to have anything to show", () => {
    assert.strictEqual(hasWebSearchTarget({ query: "" }), false);
    assert.strictEqual(
      hasWebSearchTarget({ query: "", url: "https://example.test" }),
      true
    );
  });

  test("appends only the sources the result text does not already quote", () => {
    assert.strictEqual(
      getWebSearchResultText({
        query: "q",
        output: "Answer at https://a.test.",
        results: [
          { title: "A", url: "https://a.test" },
          { title: "B", url: "https://b.test", snippet: "about b" },
        ],
      }),
      "Answer at https://a.test.\n\nSources:\nB\nhttps://b.test\nabout b"
    );
    assert.strictEqual(
      getWebSearchResultText({
        query: "q",
        results: [{ title: "B", url: "https://b.test" }],
      }),
      "B\nhttps://b.test"
    );
  });

  test("is a tool result once finished, without repeating a failure as output", () => {
    assert.strictEqual(getWebSearchToolResult({ query: "q" }), undefined);
    assert.deepStrictEqual(
      getWebSearchToolResult({ query: "q", success: true }),
      {
        success: true,
      }
    );
    assert.deepStrictEqual(
      getWebSearchToolResult({
        query: "q",
        success: false,
        output: "quota exceeded",
        error: "quota exceeded",
      }),
      { success: false, error: "quota exceeded" }
    );
  });
});
