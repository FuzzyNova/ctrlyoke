import * as assert from "assert";
import { suite, test } from "mocha";
import {
  QUEUE_POSITION,
  resolveQueueInsertIndex,
} from "../../types/DashboardConstants";

suite("resolveQueueInsertIndex", () => {
  test("places parallelWithCurrent after the current live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        2,
        7,
        parallelGroups
      ),
      4
    );
  });

  test("keeps next as an ordinary insertion inside a live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(QUEUE_POSITION.NEXT, 2, 7, parallelGroups),
      3
    );
  });
});
