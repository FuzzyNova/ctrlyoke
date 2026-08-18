import * as assert from "assert";
import { suite, test, setup } from "mocha";
import {
  sanitizeTerminalOutput,
  stripAnsiCodes,
  clearSanitizeTerminalOutputCacheForTests,
} from "../../utils/TerminalOutputSanitizer";

suite("TerminalOutputSanitizer", () => {
  setup(() => {
    clearSanitizeTerminalOutputCacheForTests();
  });

  suite("stripAnsiCodes", () => {
    test("removes ANSI escape sequences", () => {
      assert.strictEqual(stripAnsiCodes("\x1B[31mred\x1B[0m"), "red");
    });

    test("returns empty string for non-string input", () => {
      assert.strictEqual(stripAnsiCodes(undefined as unknown as string), "");
    });

    test("returns empty string for empty input", () => {
      assert.strictEqual(stripAnsiCodes(""), "");
    });
  });

  suite("sanitizeTerminalOutput", () => {
    test("strips ANSI codes", () => {
      assert.strictEqual(
        sanitizeTerminalOutput("\x1B[1mbold\x1B[0m text"),
        "bold text"
      );
    });

    test("collapses CRLF to LF", () => {
      assert.strictEqual(sanitizeTerminalOutput("a\r\nb\r\nc"), "a\nb\nc");
    });

    test("removes lone CR without inserting a newline", () => {
      assert.strictEqual(sanitizeTerminalOutput("a\rb"), "ab");
    });

    test("removes non-printable control characters but keeps tabs and newlines", () => {
      assert.strictEqual(
        sanitizeTerminalOutput("a\x00b\x1Fc\x7Fd\te\nf"),
        "abcd\te\nf"
      );
    });

    test("returns empty string for non-string input", () => {
      assert.strictEqual(
        sanitizeTerminalOutput(undefined as unknown as string),
        ""
      );
    });

    test("returns empty string for empty input", () => {
      assert.strictEqual(sanitizeTerminalOutput(""), "");
    });

    test("mixed CRLF, lone CR, ANSI, and control chars in one pass", () => {
      const input = "\x1B[32mok\x1B[0m\r\nline2\rline3\x0Bline4";
      assert.strictEqual(
        sanitizeTerminalOutput(input),
        "ok\nline2line3line4"
      );
    });

    test("caches repeated calls with the same input string", () => {
      const input = "\x1B[31mrepeat\x1B[0m\r\nme";
      const first = sanitizeTerminalOutput(input);
      const second = sanitizeTerminalOutput(input);
      assert.strictEqual(first, "repeat\nme");
      assert.strictEqual(second, first);
    });

    test("cache does not leak results across different inputs", () => {
      assert.strictEqual(sanitizeTerminalOutput("one\r\n"), "one\n");
      assert.strictEqual(sanitizeTerminalOutput("two\r\n"), "two\n");
      assert.strictEqual(sanitizeTerminalOutput("one\r\n"), "one\n");
    });

    test("does not cache pathologically large blobs but still sanitizes them correctly", () => {
      const largeInput = `${"a".repeat(60_000)}\r\nb`;
      assert.strictEqual(
        sanitizeTerminalOutput(largeInput),
        `${"a".repeat(60_000)}\nb`
      );
    });
  });
});
