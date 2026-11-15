import * as assert from "assert";
import { WORKTREE_MERGE_OUTCOMES } from "../../types/DashboardConstants";
import { isWorktreeMergeSuccess } from "../../utils/formatWorktreeOutcome";

suite("isWorktreeMergeSuccess", () => {
  test("accepts only fast-forward and merge-commit outcomes", () => {
    for (const outcome of Object.values(WORKTREE_MERGE_OUTCOMES)) {
      const expected =
        outcome === WORKTREE_MERGE_OUTCOMES.FAST_FORWARD ||
        outcome === WORKTREE_MERGE_OUTCOMES.MERGE_COMMIT;
      assert.strictEqual(isWorktreeMergeSuccess(outcome), expected, outcome);
    }

    assert.strictEqual(isWorktreeMergeSuccess(undefined), false);
  });
});
