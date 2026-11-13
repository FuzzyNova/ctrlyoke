import * as assert from "assert";
import { suite, test } from "mocha";
import { settleCliParallelGroupMember } from "../../cli/CliParallelGroupTally";
import { STEP_STATUS } from "../../types/DashboardConstants";

suite("CliParallelGroupTally", () => {
  function createState(started = [0]) {
    return {
      started: new Set(started),
      completed: new Set<number>(),
      failed: new Set<number>(),
    };
  }

  test("moves a completed turn to failed when its end condition fails", () => {
    const state = createState();
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.COMPLETED),
      true
    );
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.FAILED),
      true
    );
    assert.deepStrictEqual([...state.completed], []);
    assert.deepStrictEqual([...state.failed], [0]);
  });

  test("counts an errored end condition as failed", () => {
    const state = createState();
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.FAILED),
      true
    );
    assert.deepStrictEqual([...state.completed], []);
    assert.deepStrictEqual([...state.failed], [0]);
  });

  test("reopens a failed member on retry and settles it completed", () => {
    const state = createState();
    settleCliParallelGroupMember(state, 0, STEP_STATUS.FAILED);
    state.failed.delete(0);
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.RUNNING),
      false
    );
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.COMPLETED),
      true
    );
    assert.deepStrictEqual([...state.completed], [0]);
    assert.deepStrictEqual([...state.failed], []);
  });

  test("ignores a member that has not started", () => {
    const state = createState([]);
    assert.strictEqual(
      settleCliParallelGroupMember(state, 0, STEP_STATUS.FAILED),
      false
    );
    assert.deepStrictEqual([...state.completed], []);
    assert.deepStrictEqual([...state.failed], []);
  });
});
