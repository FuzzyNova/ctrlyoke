import * as assert from "assert";
import { suite, test } from "mocha";
import { workflowDisplayStep } from "../../types/CtrlYokeTypes";

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
