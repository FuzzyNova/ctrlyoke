import * as assert from "assert";
import { suite, test } from "mocha";
import {
  computeActiveExecutionMs,
  frozenActiveExecutionMs,
  hasWorkflowStepProgress,
  workflowDisplayStep,
  workflowStepProgressAccessibleLabel,
  workflowStepProgressLabel,
} from "../../types/CtrlYokeTypes";

suite("CtrlYokeTypes hasWorkflowStepProgress", () => {
  test("reports progress for a non-empty queue", () => {
    assert.strictEqual(
      hasWorkflowStepProgress({ totalSteps: 2, finalStepRunning: false }),
      true
    );
  });

  test("reports progress for a final step running with an empty queue", () => {
    assert.strictEqual(
      hasWorkflowStepProgress({ totalSteps: 0, finalStepRunning: true }),
      true
    );
  });

  test("reports no progress for an empty queue outside the final step", () => {
    assert.strictEqual(hasWorkflowStepProgress({ totalSteps: 0 }), false);
  });
});

suite("CtrlYokeTypes active execution time", () => {
  test("subtracts settled and open pauses from wall-clock time", () => {
    assert.strictEqual(
      computeActiveExecutionMs(
        { startTime: 1_000, totalPausedDuration: 2_000, pausedTime: 9_000 },
        10_000
      ),
      6_000
    );
  });

  test("freezes at the execution end time", () => {
    assert.strictEqual(
      computeActiveExecutionMs(
        { startTime: 1_000, totalPausedDuration: 500, executionEndTime: 4_000 },
        99_000
      ),
      2_500
    );
  });

  test("reports zero before the timer starts", () => {
    assert.strictEqual(computeActiveExecutionMs({}, 10_000), 0);
  });

  test("reads a settled or paused run's frozen time", () => {
    assert.strictEqual(
      frozenActiveExecutionMs({
        startTime: 1_000,
        totalPausedDuration: 500,
        executionEndTime: 4_000,
      }),
      2_500
    );
    assert.strictEqual(
      frozenActiveExecutionMs({
        startTime: 1_000,
        totalPausedDuration: 500,
        pausedTime: 3_000,
      }),
      1_500
    );
  });

  test("has no frozen time for a ticking or never-started run", () => {
    assert.strictEqual(
      frozenActiveExecutionMs({ startTime: 1_000 }),
      undefined
    );
    assert.strictEqual(frozenActiveExecutionMs({}), undefined);
  });
});

suite("CtrlYokeTypes workflowDisplayStep", () => {
  test("converts an active queue cursor to a one-indexed display step", () => {
    assert.strictEqual(
      workflowDisplayStep({ currentStep: 0, totalSteps: 2 }),
      1
    );
  });

  test("does not advance past the final display step after completion", () => {
    assert.strictEqual(
      workflowDisplayStep({ currentStep: 2, totalSteps: 2 }),
      2
    );
    assert.strictEqual(
      workflowDisplayStep({ currentStep: 3, totalSteps: 2 }),
      2
    );
  });

  test("reports zero progress for an empty queue", () => {
    assert.strictEqual(
      workflowDisplayStep({ currentStep: 0, totalSteps: 0 }),
      0
    );
  });
});

suite("CtrlYokeTypes workflowStepProgressLabel", () => {
  test("formats a queue step as clamped numeric progress", () => {
    assert.strictEqual(
      workflowStepProgressLabel({ currentStep: 6, totalSteps: 10 }),
      "7/10"
    );
    assert.strictEqual(
      workflowStepProgressLabel({ currentStep: 10, totalSteps: 10 }),
      "10/10"
    );
    assert.strictEqual(
      workflowStepProgressLabel({ currentStep: 11, totalSteps: 10 }),
      "10/10"
    );
  });

  test("formats a running final step independently of the queue cursor", () => {
    assert.strictEqual(
      workflowStepProgressLabel({
        currentStep: 10,
        totalSteps: 10,
        finalStepRunning: true,
      }),
      "Final step"
    );
  });

  test("keeps numeric progress when final-step state is false or absent", () => {
    assert.strictEqual(
      workflowStepProgressLabel({
        currentStep: 10,
        totalSteps: 10,
        finalStepRunning: false,
      }),
      "10/10"
    );
    assert.strictEqual(
      workflowStepProgressLabel({ currentStep: 0, totalSteps: 0 }),
      "0/0"
    );
  });
});

suite("CtrlYokeTypes workflowStepProgressAccessibleLabel", () => {
  test("spells out numeric progress so a screen reader does not read a slash", () => {
    assert.strictEqual(
      workflowStepProgressAccessibleLabel({ currentStep: 6, totalSteps: 10 }),
      "step 7 of 10"
    );
  });

  test("clamps the spoken step number exactly like the visible label", () => {
    assert.strictEqual(
      workflowStepProgressAccessibleLabel({ currentStep: 3, totalSteps: 2 }),
      "step 2 of 2"
    );
  });

  test("names the final step instead of a step number", () => {
    assert.strictEqual(
      workflowStepProgressAccessibleLabel({
        currentStep: 2,
        totalSteps: 2,
        finalStepRunning: true,
      }),
      "final step"
    );
  });

  test("agrees with the visible label about which state the row is in", () => {
    for (const finalStepRunning of [true, false, undefined]) {
      const summary = { currentStep: 1, totalSteps: 2, finalStepRunning };
      const visibleIsFinal =
        workflowStepProgressLabel(summary) === "Final step";
      const spokenIsFinal =
        workflowStepProgressAccessibleLabel(summary) === "final step";
      assert.strictEqual(visibleIsFinal, spokenIsFinal);
    }
  });
});
