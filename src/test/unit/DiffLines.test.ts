import * as assert from "assert";
import { suite, test } from "mocha";
import { generateDiffLines } from "../../utils/DiffLines";
import { DIFF_LINE_TYPES } from "../../types/DashboardConstants";

suite("DiffLines", () => {
  test("keeps an unchanged unterminated snippet line as context", () => {
    assert.deepStrictEqual(generateDiffLines("foo", "foo\nbar"), [
      {
        type: DIFF_LINE_TYPES.CONTEXT,
        oldLineNum: 1,
        newLineNum: 1,
        content: "foo",
      },
      { type: DIFF_LINE_TYPES.ADDED, newLineNum: 2, content: "bar" },
    ]);
  });
});
