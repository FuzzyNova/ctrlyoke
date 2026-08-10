import * as assert from "assert";
import {
  CLI_EVENT_TYPES,
  COMPACTION_TRIGGERS,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";
import { summarizeCompactionEvents } from "../../utils/TokenUsage";

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
});
