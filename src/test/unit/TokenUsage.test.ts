import * as assert from "assert";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  resolveDisplayedAttemptTokens,
  summarizeCompactionEvents,
} from "../../utils/TokenUsage";

function compactionEvent(preTokens?: number): CliEvent {
  return {
    type: CLI_EVENT_TYPES.COMPACTION,
    data: {
      trigger: COMPACTION_TRIGGERS.AUTO,
      preTokens,
    },
  };
}

suite("TokenUsage", () => {
  test("counts compactions and sums finite pre-token values", () => {
    const result = summarizeCompactionEvents([
      compactionEvent(200_000),
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "after" } },
      compactionEvent(Number.NaN),
      compactionEvent(210_000),
      compactionEvent(Number.POSITIVE_INFINITY),
    ]);

    assert.deepStrictEqual(result, {
      compactionCount: 4,
      compactedContextTokens: 410_000,
    });
  });

  test("reports the count when no pre-token values are finite", () => {
    assert.deepStrictEqual(
      summarizeCompactionEvents([compactionEvent(Number.NaN)]),
      { compactionCount: 1 }
    );
  });

  test("returns undefined when parser output has no event stream", () => {
    assert.strictEqual(summarizeCompactionEvents(undefined), undefined);
  });

  suite("resolveDisplayedAttemptTokens", () => {
    test("counts compactions streamed before the attempt completes", () => {
      assert.deepStrictEqual(
        resolveDisplayedAttemptTokens({
          structured: {
            events: [compactionEvent(367_265)],
            metadata: {},
          },
        }),
        { compactionCount: 1 }
      );
    });

    test("raises a completed count when follow-up activity compacted again", () => {
      const result = resolveDisplayedAttemptTokens({
        tokens: { prompt: 10, completion: 5, compactionCount: 1 },
        structured: {
          events: [compactionEvent(1), compactionEvent(2)],
          metadata: {},
        },
      });
      assert.deepStrictEqual(result, {
        prompt: 10,
        completion: 5,
        compactionCount: 2,
      });
    });

    test("returns the completed tokens unchanged otherwise", () => {
      const tokens = { prompt: 10, completion: 5, compactionCount: 0 };
      assert.strictEqual(
        resolveDisplayedAttemptTokens({
          tokens,
          structured: { events: [], metadata: {} },
        }),
        tokens
      );
      assert.strictEqual(resolveDisplayedAttemptTokens(undefined), undefined);
    });
  });
});
