import * as assert from "assert";
import { suite, test } from "mocha";
import {
  deduplicatePriorContextItems,
  mergePriorContextReferences,
} from "../../utils/PriorContextMerge";

suite("PriorContextMerge", () => {
  test("merges previous counts and unions explicit step indices", () => {
    const merged = mergePriorContextReferences(
      ["previous", { previous: 3 }, [2, 3, 3], [4]],
      4
    );

    assert.deepStrictEqual(merged.contexts, [{ previous: 3 }, [2, 3, 4]]);
    assert.deepStrictEqual(merged.queueIndices, [0, 1, 2, 3]);
    assert.deepStrictEqual(merged.explicitQueueIndices, [1, 2, 3]);
    assert.strictEqual(merged.previousCount, 3);
  });

  test("keeps full detail when the same index is selected at both detail levels", () => {
    const merged = mergePriorContextReferences(
      [
        { context: [2], detail: "summary" },
        { context: [2], detail: "full" },
        { context: "previous", detail: "summary" },
      ],
      3
    );
    assert.strictEqual(merged.detailByQueueIndex.get(1), "full");
    assert.strictEqual(merged.fullPreviousCount, 0);
  });

  test("limits full previous detail to the count requested at full", () => {
    const merged = mergePriorContextReferences(
      [
        { context: { previous: 3 }, detail: "summary" },
        { context: "previous", detail: "full" },
      ],
      4
    );
    assert.strictEqual(merged.previousCount, 3);
    assert.strictEqual(merged.fullPreviousCount, 1);
  });

  test("deduplicates queue and final-step items by their distinct identities", () => {
    const items = [
      { index: 1, text: "queue" },
      { index: 1, text: "duplicate queue" },
      { index: 1, type: "finalStep", text: "final" },
      { index: 1, type: "finalStep", text: "duplicate final" },
    ];

    assert.deepStrictEqual(deduplicatePriorContextItems(items), [
      items[0],
      items[2],
    ]);
  });
});
