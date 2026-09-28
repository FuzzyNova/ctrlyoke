import * as assert from "assert";
import { suite, test } from "mocha";
import { getExitCode } from "../../cli/CliExitCode";
import {
  EXECUTION_STATES,
  FAILURE_KINDS,
  STEP_STATUS,
} from "../../types/DashboardConstants";
import type { QueueState } from "../../types/CtrlYokeTypes";

suite("CliExitCode", () => {
  test("returns 3 for a typed missing-harness failure", () => {
    const state: Pick<QueueState, "status" | "results"> = {
      status: EXECUTION_STATES.ERROR,
      results: [
        {
          prompt: "hello",
          status: STEP_STATUS.FAILED,
          timestamp: new Date(),
          error: "Harness CLI could not be started",
          failureKind: FAILURE_KINDS.HARNESS_NOT_INSTALLED,
        },
      ],
    };

    assert.strictEqual(getExitCode(state), 3);
  });

  test("returns 1 when generic failure text contains 'not found'", () => {
    const state: Pick<QueueState, "status" | "results"> = {
      status: EXECUTION_STATES.ERROR,
      results: [
        {
          prompt: "hello",
          status: STEP_STATUS.FAILED,
          timestamp: new Date(),
          error: "Credentials not found",
        },
      ],
    };

    assert.strictEqual(getExitCode(state), 1);
  });

  test("returns 4 for a typed timeout failure", () => {
    const state: Pick<QueueState, "status" | "results"> = {
      status: EXECUTION_STATES.ERROR,
      results: [
        {
          prompt: "hello",
          status: STEP_STATUS.FAILED,
          timestamp: new Date(),
          failureKind: FAILURE_KINDS.TIMEOUT,
        },
      ],
    };

    assert.strictEqual(getExitCode(state), 4);
  });
});
