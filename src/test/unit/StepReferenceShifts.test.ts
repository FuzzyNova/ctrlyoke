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

  test("never scans the inside of an inline workflow step definition", () => {
    // References inside an inline definition could only address the child
    // run (D13), so a parent topology change never shifts them.
    const inlinePrompt = {
      type: "workflow",
      name: "inline prompt",
      workflow: {
        prompt: "child $step:2 and $step:summary:3",
        sessionId: 2,
        priorContext: [3],
        endCondition: { script: "true", retryPrompt: "retry $step:2" },
      },
    };
    const inlineScript = {
      type: "workflow",
      name: "inline script",
      workflow: { type: "script", script: "echo $step:2" },
    };
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { prompt: "second" },
      { prompt: "third" },
      inlinePrompt,
      inlineScript,
    ] as WorkflowStep[]);
    const finalStep = {
      type: "workflow",
      workflow: { prompt: "final child $step:2" },
    } as WorkflowStep;

    const inserted = ensureStepIds(
      [oldSteps[0], { prompt: "new" }, ...oldSteps.slice(1)] as WorkflowStep[],
      oldSteps
    );
    const removed = oldSteps.filter((_, index) => index !== 1);
    const moved = [
      oldSteps[0],
      oldSteps[2],
      oldSteps[1],
      oldSteps[3],
      oldSteps[4],
    ];

    for (const newSteps of [inserted, removed, moved]) {
      assert.deepStrictEqual(
        findShiftedStepReferences(oldSteps, newSteps, { finalStep }),
        []
      );
    }
    // The inline definition itself is left exactly as authored.
    assert.strictEqual(
      (oldSteps[3] as { workflow: { prompt: string } }).workflow.prompt,
      "child $step:2 and $step:summary:3"
    );
  });

  test("reports a parent reference to a workflow step's position like any step's", () => {
    const oldSteps = ensureStepIds([
      { prompt: "first" },
      { type: "workflow", name: "lane", workflow: "lanes/a.ctrlyoke.yaml" },
      {
        type: "workflow",
        workflow: { prompt: "inline lane", worktree: { mode: "managed" } },
      },
      { prompt: "merge $step:summary:2-3", name: "merge" },
      { prompt: "uses $previous", priorContext: [3] },
    ] as WorkflowStep[]);

    const inserted = ensureStepIds(
      [oldSteps[0], { prompt: "new" }, ...oldSteps.slice(1)] as WorkflowStep[],
      oldSteps
    );
    assert.deepStrictEqual(findShiftedStepReferences(oldSteps, inserted), [
      'Step 5 ("merge")',
      "Step 6",
    ]);

    const removed = oldSteps.filter((_, index) => index !== 0);
    assert.deepStrictEqual(findShiftedStepReferences(oldSteps, removed), [
      'Step 3 ("merge")',
      "Step 4",
    ]);

    // Swapping the two workflow steps shifts both of the merge step's
    // references; the final step's reference to step 2 shifts too.
    const moved = [
      oldSteps[0],
      oldSteps[2],
      oldSteps[1],
      oldSteps[3],
      oldSteps[4],
    ];
    assert.deepStrictEqual(
      findShiftedStepReferences(oldSteps, moved, {
        finalStep: { prompt: "final $step:2" },
      }),
      ['Step 4 ("merge")', "Step 5", "Final step"]
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
