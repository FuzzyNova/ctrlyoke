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
