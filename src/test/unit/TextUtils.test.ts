import * as assert from "assert";
import { suite, test } from "mocha";
import { escapeRegExp } from "../../utils/TextUtils";

suite("TextUtils", () => {
  test("escapes every regular expression metacharacter", () => {
    assert.strictEqual(
      escapeRegExp(".*+?^${}()|[]\\"),
      "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\"
    );
  });

  test("matches a string containing regular expression metacharacters literally", () => {
    const value = ".*+?^${}()|[]\\";
    assert.strictEqual(new RegExp(escapeRegExp(value)).test(value), true);
  });

  test("leaves plain text unchanged", () => {
    assert.strictEqual(escapeRegExp("plain text 123"), "plain text 123");
  });
});
