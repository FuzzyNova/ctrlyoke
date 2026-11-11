import * as assert from "assert";
import { suite, test } from "mocha";
import { matchesPrefix } from "../../completions/PrefixMatch";

suite("PrefixMatch", () => {
  test("matches prefixes without regard to case", () => {
    assert.strictEqual(matchesPrefix("PermissionList", "perM"), true);
  });

  test("rejects values that do not begin with the prefix", () => {
    assert.strictEqual(matchesPrefix("PermissionList", "list"), false);
  });
});
