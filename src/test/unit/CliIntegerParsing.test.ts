import * as assert from "assert";
import { suite, test } from "mocha";
import { parseStrictInteger } from "../../cli/CliIntegerParsing";

suite("CLI integer parsing errors", () => {
  test("uses safe integer wording when unbounded", () => {
    assert.throws(
      () => parseStrictInteger("1.5", "--timeout"),
      /expected a safe integer\./
    );
  });

  test("uses minimum wording", () => {
    assert.throws(
      () => parseStrictInteger("0", "--script-timeout", { minimum: 1 }),
      /expected an integer of at least 1\./
    );
  });

  test("uses maximum wording", () => {
    assert.throws(
      () => parseStrictInteger("4", "--port", { maximum: 3 }),
      /expected an integer of at most 3\./
    );
  });

  test("uses bounded range wording", () => {
    assert.throws(
      () => parseStrictInteger("4", "--port", { minimum: 1, maximum: 3 }),
      /expected an integer between 1 and 3\./
    );
  });
});
