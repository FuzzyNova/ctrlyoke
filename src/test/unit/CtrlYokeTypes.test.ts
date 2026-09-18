import * as assert from "assert";
import { suite, test } from "mocha";
import {
  workflowDisplayStep,
  workflowStepProgressAccessibleLabel,
  workflowStepProgressLabel,
} from "../../types/CtrlYokeTypes";

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
