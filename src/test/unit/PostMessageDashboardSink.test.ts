import { strict as assert } from "assert";
import { suite, test } from "mocha";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";

suite("PostMessageDashboardSink", () => {
  test("serializes settled sub-workflow metadata to the dashboard", () => {
    const messages: unknown[] = [];
    const sink = new PostMessageDashboardSink((message) =>
      messages.push(message)
    );
    const output = {
      childWorkflowKey: "child-key" as never,
      childRunRef: "child-run" as never,
      outcome: { status: "completed" as const },
      worktree: {
        mode: "managed" as const,
        branchName: "feature/child",
        baseCommit: "base",
        mergeOutcome: "fast-forward" as const,
      },
    };

    sink.updateSubWorkflowSettled?.({
      target: { kind: "queue", stepIndex: 2 },
      runIndex: 0,
      attemptIndex: 1,
      timestampMs: 1234,
      sequence: 9,
      output,
      workflowId: "parent-instance",
    });

    assert.deepEqual(messages, [
      {
        type: MESSAGE_TYPES.SUB_WORKFLOW_SETTLED,
        target: { kind: "queue", stepIndex: 2 },
        runIndex: 0,
        attemptIndex: 1,
        timestampMs: 1234,
        sequence: 9,
        output,
        workflowId: "parent-instance",
      },
    ]);
  });
});
