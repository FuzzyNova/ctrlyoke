import * as assert from "assert";
import { suite, test } from "mocha";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
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

  test("forwards the persisted token aggregate through working-file updates", async () => {
    const workspaceFolderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-cli-watch-")
    );
    try {
      const workflowKey = "watch-tokens" as WorkflowKey;
      const runRef = "run-2026-07-20T10-30-00-000Z" as RunRef;
      const workingFilePath = path.join(workspaceFolderPath, "workflow.json");
      const tokenTotals = {
        total: 18,
        coverage: "complete" as const,
        reportedAttemptCount: 1,
        attemptCount: 1,
        isFinal: false,
        byHarness: {},
        byLocalDay: {},
      };
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          steps: [{ prompt: "step" }],
          _runtime: {
            currentIndex: 1,
            executionState: "running",
            tokenTotals,
          },
        }),
        "utf8"
      );

      let update: Record<string, unknown> | undefined;
      const session = new CliWatchSession(
        workingFilePath,
        workflowKey,
        runRef,
        workspaceFolderPath,
        (summary) => {
          update = summary as Record<string, unknown>;
        },
        () => {},
        () => {}
      );
      await (
        session as unknown as { handleWorkingFileChange: () => Promise<void> }
      ).handleWorkingFileChange();

      assert.deepStrictEqual(update?.tokenTotals, tokenTotals);
      assert.strictEqual(update?.currentStep, 1);
    } finally {
      await fs.rm(workspaceFolderPath, { recursive: true, force: true });
    }
  });
});
