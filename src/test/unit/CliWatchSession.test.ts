import * as assert from "assert";
import { suite, test } from "mocha";
import { CliWatchSession } from "../../core/orchestration/CliWatchSession";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("CliWatchSession", () => {
  test("pins its manifest path to the exact constructed workflowKey/runRef, never 'newest'", () => {
    const workspaceFolderPath = "C:\\dev\\some-workspace";
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
    const workingFilePath = WorkflowPaths.runFilePath(
      workspaceFolderPath,
      workflowKey,
      runRef
    );

    const session = new CliWatchSession(
      workingFilePath,
      workflowKey,
      runRef,
      workspaceFolderPath,
      () => {},
      () => {},
      () => {}
    );

    assert.strictEqual(
      session.getActiveHistoryFilePath(),
      WorkflowPaths.manifestPath(workspaceFolderPath, workflowKey, runRef)
    );
  });

  test("tracks last-known output count per step independently", () => {
    const workspaceFolderPath = "C:\\dev\\some-workspace";
    const workflowKey = "my-workflow-2026-07-20T10-30-00" as WorkflowKey;
    const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
    const session = new CliWatchSession(
      WorkflowPaths.runFilePath(workspaceFolderPath, workflowKey, runRef),
      workflowKey,
      runRef,
      workspaceFolderPath,
      () => {},
      () => {},
      () => {}
    );

    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(0, 3), 0);
    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(0, 5), 3);
    assert.strictEqual(session.getAndUpdateLastKnownOutputCount(1, 1), 0);
  });
});
