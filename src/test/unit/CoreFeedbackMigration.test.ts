import * as assert from "assert";
import { suite, test } from "mocha";
import { TemplateImporter } from "../../core/orchestration/TemplateImporter";
import { WorkflowCommandHandler } from "../../core/orchestration/WorkflowCommandHandler";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import type { UserFeedback } from "../../core/UserFeedbackSink";

suite("Core feedback migration", () => {
  test("routes command-handler failures through the feedback sink", async () => {
    const feedback: UserFeedback[] = [];
    const handler = new WorkflowCommandHandler(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      { notify: (message) => feedback.push(message) }
    );

    await handler.createPromptFile();

    assert.deepStrictEqual(feedback, [
      {
        severity: "error",
        message: "ctrlyoke: No workspace folder found",
      },
    ]);
  });

  test("routes template-import failures through the feedback sink", async () => {
    const feedback: UserFeedback[] = [];
    const importer = new TemplateImporter({} as any, undefined, {
      notify: (message) => feedback.push(message),
    });

    await importer.importWorkflowTemplates();

    assert.deepStrictEqual(feedback, [
      {
        severity: "error",
        message: "ctrlyoke: No workspace folder open",
      },
    ]);
  });

  test("emits a scoped failure only through the initiating client transport", () => {
    const firstClient: unknown[] = [];
    const secondClient: unknown[] = [];
    const contexts = [
      createWebviewClientContext("browser:1", (message) => {
        firstClient.push(message);
      }),
      createWebviewClientContext("browser:2", (message) => {
        secondClient.push(message);
      }),
    ];

    contexts[0].emit({
      type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
      action: "load workflow",
      error: "invalid workflow",
    });

    assert.strictEqual(firstClient.length, 1);
    assert.deepStrictEqual(secondClient, []);
  });
});
