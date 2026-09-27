import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkflowTaggedSink } from "../../core/WorkflowTaggedSink";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import type { PromptDeletedMessage } from "../../types/WebviewMessageTypes";

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
});
