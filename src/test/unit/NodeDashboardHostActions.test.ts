import * as assert from "assert";
import { NodeDashboardHostActions } from "../../platform/NodeDashboardHostActions";
import { DASHBOARD_ACTION_RESULT_STATUSES } from "../../types/DashboardConstants";

suite("NodeDashboardHostActions", () => {
  test("routes workspace targets and content previews through the browser viewer", async () => {
    const actions = new NodeDashboardHostActions();
    assert.deepStrictEqual(
      await actions.openWorkspaceTarget({ path: "src/index.ts", startLine: 4 }),
      { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED }
    );
    assert.deepStrictEqual(
      await actions.openContentPreview({ content: "diff", language: "diff" }),
      { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED }
    );
    assert.strictEqual("selectWorkspacePath" in actions, false);
    assert.strictEqual("focusDashboard" in actions, false);
    assert.strictEqual("revealOutput" in actions, false);
  });
});
