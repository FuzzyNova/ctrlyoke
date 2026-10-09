import * as assert from "assert";
import { suite, test } from "mocha";
import { workflowPathFromInstancePath } from "../../completions/WorkflowPathFromInstancePath";

suite("workflowPathFromInstancePath", () => {
  test("decodes escaped pointer segments", () => {
    assert.deepStrictEqual(
      workflowPathFromInstancePath("/steps/0/a~1b/~0key", { steps: [{}] }),
      ["steps", 0, "a/b", "~key"]
    );
  });

  test("converts numeric segments to numbers", () => {
    assert.deepStrictEqual(
      workflowPathFromInstancePath("/steps/10/01", {
        steps: Array(11).fill({ "01": true }),
      }),
      ["steps", 10, "01"]
    );
  });

  test("maps the root pointer to an empty path", () => {
    assert.deepStrictEqual(workflowPathFromInstancePath(""), []);
  });

  test("preserves numeric property names for object keys", () => {
    assert.deepStrictEqual(
      workflowPathFromInstancePath("/vars/123", { vars: { "123": true } }),
      ["vars", "123"]
    );
    assert.deepStrictEqual(
      workflowPathFromInstancePath("/vars/01", { vars: { "01": true } }),
      ["vars", "01"]
    );
  });
});
