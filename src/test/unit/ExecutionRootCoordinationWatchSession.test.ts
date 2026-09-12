import * as assert from "assert";
import { suite, test } from "mocha";
import {
  ExecutionRootCoordinationWatchSession,
  COORDINATION_BOARD_CHANGE_THROTTLE_MS,
} from "../../core/orchestration/ExecutionRootCoordinationWatchSession";
import type { CoordinationScopeSnapshot } from "../../types/CtrlYokeTypes";

const snapshot: CoordinationScopeSnapshot = {
  executionRoot: "C:\\workspace",
  identity: "workspace-identity",
  participants: [],
  entries: [],
  claims: [],
  attestationNotice: "untrusted",
};

suite("ExecutionRootCoordinationWatchSession", () => {
  test("bounds a burst of board changes to leading and trailing refreshes", async () => {
    let broadcasts = 0;
    const session = new ExecutionRootCoordinationWatchSession(
      snapshot.executionRoot,
      () => {
        broadcasts += 1;
      },
      async () => snapshot
    );

    try {
      for (let index = 0; index < 20; index += 1) {
        session.notifyBoardChanged();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COORDINATION_BOARD_CHANGE_THROTTLE_MS + 30)
      );

      assert.ok(broadcasts >= 1);
      assert.ok(
        broadcasts <= 2,
        `expected at most two refreshes, received ${broadcasts}`
      );
    } finally {
      session.dispose();
    }
  });
});
