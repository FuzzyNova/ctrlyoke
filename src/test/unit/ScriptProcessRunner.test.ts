import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  CliProcessManager,
  SpawnOptions,
  SpawnResult,
} from "../../utils/CliProcessManager";
import {
  resolveScriptInvocation,
  ScriptProcessRunner,
} from "../../core/orchestration/ScriptProcessRunner";

suite("ScriptProcessRunner", () => {
  test("reports an unrequested signal death as a script failure", async () => {
    class SignalledProcessManager implements Pick<
      CliProcessManager,
      "spawn" | "cancel" | "dispose"
    > {
      async spawn(
        _command: string,
        _args: string[],
        _options?: SpawnOptions
      ): Promise<SpawnResult> {
        return {
          stdout: "",
          stderr: "",
          exitCode: 1,
          terminationSignal: "SIGKILL",
          terminatedByManager: false,
        };
      }

      async cancel(): Promise<void> {}

      dispose(): void {}
    }

    const runner = new ScriptProcessRunner(
      process.cwd(),
      new SignalledProcessManager()
    );
    const result = await runner.run({
      cwd: process.cwd(),
      timeout: 1000,
      argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"],
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.cancelled, undefined);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.error ?? "", /SIGKILL/);
  });

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

  test("cancel kills a shell command's child process tree promptly", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-runner-cancel-")
    );
    const runner = new ScriptProcessRunner(root);
    const nodeExecutable = process.platform === "win32" ? "node.exe" : "node";
    const invocation = resolveScriptInvocation(
      `${nodeExecutable} -e "setTimeout(() => console.log('natural exit'), 10000)"`
    );

    try {
      const startedAt = Date.now();
      const resultPromise = runner.run({
        cwd: root,
        timeout: 15000,
        argv: invocation.argv,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await runner.cancel();
      const result = await resultPromise;

      assert.ok(Date.now() - startedAt < 4000);
      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(result.exitCode, undefined);
      assert.strictEqual(result.stdout, "");
    } finally {
      runner.dispose();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  });
});
