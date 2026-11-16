import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowTaggedSink } from "../../core/WorkflowTaggedSink";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import {
  FINAL_STEP_PHASES,
  HEADLESS_STEER_DELIVERIES,
  HARNESS_IDS,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import type {
  HeadlessControlTargetMessage,
  PromptDeletedMessage,
  StepUndoDataUpdatedMessage,
} from "../../types/WebviewMessageTypes";

suite("WorkflowTaggedSink", () => {
  test("updatePromptDeleted forwards its workflowId", () => {
    const messages: unknown[] = [];
    const sink = new WorkflowTaggedSink(
      new PostMessageDashboardSink((message) => messages.push(message)),
      "wf-a"
    );

    sink.updatePromptDeleted("a.yaml", []);

    assert.deepStrictEqual(messages[0], {
      type: MESSAGE_TYPES.PROMPT_DELETED,
      fileName: "a.yaml",
      steps: [],
      finalStep: null,
      workflowId: "wf-a",
    } satisfies PromptDeletedMessage);
  });

  test("sendStepUndoDataUpdated forwards its workflowId", () => {
    const messages: unknown[] = [];
    const sink = new WorkflowTaggedSink(
      new PostMessageDashboardSink((message) => messages.push(message)),
      "wf-a"
    );
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const workspaceSnapshot = { capturedAt: 123 } as any;

    sink.sendStepUndoDataUpdated(target, workspaceSnapshot);

    assert.deepStrictEqual(messages[0], {
      type: MESSAGE_TYPES.STEP_UNDO_DATA_UPDATED,
      target,
      workspaceSnapshot,
      workflowId: "wf-a",
    } satisfies StepUndoDataUpdatedMessage);
  });

  test("headless control target uses the tagged workflow and preserves lifecycle", () => {
    const messages: unknown[] = [];
    const sink = new WorkflowTaggedSink(
      new PostMessageDashboardSink((message) => messages.push(message)),
      "wf-a"
    );
    const target: HeadlessControlTargetMessage = {
      type: MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED,
      workflowId: "untrusted-workflow",
      controlSessionId: "control-1",
      stepIndex: 2,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      steerDelivery: HEADLESS_STEER_DELIVERIES.INJECT,
      isOpen: true,
    };

    sink.updateHeadlessControlTarget(target);

    assert.deepStrictEqual(messages[0], {
      ...target,
      workflowId: "wf-a",
    });
  });

  test("updateExecutionState forwards structured guardrail stop reasons", () => {
    const messages: unknown[] = [];
    const sink = new WorkflowTaggedSink(
      new PostMessageDashboardSink((message) => messages.push(message)),
      "wf-a"
    );
    const stopReason = {
      code: "queue-size-limit",
      threshold: 10,
      observed: 11,
      unit: "steps",
      message: "Queue size limit: 10 steps configured, 11 observed.",
    } as const;

    sink.updateExecutionState("error", undefined, [], stopReason);

    assert.deepStrictEqual(messages[0], {
      type: MESSAGE_TYPES.EXECUTION_STATE_CHANGED,
      state: "error",
      workflowId: "wf-a",
      activeStepIndices: [],
      stopReason,
    });
  });
});
