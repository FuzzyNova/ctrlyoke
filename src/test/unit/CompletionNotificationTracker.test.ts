import * as assert from "assert";
import { suite, test } from "mocha";
import type { WorkflowSummary } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES, STEP_STATUS } from "../../types/DashboardConstants";
import { CompletionNotificationTracker } from "../../ui/notifications/CompletionNotificationTracker";

suite("CompletionNotificationTracker", () => {
  const makeSummary = (
    id: string,
    executionState: WorkflowSummary["executionState"],
    runRef = "run-1"
  ): WorkflowSummary => ({
    id,
    workflowKey: "lineage-1" as WorkflowSummary["workflowKey"],
    runRef: runRef as WorkflowSummary["runRef"],
    workflowName: "workflow",
    filePath: "workflow.ctrlyoke.yaml",
    executionState,
    currentStep: 0,
    totalSteps: 1,
  });

  test("returns the previous summary when applying an update", () => {
    const tracker = new CompletionNotificationTracker();
    const running = makeSummary("instance-1", EXECUTION_STATES.RUNNING);
    const completed = makeSummary("instance-1", EXECUTION_STATES.COMPLETED);
    tracker.workflowAdded(running);

    assert.deepStrictEqual(tracker.summaryUpdated(completed), running);
  });

  for (const terminalState of [
    EXECUTION_STATES.COMPLETED,
    EXECUTION_STATES.ERROR,
  ]) {
    test(`${terminalState} to RUNNING clears only that run's event ids`, () => {
      const tracker = new CompletionNotificationTracker();
      const runOne = makeSummary("instance-1", terminalState, "run-1");
      const runTwo = makeSummary("instance-2", terminalState, "run-2");
      tracker.workflowAdded(runOne);
      tracker.workflowAdded(runTwo);
      assert.strictEqual(
        tracker.markShown("lineage-1:run-1:workflow:done"),
        true
      );
      assert.strictEqual(
        tracker.markShown("lineage-1:run-2:workflow:done"),
        true
      );

      tracker.summaryUpdated(
        makeSummary("instance-1", EXECUTION_STATES.RUNNING, "run-1")
      );

      assert.strictEqual(
        tracker.markShown("lineage-1:run-1:workflow:done"),
        true
      );
      assert.strictEqual(
        tracker.markShown("lineage-1:run-2:workflow:done"),
        false
      );
    });
  }

  test("step RUNNING clears that workflow's event ids", () => {
    const tracker = new CompletionNotificationTracker();
    tracker.workflowAdded(makeSummary("instance-1", EXECUTION_STATES.RUNNING));
    tracker.workflowAdded(
      makeSummary("instance-2", EXECUTION_STATES.RUNNING, "run-2")
    );
    tracker.markShown("lineage-1:run-1:prompt:0:completed");
    tracker.markShown("lineage-1:run-2:prompt:0:completed");

    assert.ok(tracker.stepStatusChanged("instance-1", STEP_STATUS.RUNNING));
    assert.strictEqual(
      tracker.markShown("lineage-1:run-1:prompt:0:completed"),
      true
    );
    assert.strictEqual(
      tracker.markShown("lineage-1:run-2:prompt:0:completed"),
      false
    );
  });

  test("dismiss clears that workflow's ids and forgets its summary", () => {
    const tracker = new CompletionNotificationTracker();
    tracker.workflowAdded(makeSummary("instance-1", EXECUTION_STATES.RUNNING));
    tracker.markShown("lineage-1:run-1:prompt:0:completed");

    tracker.workflowDismissed("instance-1");

    assert.strictEqual(
      tracker.stepStatusChanged("instance-1", STEP_STATUS.RUNNING),
      undefined
    );
    assert.strictEqual(
      tracker.markShown("lineage-1:run-1:prompt:0:completed"),
      true
    );
  });

  test("markShown reports duplicate event ids", () => {
    const tracker = new CompletionNotificationTracker();

    assert.strictEqual(tracker.markShown("event-1"), true);
    assert.strictEqual(tracker.markShown("event-1"), false);
  });
});
