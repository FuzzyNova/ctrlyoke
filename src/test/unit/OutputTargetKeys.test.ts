import * as assert from "assert";
import { suite, test } from "mocha";
import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import {
  finalTargetKey,
  outputAttemptKey,
  outputTargetKey,
  queueTargetKey,
} from "../../utils/OutputTargetKeys";

suite("OutputTargetKeys", () => {
  test("keeps queue and final target keys byte-identical", () => {
    assert.strictEqual(queueTargetKey(12), "queue:12");
    assert.strictEqual(finalTargetKey(3), "final:3");
    assert.strictEqual(
      outputTargetKey({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 12 }),
      "queue:12"
    );
    assert.strictEqual(
      outputTargetKey({ kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 3 }),
      "final:3"
    );
  });

  test("preserves attempt keys and execution phase suffixes", () => {
    assert.strictEqual(
      outputAttemptKey({ kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 12 }, 4, 2),
      "queue:12:run:4:attempt:2"
    );
    assert.strictEqual(
      outputAttemptKey(
        { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: 3 },
        4,
        2,
        EXECUTION_PHASES.END_CONDITION
      ),
      "final:3:run:4:attempt:2:phase:endCondition"
    );
  });
});
