import * as assert from "assert";
import { suite, test } from "mocha";
import { truncateUtf8 } from "../../utils/Utf8Truncate";

suite("truncateUtf8", () => {
  test("returns text unchanged when it fits", () => {
    assert.strictEqual(truncateUtf8("hello 😀", 20), "hello 😀");
  });

  test("truncates ASCII at the byte limit", () => {
    assert.strictEqual(truncateUtf8("abcdef", 3), "abc");
  });

  test("never splits a multi-byte code point or exceeds the byte limit", () => {
    for (const text of ["aé", "a€", "a😀"]) {
      const byteLength = Buffer.byteLength(text, "utf8");
      for (let maxBytes = 1; maxBytes < byteLength; maxBytes++) {
        const truncated = truncateUtf8(text, maxBytes);
        assert.ok(!truncated.includes("\uFFFD"), `${text} at ${maxBytes}`);
        assert.ok(
          Buffer.byteLength(truncated, "utf8") <= maxBytes,
          `${text} at ${maxBytes}`
        );
      }
    }
  });

  test("preserves a real trailing replacement character in the kept text", () => {
    assert.strictEqual(truncateUtf8("x\uFFFD😀", 4), "x\uFFFD");
  });

  test("returns empty text for zero or negative limits", () => {
    assert.strictEqual(truncateUtf8("text", 0), "");
    assert.strictEqual(truncateUtf8("text", -1), "");
  });
});
