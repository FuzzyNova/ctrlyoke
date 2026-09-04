import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { ScriptProcessRunner } from "../../core/orchestration/ScriptProcessRunner";

suite("ScriptProcessRunner", () => {
  test("isolates timeout and cancellation state between runners", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-runner-")
    );
    const timedOutRunner = new ScriptProcessRunner(root);
    const completingRunner = new ScriptProcessRunner(root);
    const nodeExecutable = process.platform === "win32" ? "node.exe" : "node";

    try {
      const [timedOut, completed] = await Promise.all([
        timedOutRunner.run({
          cwd: root,
          timeout: 300,
          argv: [
            nodeExecutable,
            "-e",
            "setTimeout(() => process.stdout.write('slow'), 2000)",
          ],
        }),
        completingRunner.run({
          cwd: root,
          timeout: 1000,
          argv: [nodeExecutable, "-e", "process.stdout.write('fast')"],
        }),
      ]);

      assert.strictEqual(timedOut.timeout, true);
      assert.strictEqual(timedOut.success, false);
      assert.strictEqual(completed.success, true);
      assert.strictEqual(completed.result, "fast");
    } finally {
      timedOutRunner.dispose();
      completingRunner.dispose();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  });
});
