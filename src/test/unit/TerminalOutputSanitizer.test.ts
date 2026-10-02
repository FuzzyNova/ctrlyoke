import * as assert from "assert";
import { suite, test, setup } from "mocha";
import {
  sanitizeTerminalOutput,
  TerminalOutputSanitizer,
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

    test("strips charset designation and private escape sequences", () => {
      const cases = [
        { input: "\x1B(B", expected: "" },
        { input: "\x1B7", expected: "" },
        { input: "\x1B8", expected: "" },
        { input: "\x1B=", expected: "" },
        { input: "\x1B>", expected: "" },
        { input: "\x1Bc", expected: "" },
      ];

      for (const { input, expected } of cases) {
        assert.strictEqual(sanitizeTerminalOutput(input), expected, input);
      }
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
      assert.strictEqual(sanitizeTerminalOutput(input), "ok\nline2line3line4");
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

  suite("TerminalOutputSanitizer", () => {
    for (const sequence of [
      "\x1B[38;5;196mred\x1B[39m",
      "\x1B]0;terminal title\x07text",
      "\x1B]8;;https://example.com\x1B\\link\x1B]8;;\x1B\\",
    ]) {
      test(`preserves an escape sequence split at every offset: ${JSON.stringify(sequence)}`, () => {
        const expected = sanitizeTerminalOutput(sequence);
        for (let offset = 1; offset < sequence.length; offset++) {
          const sanitizer = new TerminalOutputSanitizer();
          const output =
            sanitizer.push(sequence.slice(0, offset)) +
            sanitizer.push(sequence.slice(offset)) +
            sanitizer.flush();
          assert.strictEqual(output, expected, `split at ${offset}`);
        }
      });
    }

    test("discards a trailing incomplete escape sequence", () => {
      const sanitizer = new TerminalOutputSanitizer();
      assert.strictEqual(sanitizer.push("PASS\x1B[3"), "PASS");
      assert.strictEqual(sanitizer.flush(), "");
    });

    test("holds an incomplete charset designation across chunks", () => {
      const sanitizer = new TerminalOutputSanitizer();
      assert.strictEqual(sanitizer.push("before\x1B("), "before");
      assert.strictEqual(sanitizer.push("Bafter"), "after");
      assert.strictEqual(sanitizer.flush(), "");
    });
  });
});
