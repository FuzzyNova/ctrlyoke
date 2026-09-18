import * as assert from "assert";
import { suite, test } from "mocha";
import {
  workflowDisplayStep,
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
