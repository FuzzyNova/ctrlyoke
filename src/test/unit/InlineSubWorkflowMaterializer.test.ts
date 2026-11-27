import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_PROPERTY_KEYS,
  type PromptFile,
  type SubWorkflowStep,
} from "../../types/CtrlYokeTypes";
import {
  INLINE_INHERITED_EXECUTION_KEYS,
  materializeInlineSubWorkflow,
  substituteInlineStepName,
} from "../../utils/InlineSubWorkflowMaterializer";

const STEP_2 = { label: "step 2" };

function inlineStep(
  workflow: SubWorkflowStep["workflow"],
  extra: Partial<SubWorkflowStep> = {}
): SubWorkflowStep {
  return { type: "workflow", workflow, ...extra } as SubWorkflowStep;
}

suite("InlineSubWorkflowMaterializer", () => {
  test("inherits every execution property except the run-scoped ones", () => {
    assert.deepStrictEqual(
      [...INLINE_INHERITED_EXECUTION_KEYS].sort(),
      EXECUTION_PROPERTY_KEYS.filter(
        (key) =>
          key !== "sessionId" &&
          key !== "resumeSession" &&
          key !== "priorContext"
      ).sort()
    );
    const parent: PromptFile = {
      name: "Parent",
      harness: "codex-cli",
      model: "parent-model",
      sandbox: true,
      sandboxMode: "read-only",
      priorContextDetail: "summary",
      toolPermissions: { mode: "allowAll" },
      maxSteps: 7,
      vars: { value: "authored" },
      steps: [],
    };
    const { definition } = materializeInlineSubWorkflow(
      parent,
      { value: "cli-override" },
      inlineStep({ prompt: "{{value}}" }),
      STEP_2
    );
    assert.strictEqual(definition.harness, "codex-cli");
    assert.strictEqual(definition.model, "parent-model");
    assert.strictEqual(definition.sandbox, true);
    assert.strictEqual(definition.sandboxMode, "read-only");
    assert.strictEqual(definition.priorContextDetail, "summary");
    assert.deepStrictEqual(definition.toolPermissions, { mode: "allowAll" });
    assert.strictEqual(definition.maxSteps, 7);
    assert.deepStrictEqual(definition.vars, { value: "cli-override" });
  });

  test("keeps the inline step's keys on the step and moves only worktree to the root", () => {
    const parent: PromptFile = { model: "parent-model", steps: [] };
    const { definition } = materializeInlineSubWorkflow(
      parent,
      {},
      inlineStep({
        prompt: "child",
        name: "Inner",
        model: "inline-model",
        enabled: true,
        color: "blue",
        worktree: { mode: "managed" },
      } as SubWorkflowStep["workflow"]),
      STEP_2
    );
    assert.deepStrictEqual(definition.steps, [
      {
        prompt: "child",
        name: "Inner",
        model: "inline-model",
        enabled: true,
        color: "blue",
      },
    ]);
    // The step overrides the inherited root at resolution, like any step.
    assert.strictEqual(definition.model, "parent-model");
    assert.deepStrictEqual(definition.worktree, { mode: "managed" });
    const root = definition as Record<string, unknown>;
    for (const key of ["enabled", "color", "prompt"]) {
      assert.ok(!(key in root), `${key} must not reach the child root`);
    }
  });

  test("never hands the child the parent's session or relative prior-context selectors", () => {
    for (const priorContext of [
      "previous",
      "all",
      [1, 2],
      { previous: 2 },
    ] as PromptFile["priorContext"][]) {
      for (const resumeSession of [true, false]) {
        const { definition } = materializeInlineSubWorkflow(
          {
            resumeSession,
            priorContext,
            sessionId: 1,
            steps: [],
          },
          {},
          inlineStep({ prompt: "child" }),
          STEP_2
        );
        assert.strictEqual(definition.resumeSession, undefined);
        assert.strictEqual(definition.priorContext, undefined);
        assert.strictEqual(definition.sessionId, undefined);
      }
    }
    const runAddress = { workflow: "release", run: 2 };
    assert.deepStrictEqual(
      materializeInlineSubWorkflow(
        { priorContext: runAddress, steps: [] },
        {},
        inlineStep({ prompt: "child" }),
        STEP_2
      ).definition.priorContext,
      runAddress
    );
  });

  test("inherits the parent's declared trusted external roots, null included", () => {
    const materialize = (trustedExternalRoots: string[] | null | undefined) =>
      materializeInlineSubWorkflow(
        { trustedExternalRoots, steps: [] },
        {},
        inlineStep({ prompt: "child" }),
        STEP_2
      ).definition;
    assert.deepStrictEqual(materialize(["/approved"]).trustedExternalRoots, [
      "/approved",
    ]);
    assert.strictEqual(materialize(null).trustedExternalRoots, null);
    assert.ok(!("trustedExternalRoots" in materialize(undefined)));
  });

  test("names the child exactly from the step name, else the parent and position", () => {
    const parent: PromptFile = { name: "Parent", steps: [] };
    assert.strictEqual(
      materializeInlineSubWorkflow(
        parent,
        {},
        inlineStep({ prompt: "child" }, { name: "check src/core" }),
        STEP_2,
        "Actual lineage name"
      ).displayName,
      "check src/core"
    );
    const unnamed = materializeInlineSubWorkflow(
      parent,
      {},
      inlineStep({ prompt: "child" }),
      { label: "final step pass 3" },
      "Actual lineage name"
    );
    assert.strictEqual(
      unnamed.displayName,
      "Actual lineage name · final step pass 3"
    );
    assert.strictEqual(unnamed.definition.name, unnamed.displayName);
  });

  test("uses the dispatch-substituted display name without changing child fields", () => {
    const result = materializeInlineSubWorkflow(
      { vars: { name: "run-start" }, steps: [] },
      { name: "dispatch" },
      inlineStep({ prompt: "{{name}}", name: "{{name}}" }),
      STEP_2,
      "Parent",
      "dispatch"
    );
    assert.strictEqual(result.displayName, "dispatch");
    assert.strictEqual(result.definition.steps?.[0].name, "{{name}}");
    assert.strictEqual(
      (result.definition.steps?.[0] as { prompt?: string }).prompt,
      "{{name}}"
    );
  });

  test("a name that substitutes to nothing gets the default label", () => {
    const result = materializeInlineSubWorkflow(
      { vars: { name: "" }, steps: [] },
      { name: "" },
      inlineStep({ prompt: "child", name: "{{name}}" }),
      STEP_2,
      "Parent",
      ""
    );
    assert.strictEqual(result.displayName, "Parent · step 2");
  });

  test("a name that cannot substitute gets the default label, never its {{…}} text", () => {
    const step = inlineStep({ prompt: "child" }, { name: "{{missing}} lane" });
    const name = substituteInlineStepName(step, {}, 1);
    assert.strictEqual(name, "");
    const result = materializeInlineSubWorkflow(
      { steps: [] },
      {},
      step,
      STEP_2,
      "Parent",
      name
    );
    assert.strictEqual(result.displayName, "Parent · step 2");
    assert.strictEqual(result.definition.name, "Parent · step 2");
  });

  test("a name that substitutes is the child's name, and no name stays unnamed", () => {
    assert.strictEqual(
      substituteInlineStepName(
        inlineStep({ prompt: "child" }, { name: "{{area}} lane" }),
        { area: "core" },
        1
      ),
      "core lane"
    );
    assert.strictEqual(
      substituteInlineStepName(inlineStep({ prompt: "child" }), {}, 1),
      undefined
    );
  });
});
