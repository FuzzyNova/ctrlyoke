import * as assert from "assert";
import { suite, test } from "mocha";
import { formatParallelStepsLabel } from "../../utils/FinalStepLabels";

suite("FinalStepLabels", () => {
  test("formats a parallel group using one-based indexes and an en dash", () => {
    assert.strictEqual(
      formatParallelStepsLabel({ startIndex: 2, endIndex: 4 }),
      "Parallel steps 3–5"
    );
  });
});
