import * as assert from "assert";
import { suite, test } from "mocha";
import { CliAttemptTally } from "../../cli/CliAttemptTally";

suite("CliAttemptTally", () => {
  test("totals a retried finalStep pass beside a retried queue step", () => {
    const tally = new CliAttemptTally();

    tally.start("queue:0", "build", 0);
    tally.complete("queue:0", {
      elapsed: 2,
      tokens: { prompt: 10, completion: 5 },
    });
    tally.start("queue:0", "build", 1);
    tally.complete("queue:0", { elapsed: 3 });
    for (const attemptIndex of [0, 1, 2]) {
      tally.start("final:0", "Final pass 1", attemptIndex);
      tally.complete("final:0", {
        elapsed: 4,
        tokens: { prompt: 100, completion: 20 },
      });
    }

    assert.deepStrictEqual(tally.retriedGroups(), [
      {
        stepName: "build",
        attemptCount: 2,
        totalElapsed: 5,
        tokenStats: [{ prompt: 10, completion: 5 }],
      },
      {
        stepName: "Final pass 1",
        attemptCount: 3,
        totalElapsed: 12,
        tokenStats: [
          { prompt: 100, completion: 20 },
          { prompt: 100, completion: 20 },
          { prompt: 100, completion: 20 },
        ],
      },
    ]);
  });

  test("keeps each finalStep pass separate and omits targets that never retried", () => {
    const tally = new CliAttemptTally();

    tally.start("final:0", "Final pass 1", 0);
    tally.complete("final:0", { elapsed: 4 });
    tally.start("final:1", "Final pass 2", 0);
    tally.complete("final:1", { elapsed: 6 });
    tally.start("final:1", "Final pass 2", 1);
    tally.complete("final:1", { elapsed: 7 });

    assert.deepStrictEqual(
      tally
        .retriedGroups()
        .map((group) => [group.stepName, group.totalElapsed]),
      [["Final pass 2", 13]]
    );
  });

  test("counts an attempt's stats once when its completion repeats", () => {
    const tally = new CliAttemptTally();

    tally.start("final:0", "Final pass 1", 1);
    tally.complete("final:0", { elapsed: 4 });
    tally.complete("final:0", { elapsed: 4 });

    assert.strictEqual(tally.retriedGroups()[0].totalElapsed, 4);
  });
});
