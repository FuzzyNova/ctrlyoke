import * as assert from "assert";
import { suite, test } from "mocha";
import { getEffectiveParallelGroupWidth } from "../../types/DashboardConstants";
import {
  groupParallelGroupSteps,
  insertParallelGroupStep,
  insertParallelGroupSteps,
  insertParallelGroupTopology,
  normalizeParallelGroupTopology,
  reorderParallelGroupSteps,
  reorderParallelGroupPendingSteps,
  snapParallelGroupIndex,
  ungroupParallelGroup,
  unwrapParallelGroup,
  validateParallelGroupTopology,
  deleteParallelGroupStep,
  PARALLEL_GROUP_INSERT_POSITIONS,
  resolveParallelGroupInsertIndex,
  type ParallelGroupTopology,
} from "../../core/ParallelGroupTopology";
import { PARALLEL_GROUP_INSERT_RELOCATION_KINDS } from "../../types/DashboardConstants";
import type { WorkflowStep } from "../../types/CtrlYokeTypes";

const step = (name: string): WorkflowStep => ({ prompt: name });

function topology(
  steps = ["a", "b", "c", "d", "e"],
  parallelGroups = [{ id: "g1", startIndex: 1, endIndex: 3, failFast: true }]
): ParallelGroupTopology {
  return {
    steps: steps.map(step),
    parallelGroups,
  };
}

function ranges(value: ParallelGroupTopology): string {
  return value.parallelGroups
    .map((group) => `${group.id}:${group.startIndex}-${group.endIndex}`)
    .join(",");
}

function names(value: ParallelGroupTopology): string[] {
  return value.steps.map((item) =>
    "prompt" in item ? item.prompt : item.script
  );
}

suite("ParallelGroupTopology", () => {
  test("clamps effective group width to one when fan-out is explicitly disabled", () => {
    assert.strictEqual(getEffectiveParallelGroupWidth(12, false), 1);
  });

  test("uses the configured width when fan-out is enabled", () => {
    assert.strictEqual(getEffectiveParallelGroupWidth(12, true), 12);
  });

  suite("validation", () => {
    test("accepts empty, sorted, non-overlapping groups", () => {
      assert.doesNotThrow(() =>
        validateParallelGroupTopology({
          steps: [step("a"), step("b"), step("c"), step("d")],
          parallelGroups: [
            { id: "a", startIndex: 0, endIndex: 1, failFast: true },
            { id: "b", startIndex: 2, endIndex: 3, failFast: false },
          ],
        })
      );
    });

    for (const invalid of [
      {
        steps: [step("a")],
        parallelGroups: [
          { id: "g", startIndex: 0, endIndex: 0, failFast: true },
        ],
      },
      {
        steps: [step("a"), step("b")],
        parallelGroups: [
          { id: "g", startIndex: -1, endIndex: 1, failFast: true },
        ],
      },
      {
        steps: [step("a"), step("b")],
        parallelGroups: [
          { id: "g", startIndex: 0, endIndex: 2, failFast: true },
        ],
      },
      {
        steps: [step("a"), step("b"), step("c")],
        parallelGroups: [
          { id: "a", startIndex: 0, endIndex: 1, failFast: true },
          { id: "b", startIndex: 1, endIndex: 2, failFast: true },
        ],
      },
      {
        steps: [step("a"), step("b"), step("c"), step("d")],
        parallelGroups: [
          { id: "b", startIndex: 2, endIndex: 3, failFast: true },
          { id: "a", startIndex: 0, endIndex: 1, failFast: true },
        ],
      },
      {
        steps: [step("a"), step("b"), step("c"), step("d")],
        parallelGroups: [
          { id: "g", startIndex: 0, endIndex: 1, failFast: true },
          { id: "g", startIndex: 2, endIndex: 3, failFast: false },
        ],
      },
    ]) {
      test(`rejects ${JSON.stringify(invalid.parallelGroups)}`, () => {
        assert.throws(() => validateParallelGroupTopology(invalid));
      });
    }

    test("normalizes missing groups without sharing arrays", () => {
      const input = { steps: [step("a")], parallelGroups: undefined };
      const result = normalizeParallelGroupTopology(input);
      assert.deepStrictEqual(result.parallelGroups, []);
      assert.notStrictEqual(result.steps, input.steps);
    });

    test("assigns an id and default fail-fast policy during normalization", () => {
      const result = normalizeParallelGroupTopology({
        steps: [step("a"), step("b")],
        parallelGroups: [{ startIndex: 0, endIndex: 1 }],
      });
      assert.match(result.parallelGroups[0].id, /^[0-9a-f-]{36}$/);
      assert.strictEqual(result.parallelGroups[0].failFast, true);
    });
  });

  suite("insertion and deletion", () => {
    test("reports relocation after an enclosing parallel group", () => {
      assert.deepStrictEqual(
        resolveParallelGroupInsertIndex(
          topology(),
          2,
          PARALLEL_GROUP_INSERT_POSITIONS.AFTER
        ),
        {
          requestedIndex: 2,
          insertedIndex: 4,
          relocation: {
            kind: PARALLEL_GROUP_INSERT_RELOCATION_KINDS.AFTER_PARALLEL_GROUP,
            groupId: "g1",
          },
        }
      );
    });

    test("reports an ordinary insertion without relocation", () => {
      assert.deepStrictEqual(
        resolveParallelGroupInsertIndex(
          topology(),
          5,
          PARALLEL_GROUP_INSERT_POSITIONS.AFTER
        ),
        { requestedIndex: 5, insertedIndex: 5 }
      );
    });

    test("moves an insertion inside a group after the group", () => {
      const result = insertParallelGroupStep(topology(), 2, step("x"));
      assert.deepStrictEqual(names(result), ["a", "b", "c", "d", "x", "e"]);
      assert.strictEqual(ranges(result), "g1:1-3");
    });

    test("moves a before insertion inside a group before the group", () => {
      const result = insertParallelGroupStep(
        topology(),
        2,
        step("x"),
        PARALLEL_GROUP_INSERT_POSITIONS.BEFORE
      );
      assert.deepStrictEqual(names(result), ["a", "x", "b", "c", "d", "e"]);
      assert.strictEqual(ranges(result), "g1:2-4");
    });

    test("shifts groups after an insertion and never mutates input", () => {
      const input = topology();
      const result = insertParallelGroupStep(input, 0, step("x"));
      assert.strictEqual(ranges(result), "g1:2-4");
      assert.strictEqual(ranges(input), "g1:1-3");
    });

    test("shifts later groups by the number of inserted steps", () => {
      const result = insertParallelGroupSteps(topology(), 0, [
        step("x"),
        step("y"),
        step("z"),
      ]);
      assert.deepStrictEqual(names(result), [
        "x",
        "y",
        "z",
        "a",
        "b",
        "c",
        "d",
        "e",
      ]);
      assert.strictEqual(ranges(result), "g1:4-6");
    });

    test("shifts a group when several steps land directly before it", () => {
      const result = insertParallelGroupSteps(topology(), 1, [
        step("x"),
        step("y"),
      ]);
      assert.deepStrictEqual(names(result), [
        "a",
        "x",
        "y",
        "b",
        "c",
        "d",
        "e",
      ]);
      assert.strictEqual(ranges(result), "g1:3-5");
    });

    test("shifts later groups by the incoming step count when pasting a topology", () => {
      const result = insertParallelGroupTopology(topology(), 0, {
        steps: [step("x"), step("y")],
        parallelGroups: [
          { id: "g2", startIndex: 0, endIndex: 1, failFast: false },
        ],
      });
      assert.deepStrictEqual(names(result), [
        "x",
        "y",
        "a",
        "b",
        "c",
        "d",
        "e",
      ]);
      assert.deepStrictEqual(result.parallelGroups, [
        { id: "g2", startIndex: 0, endIndex: 1, failFast: false },
        { id: "g1", startIndex: 3, endIndex: 5, failFast: true },
      ]);
    });

    test("inserts a grouped tail without reversing its order", () => {
      const result = insertParallelGroupTopology(topology(), 5, {
        steps: [step("x"), step("y")],
        parallelGroups: [
          { id: "g2", startIndex: 0, endIndex: 1, failFast: false },
        ],
      });
      assert.deepStrictEqual(names(result), [
        "a",
        "b",
        "c",
        "d",
        "e",
        "x",
        "y",
      ]);
      assert.deepStrictEqual(result.parallelGroups, [
        { id: "g1", startIndex: 1, endIndex: 3, failFast: true },
        { id: "g2", startIndex: 5, endIndex: 6, failFast: false },
      ]);
    });

    test("shrinks a group on deletion and unwraps a two-member group", () => {
      const result = deleteParallelGroupStep(topology(), 2);
      assert.strictEqual(ranges(result), "g1:1-2");
      const unwrapped = deleteParallelGroupStep(result, 1);
      assert.deepStrictEqual(unwrapped.parallelGroups, []);
    });

    test("shifts groups after a deletion", () => {
      const result = deleteParallelGroupStep(topology(), 0);
      assert.strictEqual(ranges(result), "g1:0-2");
    });
  });

  suite("reordering and grouping", () => {
    test("reorders members inside a group without changing its range", () => {
      const result = reorderParallelGroupSteps(topology(), 1, 3);
      assert.deepStrictEqual(names(result), ["a", "c", "d", "b", "e"]);
      assert.strictEqual(ranges(result), "g1:1-3");
    });

    test("moves a selected group as a block", () => {
      const result = reorderParallelGroupSteps(topology(), 2, 4);
      assert.deepStrictEqual(names(result), ["a", "e", "b", "c", "d"]);
      assert.strictEqual(ranges(result), "g1:2-4");
    });

    test("does not let an ungrouped step join a group during reorder", () => {
      const result = reorderParallelGroupSteps(topology(), 0, 2);
      assert.deepStrictEqual(names(result), ["b", "c", "d", "a", "e"]);
      assert.strictEqual(ranges(result), "g1:0-2");
    });

    test("reorders pending members while preserving the group", () => {
      const result = reorderParallelGroupPendingSteps(
        topology(),
        0,
        [0, 2, 1, 3, 4]
      );
      assert.deepStrictEqual(names(result), ["a", "c", "b", "d", "e"]);
      assert.strictEqual(ranges(result), "g1:1-3");
    });

    // The steps panel emits a whole-group drag as an ordinary pending
    // permutation whose `pendingGroups` range has simply moved with it.
    test("moves a whole pending group to a later slot", () => {
      const result = reorderParallelGroupPendingSteps(
        topology(),
        0,
        [0, 4, 1, 2, 3],
        [{ id: "g1", start: 2, end: 4, failFast: true }]
      );
      assert.deepStrictEqual(names(result), ["a", "e", "b", "c", "d"]);
      assert.strictEqual(ranges(result), "g1:2-4");
    });

    test("places an ungrouped step above a leading group", () => {
      const result = reorderParallelGroupPendingSteps(
        topology(
          ["a", "b", "c"],
          [{ id: "g1", startIndex: 0, endIndex: 1, failFast: true }]
        ),
        0,
        [2, 0, 1],
        [{ id: "g1", start: 1, end: 2, failFast: true }]
      );
      assert.deepStrictEqual(names(result), ["c", "a", "b"]);
      assert.strictEqual(ranges(result), "g1:1-2");
    });
    test("applies slice-relative group ranges and creates a new group", () => {
      const result = reorderParallelGroupPendingSteps(
        topology(),
        1,
        [2, 0, 1, 3],
        [{ start: 0, end: 1, failFast: false }]
      );
      assert.deepStrictEqual(names(result), ["a", "d", "b", "c", "e"]);
      assert.strictEqual(result.parallelGroups.length, 1);
      assert.strictEqual(result.parallelGroups[0].startIndex, 1);
      assert.strictEqual(result.parallelGroups[0].endIndex, 2);
      assert.strictEqual(result.parallelGroups[0].failFast, false);
      assert.match(result.parallelGroups[0].id, /^[0-9a-f-]{36}$/);
    });

    test("ungroups an existing pending group when its range is omitted", () => {
      const result = reorderParallelGroupPendingSteps(
        topology(),
        0,
        [0, 1, 2, 3, 4],
        []
      );
      assert.deepStrictEqual(result.parallelGroups, []);
    });

    test("rejects moving a member out of a partially settled group", () => {
      const partiallySettled = {
        steps: [
          { prompt: "a", _runtime: { startedAt: 1, completedAt: 2 } },
          { prompt: "b" },
          { prompt: "c" },
          { prompt: "d" },
        ],
        parallelGroups: [
          { id: "settled", startIndex: 0, endIndex: 2, failFast: true },
        ],
      };
      assert.throws(
        () =>
          reorderParallelGroupPendingSteps(partiallySettled, 1, [0, 1, 2], []),
        /settled or in-flight/
      );
    });

    test("rejects changing membership of an in-flight group", () => {
      assert.throws(
        () =>
          reorderParallelGroupPendingSteps(
            topology(),
            1,
            [0, 1, 2, 3],
            [{ start: 0, end: 1, failFast: true }],
            true
          ),
        /settled or in-flight/
      );
    });

    test("creates, ungroups, and unwraps groups", () => {
      const created = groupParallelGroupSteps(
        { steps: [step("a"), step("b"), step("c")], parallelGroups: [] },
        0,
        1,
        false,
        "new"
      );
      assert.deepStrictEqual(created.parallelGroups, [
        { id: "new", startIndex: 0, endIndex: 1, failFast: false },
      ]);
      assert.deepStrictEqual(
        ungroupParallelGroup(created, "new").parallelGroups,
        []
      );
      assert.deepStrictEqual(
        unwrapParallelGroup(created, "new").parallelGroups,
        []
      );
    });

    test("rejects invalid group creation ranges and overlaps", () => {
      assert.throws(() =>
        groupParallelGroupSteps(
          { steps: [step("a"), step("b")], parallelGroups: [] },
          0,
          0
        )
      );
      assert.throws(() => groupParallelGroupSteps(topology(), 2, 4));
    });
  });

  suite("snapping", () => {
    test("snaps rewind and start positions inside a group to its start", () => {
      const value = topology();
      assert.strictEqual(snapParallelGroupIndex(value, 1), 1);
      assert.strictEqual(snapParallelGroupIndex(value, 2), 1);
      assert.strictEqual(snapParallelGroupIndex(value, 3), 1);
      assert.strictEqual(snapParallelGroupIndex(value, 4), 4);
      assert.strictEqual(snapParallelGroupIndex(value, 5), 5);
    });

    test("rejects invalid snap indices", () => {
      assert.throws(() => snapParallelGroupIndex(topology(), -1));
      assert.throws(() => snapParallelGroupIndex(topology(), 6));
    });
  });
});
