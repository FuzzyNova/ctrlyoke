import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowCommandHandler } from "../../core/orchestration/WorkflowCommandHandler";
import { USER_FEEDBACK_SEVERITY } from "../../types/DashboardConstants";
import type { UserFeedback } from "../../core/UserFeedbackSink";
import { Log } from "../../utils/Log";

suite("WorkflowCommandHandler", () => {
  test("opens the dashboard without a harness-status gate", async () => {
    let focused = false;
    const actions = {
      openWorkspaceTarget: async () => ({ status: "unsupported" as const }),
      focusDashboard: () => {
        focused = true;
      },
    };
    await new WorkflowCommandHandler(actions).openPanel();
    assert.strictEqual(focused, true);
  });

  test("reports a prompt-file open failure without logging success", async () => {
    const feedback: UserFeedback[] = [];
    const messages: string[] = [];
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };
    try {
      const actions = {
        openWorkspaceTarget: async () => ({
          status: "failed" as const,
          message: "file is unavailable",
        }),
      };
      const handler = new WorkflowCommandHandler(actions, {
        notify: (message) => feedback.push(message),
      });

      await handler.openCurrentPromptFile("missing.ctrlyoke.yaml");

      assert.deepStrictEqual(feedback, [
        {
          severity: USER_FEEDBACK_SEVERITY.ERROR,
          message: "ctrlyoke: Failed to open file: file is unavailable",
        },
      ]);
      assert.strictEqual(
        messages.some((message) => message.includes("Opened prompt file")),
        false
      );
    } finally {
      Log.info = originalInfo;
    }
  });
});
