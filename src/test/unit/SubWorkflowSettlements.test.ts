import * as assert from "assert";
import { suite, test } from "mocha";
import {
  selectLatestSubWorkflowSettlements,
  subWorkflowChildKey,
  type SubWorkflowSettlement,
} from "../../core/orchestration/SubWorkflowSettlements";
import { FINAL_STEP_PHASES, STEP_TYPES } from "../../types/DashboardConstants";
import type {
  RunRef,
  SubWorkflowStep,
  WorkflowKey,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";

const childKey = "child-workflow" as WorkflowKey;

function settlement(
  stepIndex: number,
  childRunRef: string,
  options: {
    stepId?: string;
    timestampMs?: number;
    childWorkflowKey?: WorkflowKey;
  } = {}
): SubWorkflowSettlement {
  return {
    target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex },
    output: {
      childWorkflowKey: options.childWorkflowKey ?? childKey,
      childRunRef: childRunRef as RunRef,
      outcome: { status: "completed" },
    },
    ...(options.stepId !== undefined ? { stepId: options.stepId } : {}),
    timestampMs: options.timestampMs ?? 1,
  };
}

function workflowStep(
  stepId: string,
  runtime: Partial<NonNullable<SubWorkflowStep["_runtime"]>> = {}
): SubWorkflowStep {
  return {
    type: STEP_TYPES.WORKFLOW,
    workflow: `${stepId}.ctrlyoke.yaml`,
    _runtime: { stepId, ...runtime },
  };
}

suite("SubWorkflowSettlements", () => {
  test("drops an event recorded before stepId whose index no longer holds a workflow step", () => {
    // The CLI already dropped it; MCP used to report it on the prompt step
    // now at that index.
    const steps: WorkflowStep[] = [
      { prompt: "p", _runtime: { stepId: "p" } },
      workflowStep("step-a"),
    ];
    const latest = selectLatestSubWorkflowSettlements(
      [settlement(0, "child-gone")],
      { steps }
    );
    assert.deepStrictEqual([...latest.queue.keys()], []);
  });

  test("attributes an event recorded before stepId to a step without one by its index", () => {
    const step: SubWorkflowStep = {
      type: STEP_TYPES.WORKFLOW,
      workflow: "legacy.ctrlyoke.yaml",
    };
    const latest = selectLatestSubWorkflowSettlements(
      [settlement(0, "child-1")],
      { steps: [step] }
    );
    assert.deepStrictEqual([...latest.queue.keys()], [0]);
  });

  test("reports no settlement for a continued child that is running again", () => {
    const step = workflowStep("step-a", {
      childWorkflowKey: childKey,
      childRunRef: "child-1" as RunRef,
      startedAt: 100,
    });
    const earlier = settlement(0, "child-1", {
      stepId: "step-a",
      timestampMs: 50,
    });
    assert.strictEqual(
      selectLatestSubWorkflowSettlements([earlier], { steps: [step] }).queue
        .size,
      0
    );
    // A child of another workflow that shares the runRef is not the one
    // running now, so its settlement stands.
    const otherChild = settlement(0, "child-1", {
      stepId: "step-a",
      timestampMs: 50,
      childWorkflowKey: "other" as WorkflowKey,
    });
    assert.strictEqual(
      selectLatestSubWorkflowSettlements([otherChild], {
        steps: [step],
      }).queue.get(0)?.childWorkflowKey,
      "other"
    );
  });

  test("attributes a childless failure to its step, and drops it once the step runs again", () => {
    const failure: SubWorkflowSettlement = {
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      output: {
        outcome: {
          status: "failed",
          failedToStart: true,
          failureMessage: "cycle",
        },
      },
      stepId: "step-a",
      timestampMs: 50,
    };
    // Settled, with no child linked: two absent identities are not a match,
    // so a step that never launched one still owns the failure.
    assert.strictEqual(
      selectLatestSubWorkflowSettlements([failure], {
        steps: [workflowStep("step-a")],
      }).queue.get(0)?.outcome.failureMessage,
      "cycle"
    );
    // Executing again (Continue after the cause was fixed): the earlier
    // execution's failure is not the step's current status.
    assert.strictEqual(
      selectLatestSubWorkflowSettlements([failure], {
        steps: [workflowStep("step-a", { startedAt: 100 })],
      }).queue.size,
      0
    );
  });

  test("keys a child by workflowKey and runRef", () => {
    assert.notStrictEqual(
      subWorkflowChildKey({
        childWorkflowKey: "a" as WorkflowKey,
        childRunRef: "r" as RunRef,
      }),
      subWorkflowChildKey({
        childWorkflowKey: "b" as WorkflowKey,
        childRunRef: "r" as RunRef,
      })
    );
  });
});
