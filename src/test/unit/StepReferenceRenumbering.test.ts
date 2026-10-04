import * as assert from "assert";
import { ensureStepIds } from "../../core/StepIdentity";
import { renumberStepReferences } from "../../core/StepReferenceRenumbering";
import type { PromptStep, WorkflowStep } from "../../types/CtrlYokeTypes";

suite("StepReferenceRenumbering", () => {
  test("renumbers sessionId and priorContext when a step is inserted before the target", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "target" },
      { prompt: "reference", sessionId: 2, priorContext: [1, 2] },
    ] as WorkflowStep[]);
    const inserted = ensureStepIds(
      [...oldSteps.slice(0, 1), { prompt: "new" }, ...oldSteps.slice(1)],
      oldSteps
    );

    const result = renumberStepReferences(oldSteps, inserted);

    assert.deepStrictEqual(result.refusals, []);
    assert.strictEqual((result.steps[3] as PromptStep).sessionId, 3);
    assert.deepStrictEqual((result.steps[3] as PromptStep).priorContext, [1, 3]);
  });

  test("renumbers references after a reorder", () => {
    const oldSteps = ensureStepIds([
      { prompt: "target" },
      { prompt: "middle" },
      { prompt: "reference", sessionId: 1, priorContext: [1, 2] },
    ] as WorkflowStep[]);
    const reordered = [oldSteps[1], oldSteps[0], oldSteps[2]];

    const result = renumberStepReferences(oldSteps, reordered);

    assert.strictEqual((result.steps[2] as PromptStep).sessionId, 2);
    assert.deepStrictEqual((result.steps[2] as PromptStep).priorContext, [2, 1]);
  });

  test("refuses removing a referenced target while the referencing step is unstarted", () => {
    const oldSteps = ensureStepIds([
      { prompt: "target" },
      { prompt: "follow-up", name: "follow-up", sessionId: 1 },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, [oldSteps[1]]);

    assert.deepStrictEqual(result.refusals, ['Step 2 ("follow-up")']);
  });

  test("renumbers after removing an unrelated step", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "other" },
      { prompt: "target" },
      { prompt: "follow-up", sessionId: 3, priorContext: [2, 3] },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, oldSteps.slice(1));

    assert.deepStrictEqual(result.refusals, []);
    assert.strictEqual((result.steps[2] as PromptStep).sessionId, 2);
    assert.deepStrictEqual((result.steps[2] as PromptStep).priorContext, [1, 2]);
  });
});
