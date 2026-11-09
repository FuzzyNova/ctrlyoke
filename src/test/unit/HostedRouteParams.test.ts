import * as assert from "assert";
import { suite, test } from "mocha";
import {
  optionalNonEmptyQueryString,
  optionalTrimmedQueryString,
  parseHostedRoutePagingParams,
} from "../../server/HostedRouteParams";

suite("HostedRouteParams", () => {
  suite("optionalTrimmedQueryString", () => {
    test("returns undefined for non-strings and arrays", () => {
      assert.strictEqual(optionalTrimmedQueryString(undefined), undefined);
      assert.strictEqual(optionalTrimmedQueryString(42), undefined);
      assert.strictEqual(optionalTrimmedQueryString(["repo"]), undefined);
    });

    test("returns undefined for empty and whitespace-only strings", () => {
      assert.strictEqual(optionalTrimmedQueryString(""), undefined);
      assert.strictEqual(optionalTrimmedQueryString("  \t\n"), undefined);
    });

    test("trims padded strings", () => {
      assert.strictEqual(optionalTrimmedQueryString("  repo-id  "), "repo-id");
    });
  });

  suite("optionalNonEmptyQueryString", () => {
    test("returns undefined for non-strings and arrays", () => {
      assert.strictEqual(optionalNonEmptyQueryString(undefined), undefined);
      assert.strictEqual(optionalNonEmptyQueryString(42), undefined);
      assert.strictEqual(optionalNonEmptyQueryString(["id"]), undefined);
    });

    test("returns undefined for an empty string", () => {
      assert.strictEqual(optionalNonEmptyQueryString(""), undefined);
    });

    test("preserves whitespace-only and padded strings", () => {
      assert.strictEqual(optionalNonEmptyQueryString("  \t "), "  \t ");
      assert.strictEqual(
        optionalNonEmptyQueryString("  history-id  "),
        "  history-id  "
      );
    });
  });

  suite("parseHostedRoutePagingParams", () => {
    test("defaults offset to zero and page size to undefined", () => {
      assert.deepStrictEqual(
        parseHostedRoutePagingParams(undefined, undefined),
        {
          offset: 0,
          pageSize: undefined,
        }
      );
    });

    test("parses provided values as base-ten integers", () => {
      assert.deepStrictEqual(parseHostedRoutePagingParams("12tail", "25"), {
        offset: 12,
        pageSize: 25,
      });
    });

    test("preserves NaN for invalid provided values", () => {
      const parsed = parseHostedRoutePagingParams("invalid", "invalid");
      assert.ok(Number.isNaN(parsed.offset));
      assert.ok(Number.isNaN(parsed.pageSize));
    });
  });
});
