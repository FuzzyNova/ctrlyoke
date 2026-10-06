import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowCommandHandler } from "../../core/orchestration/WorkflowCommandHandler";

suite("WorkflowCommandHandler", () => {
  test("opens the dashboard without a harness-status gate", async () => {
    let focused = false;
    const actions = {
      openWorkspaceTarget: async () => ({ status: "unsupported" as const }),
      focusDashboard: () => { focused = true; },
    };
    await new WorkflowCommandHandler(actions).openPanel();
    assert.strictEqual(focused, true);
  });
});
