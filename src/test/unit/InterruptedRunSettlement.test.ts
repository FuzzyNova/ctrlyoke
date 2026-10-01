import * as assert from "assert";
import { suite, test } from "mocha";
import type { WorkingFile } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import { settleInterruptedRun } from "../../utils/InterruptedRunSettlement";

function run(
  steps: NonNullable<WorkingFile["steps"]>,
  runtime: NonNullable<WorkingFile["_runtime"]>
): WorkingFile {
  return { steps, startedAt: 0, definitionRevision: 1, _runtime: runtime };
}

suite("InterruptedRunSettlement", () => {
  test("cancels the claimed current step and moves past it", () => {
    const file = run(
      [
        { prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "in flight", _runtime: { startedAt: 3 } },
        { prompt: "next" },
      ],
      { currentIndex: 1, executionState: EXECUTION_STATES.RUNNING }
    );

    assert.strictEqual(settleInterruptedRun(file, 10), true);
    assert.deepStrictEqual(file.steps![1]._runtime, {
      startedAt: 3,
      completedAt: 10,
      terminalStatus: PROMPT_TERMINAL_STATUS.CANCELLED,
    });
    assert.deepStrictEqual(file.steps![0]._runtime, {
      startedAt: 1,
      completedAt: 2,
    });
    assert.strictEqual(file.steps![2]._runtime, undefined);
    assert.strictEqual(file._runtime!.currentIndex, 2);
  });

  test("cancels every in-flight parallel member, not just the current one", () => {
    const file = run(
      [
        { prompt: "a", _runtime: { startedAt: 1 } },
        { prompt: "b", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "c", _runtime: { startedAt: 1 } },
      ],
      { currentIndex: 0, executionState: EXECUTION_STATES.RUNNING }
    );

    assert.strictEqual(settleInterruptedRun(file, 10), true);
    assert.strictEqual(
      file.steps![0]._runtime?.terminalStatus,
      PROMPT_TERMINAL_STATUS.CANCELLED
    );
    assert.strictEqual(file.steps![1]._runtime?.terminalStatus, undefined);
    assert.strictEqual(
      file.steps![2]._runtime?.terminalStatus,
      PROMPT_TERMINAL_STATUS.CANCELLED
    );
    assert.strictEqual(file._runtime!.currentIndex, 1);
  });

  test("cancels an unfinished final step once the queue is exhausted", () => {
    const file = run(
      [{ prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } }],
      {
        currentIndex: 1,
        executionState: EXECUTION_STATES.RUNNING,
        finalStep: {
          phase: FINAL_STEP_PHASES.FINAL_STEP,
          loopCount: 0,
          status: STEP_STATUS.SENT,
        },
      }
    );

    assert.strictEqual(settleInterruptedRun(file, 10), true);
    assert.strictEqual(file._runtime!.finalStep?.status, STEP_STATUS.CANCELLED);
    assert.strictEqual(file._runtime!.finalStep?.completedAt, 10);
  });

  test("leaves a run with nothing in flight untouched", () => {
    const file = run(
      [
        { prompt: "done", _runtime: { startedAt: 1, completedAt: 2 } },
        { prompt: "next" },
      ],
      { currentIndex: 1, executionState: EXECUTION_STATES.RUNNING }
    );
    const before = JSON.stringify(file);

    assert.strictEqual(settleInterruptedRun(file, 10), false);
    assert.strictEqual(JSON.stringify(file), before);
  });
});
