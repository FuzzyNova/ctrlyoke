import * as assert from "assert";
import { suite, test } from "mocha";
import { FINAL_STEP_PHASES } from "../../types/DashboardConstants";
import { getFinalStepPassCount } from "../../types/CtrlYokeTypes";

suite("getFinalStepPassCount", () => {
  test("returns the final-step index plus one", () => {
    assert.strictEqual(
      getFinalStepPassCount({
        phase: FINAL_STEP_PHASES.FINAL_STEP,
        loopCount: 2,
      }),
      3
    );
  });

  test("returns the queue-phase count without incrementing it", () => {
    assert.strictEqual(
      getFinalStepPassCount({ phase: FINAL_STEP_PHASES.QUEUE, loopCount: 2 }),
      2
    );
  });

  test("returns zero when runtime is absent", () => {
    assert.strictEqual(getFinalStepPassCount(undefined), 0);
  });
});
