import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getBackgroundTaskLabel,
  getBackgroundWorkHoldHeadline,
} from "../../utils/BackgroundWorkHoldText";

suite("BackgroundWorkHoldText", () => {
  test("headline counts pending tasks", () => {
    assert.strictEqual(
      getBackgroundWorkHoldHeadline({
        pendingTasks: [{ taskId: "a" }],
        awaitingResumedTurn: false,
      }),
      "Stop hook received — step kept running until 1 background task finishes"
    );
    assert.strictEqual(
      getBackgroundWorkHoldHeadline({
        pendingTasks: [{ taskId: "a" }, { taskId: "b" }],
        awaitingResumedTurn: true,
      }),
      "Stop hook received — step kept running until 2 background tasks finish"
    );
  });

  test("headline explains a resumed turn still in progress when no task is pending", () => {
    assert.strictEqual(
      getBackgroundWorkHoldHeadline({
        pendingTasks: [],
        awaitingResumedTurn: true,
      }),
      "Stop hook received — step kept running until the harness finishes the turn its background task resumed"
    );
  });

  test("task label prefers the description and keeps the command for identification", () => {
    assert.deepStrictEqual(
      getBackgroundTaskLabel({
        description: "Run full real-harness test suite",
        command: "npm run test:harness",
        toolName: "Bash",
        taskId: "b2gz1o2ty",
      }),
      {
        name: "Run full real-harness test suite",
        meta: "Bash · b2gz1o2ty",
        command: "npm run test:harness",
      }
    );
  });

  test("task label falls back through command, tool, and task id without repeating the name", () => {
    assert.deepStrictEqual(
      getBackgroundTaskLabel({ command: "npm test", taskId: "beul1f741" }),
      { name: "npm test", meta: "beul1f741", command: undefined }
    );
    assert.deepStrictEqual(getBackgroundTaskLabel({ taskId: "shell-7" }), {
      name: "shell-7",
      meta: "",
      command: undefined,
    });
    assert.deepStrictEqual(getBackgroundTaskLabel({}), {
      name: "Background task",
      meta: "",
      command: undefined,
    });
  });
});
