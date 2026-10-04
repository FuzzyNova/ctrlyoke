import { suite, test, setup, teardown } from "mocha";
import * as assert from "assert";
import {
  WorkflowActivityTracker,
  type WorkflowActivitySource,
} from "../../core/orchestration/WorkflowActivityTracker";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type {
  QueueState,
  RunRef,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";

function source(
  status: QueueState["status"],
  overrides: Partial<WorkflowActivitySource> = {}
): WorkflowActivitySource {
  return {
    id: "instance-a",
    workflowKey: "lineage-a" as WorkflowKey,
    runRef: "run-1" as RunRef,
    workflowName: "Build",
    executionState: status,
    currentStep: 2,
    totalSteps: 7,
    ...overrides,
  };
}

suite("WorkflowActivityTracker", () => {
  let changes: number;
  let tracker: WorkflowActivityTracker;

  setup(() => {
    changes = 0;
    tracker = new WorkflowActivityTracker(() => changes++, 1);
  });

  teardown(() => {
    tracker.dispose();
  });

  test("a live run that errors becomes an unseen failure", () => {
    assert.strictEqual(
      tracker.observe(source(EXECUTION_STATES.RUNNING)),
      false
    );
    assert.strictEqual(tracker.observe(source(EXECUTION_STATES.ERROR)), true);

    assert.deepStrictEqual(tracker.buildSummary([]).unseenFailures, [
      {
        workflowId: "instance-a",
        workflowName: "Build",
        workflowKey: "lineage-a",
        runRef: "run-1",
      },
    ]);
  });

  test("loading an errored or completed run from history raises nothing", () => {
    assert.strictEqual(tracker.observe(source(EXECUTION_STATES.ERROR)), false);
    assert.strictEqual(
      tracker.observe(source(EXECUTION_STATES.COMPLETED, { id: "instance-b" })),
      false
    );

    const summary = tracker.buildSummary([]);
    assert.deepStrictEqual(summary.unseenFailures, []);
    assert.strictEqual(summary.recentCompletion, undefined);
  });

  test("viewing the failed instance or its run address acknowledges it", () => {
    tracker.observe(source(EXECUTION_STATES.PAUSED));
    tracker.observe(source(EXECUTION_STATES.ERROR));
    tracker.observe(
      source(EXECUTION_STATES.RUNNING, {
        id: "instance-b",
        workflowKey: "lineage-b" as WorkflowKey,
        runRef: "run-9" as RunRef,
      })
    );
    tracker.observe(
      source(EXECUTION_STATES.ERROR, {
        id: "instance-b",
        workflowKey: "lineage-b" as WorkflowKey,
        runRef: "run-9" as RunRef,
      })
    );

    assert.strictEqual(
      tracker.acknowledgeView("unrelated", {
        workflowKey: "lineage-a" as WorkflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      }),
      false,
      "the lineage's draft is not the failed run"
    );
    assert.strictEqual(tracker.acknowledgeView("instance-a", null), true);
    assert.strictEqual(
      tracker.getOldestUnseenFailure()?.workflowId,
      "instance-b"
    );
    assert.strictEqual(
      tracker.acknowledgeView(null, {
        workflowKey: "lineage-b" as WorkflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: "run-9" as RunRef,
      }),
      true
    );
    assert.deepStrictEqual(tracker.buildSummary([]).unseenFailures, []);
  });

  test("a fresh run on the same lineage supersedes its earlier failure", () => {
    tracker.observe(source(EXECUTION_STATES.RUNNING));
    tracker.observe(source(EXECUTION_STATES.ERROR));

    assert.strictEqual(
      tracker.observe(
        source(EXECUTION_STATES.RUNNING, {
          id: "instance-c",
          runRef: "run-2" as RunRef,
        })
      ),
      true
    );
    assert.deepStrictEqual(tracker.buildSummary([]).unseenFailures, []);
  });

  test("forgetRun removes one deleted run or every failure in its lineage", () => {
    for (const [id, workflowKey, runRef] of [
      ["instance-a", "lineage-a", "run-1"],
      ["instance-b", "lineage-b", "run-2"],
      ["instance-c", "lineage-c", "run-3"],
    ] as const) {
      tracker.observe(
        source(EXECUTION_STATES.RUNNING, {
          id,
          workflowKey: workflowKey as WorkflowKey,
          runRef: runRef as RunRef,
        })
      );
      tracker.observe(
        source(EXECUTION_STATES.ERROR, {
          id,
          workflowKey: workflowKey as WorkflowKey,
          runRef: runRef as RunRef,
        })
      );
    }

    assert.strictEqual(
      tracker.forgetRun("lineage-a" as WorkflowKey, "run-1" as RunRef),
      true
    );
    assert.deepStrictEqual(
      tracker.buildSummary([]).unseenFailures.map((failure) => failure.runRef),
      ["run-2", "run-3"]
    );
    assert.strictEqual(tracker.forgetRun("lineage-b" as WorkflowKey), true);
    assert.deepStrictEqual(
      tracker.buildSummary([]).unseenFailures.map((failure) => failure.runRef),
      ["run-3"]
    );
    assert.strictEqual(tracker.forgetRun("lineage-b" as WorkflowKey), false);
  });

  test("a completion shows briefly and then clears itself", async () => {
    tracker.observe(source(EXECUTION_STATES.RUNNING));
    assert.strictEqual(
      tracker.observe(source(EXECUTION_STATES.COMPLETED)),
      true
    );
    assert.deepStrictEqual(tracker.buildSummary([]).recentCompletion, {
      workflowId: "instance-a",
      workflowName: "Build",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(tracker.buildSummary([]).recentCompletion, undefined);
    assert.strictEqual(changes, 1);
  });

  test("summarizes live instances into running and paused with progress", () => {
    const summary = tracker.buildSummary([
      source(EXECUTION_STATES.RUNNING),
      source(EXECUTION_STATES.PAUSING, { id: "instance-b" }),
      source(EXECUTION_STATES.PAUSED, { id: "instance-c", workflowName: "" }),
      source(EXECUTION_STATES.IDLE, { id: "instance-d" }),
      source(EXECUTION_STATES.ERROR, { id: "instance-e" }),
    ]);

    assert.deepStrictEqual(
      summary.running.map((entry) => [entry.workflowId, entry.progressLabel]),
      [
        ["instance-a", "3/7"],
        ["instance-b", "3/7"],
      ]
    );
    assert.deepStrictEqual(summary.paused, [
      { workflowId: "instance-c", workflowName: "", progressLabel: "3/7" },
    ]);
  });
});
