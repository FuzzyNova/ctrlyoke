import * as assert from "assert";
import { suite, test } from "mocha";
import { parseArgString } from "../../utils/CliArgParser";

suite("CliArgParser", () => {
  suite("parseArgString", () => {
    test("parses simple space-separated args", () => {
      assert.deepStrictEqual(parseArgString("--effort high --max-turns 10"), [
        "--effort",
        "high",
        "--max-turns",
        "10",
      ]);
    });

    test("returns empty array for empty string", () => {
      assert.deepStrictEqual(parseArgString(""), []);
    });

    test("returns empty array for whitespace-only string", () => {
      assert.deepStrictEqual(parseArgString("   "), []);
    });

    test("preserves double-quoted string as single token", () => {
      assert.deepStrictEqual(parseArgString('--arg "foo bar"'), [
        "--arg",
        "foo bar",
      ]);
    });

    test("preserves single-quoted string as single token", () => {
      assert.deepStrictEqual(parseArgString('--config \'{"key":"val"}\''), [
        "--config",
        '{"key":"val"}',
      ]);
    });

    test("handles escaped quotes inside double-quoted strings", () => {
      assert.deepStrictEqual(parseArgString('"foo \\"bar\\""'), ['foo "bar"']);
    });

    test("handles single argument with no spaces", () => {
      assert.deepStrictEqual(parseArgString("--verbose"), ["--verbose"]);
    });

    test("handles multiple spaces between args", () => {
      assert.deepStrictEqual(parseArgString("a   b    c"), ["a", "b", "c"]);
    });

    test("handles leading and trailing whitespace", () => {
      assert.deepStrictEqual(parseArgString("  --flag value  "), [
        "--flag",
        "value",
      ]);
    });

    test("handles empty double-quoted string (skipped as empty token)", () => {
      // Parser produces no token for empty quotes since current stays ""
      assert.deepStrictEqual(parseArgString('--arg ""'), ["--arg"]);
    });

    test("handles empty single-quoted string (skipped as empty token)", () => {
      assert.deepStrictEqual(parseArgString("--arg ''"), ["--arg"]);
    });

    test("handles mixed quoted and unquoted args", () => {
      assert.deepStrictEqual(parseArgString('--name "John Doe" --age 30'), [
        "--name",
        "John Doe",
        "--age",
        "30",
      ]);
    });

    test("handles adjacent quoted and unquoted text", () => {
      // --prefix"quoted" should merge into single token
      assert.deepStrictEqual(parseArgString('--prefix"quoted"'), [
        "--prefixquoted",
      ]);
    });

    test("handles tab characters as whitespace", () => {
      assert.deepStrictEqual(parseArgString("a\tb"), ["a", "b"]);
    });
  });
});
