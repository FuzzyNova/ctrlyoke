import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import {
  queueAsSubWorkflowFromContext,
  type SubWorkflowQueueTarget,
} from "../../platform/QueueAsSubWorkflowCommand";
import type { UserFeedbackSink } from "../../core/UserFeedbackSink";

class RecordingQueueTarget implements SubWorkflowQueueTarget {
  readonly queuedFiles: string[] = [];
  readonly sink: UserFeedbackSink = {
    notify: () => {},
  };

  constructor(private readonly failure?: Error) {}

  getUserFeedbackSink(): UserFeedbackSink {
    return this.sink;
  }

  async queueSubWorkflowFromFileForPanel(filePath: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.queuedFiles.push(filePath);
  }
}

suite("queueAsSubWorkflowFromContext", () => {
  // A file no editor has open, so the save-if-dirty step has nothing to save.
  const childFile = path.join(
    os.tmpdir(),
    "ctrlyoke-queue-as-subworkflow-fixture",
    "child.ctrlyoke.json"
  );

  test("queues the chosen file through the orchestrator's panel queue action", async () => {
    const target = new RecordingQueueTarget();
    const errors: string[] = [];

    await queueAsSubWorkflowFromContext(
      vscode.Uri.file(childFile),
      target,
      (message) => errors.push(message)
    );

    assert.deepStrictEqual(target.queuedFiles, [
      vscode.Uri.file(childFile).fsPath,
    ]);
    assert.deepStrictEqual(errors, []);
  });

  test("reports a missing file selection and queues nothing", async () => {
    const target = new RecordingQueueTarget();
    const errors: string[] = [];

    await queueAsSubWorkflowFromContext(undefined, target, (message) =>
      errors.push(message)
    );

    assert.deepStrictEqual(target.queuedFiles, []);
    assert.deepStrictEqual(errors, ["No file selected"]);
  });

  test("reports a refused queue instead of rejecting", async () => {
    const target = new RecordingQueueTarget(new Error("No steps found"));
    const errors: string[] = [];

    await queueAsSubWorkflowFromContext(
      vscode.Uri.file(childFile),
      target,
      (message) => errors.push(message)
    );

    assert.deepStrictEqual(errors, [
      "Failed to queue as a sub-workflow: No steps found",
    ]);
  });
});
