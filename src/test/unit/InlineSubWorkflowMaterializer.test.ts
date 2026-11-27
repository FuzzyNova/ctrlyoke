import * as assert from "assert";
import { suite, test } from "mocha";
import type { PromptFile, SubWorkflowStep } from "../../types/CtrlYokeTypes";
import { materializeInlineSubWorkflow } from "../../utils/InlineSubWorkflowMaterializer";

suite("InlineSubWorkflowMaterializer", () => {
  test("inherits execution defaults and effective vars, overlays the step, and drops parent selectors", () => {
    const parent: PromptFile = {
      name: "Parent",
      harness: "codex-cli",
      model: "parent-model",
      maxSteps: 7,
      vars: { value: "authored" },
      toolPermissions: { mode: "allowAll" },
      trustedExternalRoots: ["/approved"],
      resumeSession: true,
      priorContext: "previous",
      steps: [],
    };
    const step = {
      type: "workflow",
      name: "Child name",
      workflow: {
        type: "prompt",
        prompt: "{{value}}",
        model: "inline-model",
      },
    } as SubWorkflowStep;
    const result = materializeInlineSubWorkflow(
      parent,
      { value: "cli-override" },
      ["/approved"],
      step,
      2,
      "Actual lineage name"
    );
    assert.strictEqual(result.displayName, "Child name");
    assert.strictEqual(result.definition.harness, "codex-cli");
    assert.strictEqual(result.definition.model, "inline-model");
    assert.strictEqual(result.definition.maxSteps, 7);
    assert.deepStrictEqual(result.definition.toolPermissions, {
      mode: "allowAll",
    });
    assert.deepStrictEqual(result.definition.vars, { value: "cli-override" });
    assert.deepStrictEqual(result.definition.trustedExternalRoots, [
      "/approved",
    ]);
    assert.strictEqual(result.definition.resumeSession, undefined);
    assert.strictEqual(result.definition.priorContext, undefined);
    assert.strictEqual(result.definition.steps?.[0].type, "prompt");
    assert.strictEqual(
      materializeInlineSubWorkflow(
        parent,
        { value: "cli-override" },
        ["/approved"],
        [step].map((value) => ({ ...value, name: undefined }))[0],
        2,
        "Actual lineage name"
      ).displayName,
      "Actual lineage name · step 2"
    );
  });
});
