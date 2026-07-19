import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";

suite("WorkflowLockManager stale-run recovery", () => {
  test("marks the interrupted step cancelled and removes a VS Code lock", async () => {
    const workingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-recovery-")
    );
    const workingFilePath = path.join(workingDir, "interrupted.ctrlyoke.json");

    try {
      await fs.writeFile(
        workingFilePath,
        JSON.stringify({
          steps: [
            {
              prompt: "continue later",
              _runtime: {
                startedAt: 100,
                sessionId: "session-survives",
              },
            },
          ],
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.RUNNING,
          },
        }),
        "utf8"
      );
      await WorkflowLockManager.acquireLock(workingFilePath, {
        runner: RUNNER_IDS.VSCODE,
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
        instanceId: "old-extension-host",
        workflowId: "interrupted",
      });

      const result = await WorkflowLockManager.normalizeStaleLocks(workingDir);
      const recovered = JSON.parse(
        await fs.readFile(workingFilePath, "utf8")
      ) as {
        steps: Array<{
          _runtime: {
            sessionId: string;
            completedAt?: number;
            terminalStatus?: string;
          };
        }>;
        _runtime: { currentIndex: number; executionState: string };
      };

      assert.deepStrictEqual(result.activeCliPaths, []);
      assert.deepStrictEqual(result.recoveredPaths, [workingFilePath]);
      assert.strictEqual(
        recovered._runtime.executionState,
        EXECUTION_STATES.STOPPED
      );
      assert.strictEqual(recovered._runtime.currentIndex, 1);
      assert.strictEqual(
        recovered.steps[0]._runtime.terminalStatus,
        PROMPT_TERMINAL_STATUS.CANCELLED
      );
      assert.strictEqual(
        typeof recovered.steps[0]._runtime.completedAt,
        "number"
      );
      assert.strictEqual(
        recovered.steps[0]._runtime.sessionId,
        "session-survives"
      );
      await assert.rejects(
        fs.access(WorkflowLockManager.getLockPath(workingFilePath))
      );
    } finally {
      await fs.rm(workingDir, { recursive: true, force: true });
    }
  });
});
