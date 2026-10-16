import * as assert from "assert";
import { suite, test } from "mocha";
import { getInclusiveEndLine } from "../../utils/InclusiveLineRange";

suite("getInclusiveEndLine", () => {
  test("excludes the next line when a selection ends at its start", () => {
    assert.strictEqual(getInclusiveEndLine(9, 10, 0), 10);
    assert.strictEqual(getInclusiveEndLine(9, 12, 0), 12);
  });

  test("includes the endpoint line when the selection ends after column zero", () => {
    assert.strictEqual(getInclusiveEndLine(9, 9, 0), 10);
    assert.strictEqual(getInclusiveEndLine(9, 10, 1), 11);
  });
});
