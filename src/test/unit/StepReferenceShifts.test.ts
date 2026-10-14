import * as assert from "assert";
import { ensureStepIds } from "../../core/StepIdentity";
import {
  describeShiftedStepReferences,
  describeStepRemoval,
  findShiftedStepReferences,
} from "../../core/StepReferenceShifts";
import type { WorkflowStep } from "../../types/CtrlYokeTypes";

suite("StepReferenceShifts", () => {
  test("reports a step whose reference an insert shifted, but not the inserted step", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "target" },
      { prompt: "reference $step:2", name: "uses target" },
    ] as WorkflowStep[]);
    const inserted = ensureStepIds(
      [
        oldSteps[0],
        { prompt: "new $step:2" },
        oldSteps[1],
        oldSteps[2],
      ] as WorkflowStep[],
      oldSteps
    );

    assert.deepStrictEqual(findShiftedStepReferences(oldSteps, inserted), [
      'Step 4 ("uses target")',
    ]);
  });

  test("reports nothing when steps are appended at the end", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "reference $step:1", sessionId: 1, priorContext: [1] },
    ] as WorkflowStep[]);
    const appended = ensureStepIds(
      [...oldSteps, { prompt: "new" }] as WorkflowStep[],
      oldSteps
    );

    assert.deepStrictEqual(findShiftedStepReferences(oldSteps, appended), []);
  });

  test("checks sessionId, priorContext lists, and retry prompts, and ignores code spans", () => {
    const steps = (reference: Partial<WorkflowStep>) =>
      ensureStepIds([
        { prompt: "removed" },
        { prompt: "kept" },
        { prompt: "reference", ...reference },
      ] as WorkflowStep[]);
    const removeFirst = (oldSteps: WorkflowStep[]) =>
      findShiftedStepReferences(oldSteps, oldSteps.slice(1));

    assert.deepStrictEqual(removeFirst(steps({ sessionId: 2 })), ["Step 2"]);
    assert.deepStrictEqual(removeFirst(steps({ priorContext: [1] })), [
      "Step 2",
    ]);
    assert.deepStrictEqual(
      removeFirst(
        steps({
          endCondition: { script: "true", retryPrompt: "retry $step:2" },
        } as Partial<WorkflowStep>)
      ),
      ["Step 2"]
    );
    assert.deepStrictEqual(
      removeFirst(steps({ prompt: "literal `$step:1`" })),
      []
    );
  });

  test("does not report steps that already started", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "started $step:1", _runtime: { startedAt: 1 } },
    ] as WorkflowStep[]);

    assert.deepStrictEqual(
      findShiftedStepReferences(oldSteps, [oldSteps[1]]),
      []
    );
  });

  test("does not report the moved step itself, only steps whose targets moved", () => {
    // Step 5 is written for its destination, then dragged to position 4.
    const oldSteps = ensureStepIds([
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
      { prompt: "moved", priorContext: [1, 2, 3, 4] },
      { prompt: "after $step:4" },
    ] as WorkflowStep[]);
    const reordered = [
      oldSteps[0],
      oldSteps[1],
      oldSteps[2],
      oldSteps[4],
      oldSteps[3],
      oldSteps[5],
    ];

    assert.deepStrictEqual(findShiftedStepReferences(oldSteps, reordered), [
      "Step 6",
    ]);
  });

  test("reports the final step and workflow-level defaults", () => {
    const oldSteps = ensureStepIds([
      { prompt: "removed" },
      { prompt: "kept" },
    ] as WorkflowStep[]);

    assert.deepStrictEqual(
      findShiftedStepReferences(oldSteps, [oldSteps[1]], {
        finalStep: { prompt: "final $step:2" },
        workflowDefaults: { priorContext: [1], sessionId: 2 },
      }),
      ["Final step", "workflow Prior Context", "workflow Session"]
    );
  });

  test("describes the warning, or nothing when no reference shifted", () => {
    assert.strictEqual(
      describeShiftedStepReferences(describeStepRemoval([2, 0]), ["Step 3"]),
      "Removed steps 1, 3. Step references in Step 3 now point at a different or missing step; check them."
    );
    assert.strictEqual(
      describeShiftedStepReferences(describeStepRemoval([0]), []),
      undefined
    );
  });
});
