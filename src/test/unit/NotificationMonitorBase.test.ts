import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import {
  NotificationMonitorBase,
  type HookConfig,
} from "../../core/harness/shared/interfaces/INotificationMonitor";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

class TestNotificationMonitor extends NotificationMonitorBase {
  buildHookConfig(): HookConfig {
    return { type: "none" };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return workspaceRoot;
  }
}

suite("NotificationMonitorBase", () => {
  test("scopes standalone Stop-file monitoring to the owning run", async () => {
    const tempDir = makeTempDir("ctrlyoke-notify-race-");
    const runA = new TestNotificationMonitor();
    const runB = new TestNotificationMonitor();
    const stopFile = path.join(tempDir, "session-from-run-a-stop.json");

    try {
      await fs.promises.writeFile(
        stopFile,
        JSON.stringify({
          hookEvent: "Stop",
          runId: "run-a",
          sessionId: "session-from-run-a",
          status: "completed",
        }),
        "utf8"
      );

      const startTime = new Date(Date.now() - 50);
      const runBResult = await runB.monitorForCompletion(
        { directory: tempDir, timeoutMs: 50, pollMs: 10 },
        undefined,
        startTime,
        undefined,
        "run-b"
      );

      assert.strictEqual(runBResult.completed, false);
      assert.strictEqual(fs.existsSync(stopFile), true);

      const runAResult = await runA.monitorForCompletion(
        { directory: tempDir, timeoutMs: 100, pollMs: 10 },
        undefined,
        startTime,
        undefined,
        "run-a"
      );
      assert.strictEqual(runAResult.completed, true);
      assert.strictEqual(runAResult.data?.sessionId, "session-from-run-a");
      assert.strictEqual(fs.existsSync(stopFile), false);
    } finally {
      removeTempDir(tempDir);
    }
  });

  test("detects harness error notification files and cleans them up", async () => {
    const tempDir = makeTempDir("ctrlyoke-notify-");
    const monitor = new TestNotificationMonitor();
    const sessionId = "session-123";
    const errorFile = path.join(tempDir, `${sessionId}-error.json`);

    try {
      await fs.promises.writeFile(
        errorFile,
        JSON.stringify({
          hookEvent: "StopFailure",
          sessionId,
          status: "error",
        }),
        "utf8"
      );

      const result = await monitor.monitorForCompletion(
        {
          directory: tempDir,
          timeoutMs: 200,
          pollMs: 25,
        },
        sessionId,
        new Date(Date.now() - 50)
      );

      assert.strictEqual(result.completed, false);
      assert.strictEqual(result.kind, "error");
      assert.strictEqual(result.error, "Harness reported an error");
      assert.strictEqual(result.data?.sessionId, sessionId);
      assert.strictEqual(fs.existsSync(errorFile), false);
    } finally {
      removeTempDir(tempDir);
    }
  });
});
