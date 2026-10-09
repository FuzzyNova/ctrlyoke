import * as assert from "assert";
import { suite, test } from "mocha";
import { workflowPathFromInstancePath } from "../../completions/WorkflowPathFromInstancePath";

suite("workflowPathFromInstancePath", () => {
  test("decodes escaped pointer segments", () => {
    assert.deepStrictEqual(
      workflowPathFromInstancePath("/steps/0/a~1b/~0key"),
      ["steps", 0, "a/b", "~key"]
    );
  });

  test("converts numeric segments to numbers", () => {
    assert.deepStrictEqual(workflowPathFromInstancePath("/steps/10/01"), [
      "steps",
      10,
      1,
    ]);
  });

  test("maps the root pointer to an empty path", () => {
    assert.deepStrictEqual(workflowPathFromInstancePath(""), []);
  });
});
