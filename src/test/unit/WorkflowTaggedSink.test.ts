import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowTaggedSink } from "../../core/WorkflowTaggedSink";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import type {
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
