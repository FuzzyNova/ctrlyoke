import * as assert from "assert";
import { ensureStepIds } from "../../core/StepIdentity";
import {
  describeStepRemovalWarning,
  renumberStepReferences,
} from "../../core/StepReferenceRenumbering";
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

    assert.deepStrictEqual(result.affectedSteps, []);
    assert.strictEqual((result.steps[3] as PromptStep).sessionId, 3);
    assert.deepStrictEqual(
      (result.steps[3] as PromptStep).priorContext,
      [1, 3]
    );
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
    assert.deepStrictEqual(
      (result.steps[2] as PromptStep).priorContext,
      [2, 1]
    );
  });

  test("renumbers inline $summary:step references while leaving full references in sync", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "target" },
      {
        prompt: "reference $summary:step:1,2 and $step:2",
        endCondition: { script: "true", retryPrompt: "retry $summary:step:2" },
      },
    ] as WorkflowStep[]);
    const inserted = ensureStepIds(
      [...oldSteps.slice(0, 1), { prompt: "new" }, ...oldSteps.slice(1)],
      oldSteps
    );
    const result = renumberStepReferences(oldSteps, inserted);
    assert.strictEqual(
      (result.steps[3] as PromptStep).prompt,
      "reference $summary:step:1,3 and $step:3"
    );
    assert.strictEqual(
      (result.steps[3] as PromptStep).endCondition?.retryPrompt,
      "retry $summary:step:3"
    );
  });

  test("leaves inline step ranges untouched when none of their targets move", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "second" },
      { prompt: "reference $step:1-2" },
    ] as WorkflowStep[]);
    const appended = ensureStepIds([...oldSteps, { prompt: "new" }], oldSteps);
    const result = renumberStepReferences(oldSteps, appended);
    assert.strictEqual(
      (result.steps[2] as PromptStep).prompt,
      "reference $step:1-2"
    );
  });

  test("does not renumber step references written inside code spans", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "reference $step:1 but not `$step:1`" },
    ] as WorkflowStep[]);
    const inserted = ensureStepIds([{ prompt: "new" }, ...oldSteps], oldSteps);
    const result = renumberStepReferences(oldSteps, inserted);
    assert.strictEqual(
      (result.steps[2] as PromptStep).prompt,
      "reference $step:2 but not `$step:1`"
    );
  });

  test("removes a referenced target, clears the session link, and reports the unstarted step", () => {
    const oldSteps = ensureStepIds([
      { prompt: "target" },
      {
        prompt: "follow-up",
        name: "follow-up",
        sessionId: 1,
        priorContext: [1],
      },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, [oldSteps[1]]);

    assert.deepStrictEqual(result.affectedSteps, ['Step 2 ("follow-up")']);
    assert.strictEqual("sessionId" in result.steps[0], false);
    assert.deepStrictEqual((result.steps[0] as PromptStep).priorContext, []);
    assert.strictEqual(
      describeStepRemovalWarning(result, [0]),
      'Removed step 1. Step references in Step 2 ("follow-up") may now point at a missing or different step; check them.'
    );
  });

  test("never edits inline references when a step is removed", () => {
    const oldSteps = ensureStepIds([
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      {
        prompt: "use $step:1-3 and $summary:step:3",
        endCondition: { script: "true", retryPrompt: "retry $step:2" },
      },
      { prompt: "unaffected $step:1" },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, [
      oldSteps[0],
      oldSteps[2],
      oldSteps[3],
      oldSteps[4],
    ]);

    const referencing = result.steps[2] as PromptStep;
    assert.strictEqual(referencing.prompt, "use $step:1-3 and $summary:step:3");
    assert.strictEqual(referencing.endCondition?.retryPrompt, "retry $step:2");
    assert.strictEqual(
      (result.steps[3] as PromptStep).prompt,
      "unaffected $step:1"
    );
    assert.deepStrictEqual(result.affectedSteps, ["Step 4"]);
  });

  test("does not report a started step whose inline references a removal invalidated", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "started $step:1", _runtime: { startedAt: 1 } },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, [oldSteps[1]]);

    assert.strictEqual(
      (result.steps[0] as PromptStep).prompt,
      "started $step:1"
    );
    assert.deepStrictEqual(result.affectedSteps, []);
    assert.strictEqual(describeStepRemovalWarning(result, [0]), undefined);
  });

  test("renumbers after removing an unrelated step", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "other" },
      { prompt: "target" },
      { prompt: "follow-up", sessionId: 3, priorContext: [2, 3] },
    ] as WorkflowStep[]);

    const result = renumberStepReferences(oldSteps, oldSteps.slice(1));

    assert.deepStrictEqual(result.affectedSteps, []);
    assert.strictEqual((result.steps[2] as PromptStep).sessionId, 2);
    assert.deepStrictEqual(
      (result.steps[2] as PromptStep).priorContext,
      [1, 2]
    );
  });

  test("clears a removed session target and renumbers final-step references", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "target" },
      { prompt: "started reference", sessionId: 1, _runtime: { startedAt: 1 } },
    ] as WorkflowStep[]);
    const finalStep = { prompt: "final", sessionId: 2, priorContext: [2] };

    const result = renumberStepReferences(
      oldSteps,
      oldSteps.slice(1),
      finalStep
    );

    assert.strictEqual("sessionId" in result.steps[1], false);
    assert.strictEqual((result.finalStep as PromptStep).sessionId, 1);
    assert.deepStrictEqual((result.finalStep as PromptStep).priorContext, [1]);
    assert.deepStrictEqual(result.affectedSteps, []);
  });

  test("removes a target referenced by finalStep and reports the final step", () => {
    const oldSteps = ensureStepIds([{ prompt: "target" }]);

    const result = renumberStepReferences(oldSteps, [], {
      prompt: "final",
      sessionId: 1,
    });

    assert.deepStrictEqual(result.affectedSteps, ["Final step"]);
    assert.strictEqual("sessionId" in (result.finalStep ?? {}), false);
  });
});
