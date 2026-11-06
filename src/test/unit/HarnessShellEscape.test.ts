import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HARNESS_SHELL_ESCAPE_PREFIX,
  isHarnessShellEscape,
} from "../../utils/HarnessShellEscape";

suite("HarnessShellEscape", () => {
  test("recognizes a leading escape after trimming whitespace", () => {
    assert.strictEqual(HARNESS_SHELL_ESCAPE_PREFIX, "!");
    assert.strictEqual(isHarnessShellEscape("! echo hello"), true);
    assert.strictEqual(isHarnessShellEscape("  \t! echo hello  "), true);
    assert.strictEqual(isHarnessShellEscape("run this ! command"), false);
  });
});
