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
    assert.strictEqual(result.exitCode, undefined);
    assert.strictEqual(result.errored, true);
    assert.strictEqual(result.signal, "SIGKILL");
    assert.match(result.error ?? "", /SIGKILL/);
  });

  test("classifies shell 127 as a command lookup error", async () => {
    class MissingCommandManager implements Pick<
      CliProcessManager,
      "spawn" | "cancel" | "dispose"
    > {
      async spawn(): Promise<SpawnResult> {
        return {
          stdout: "",
          stderr: "sh: 1: missing-tool: not found",
          exitCode: 127,
          terminatedByManager: false,
        };
      }
      async cancel(): Promise<void> {}
      dispose(): void {}
    }
    const runner = new ScriptProcessRunner(
      process.cwd(),
      new MissingCommandManager()
    );
    const result = await runner.run({
      cwd: process.cwd(),
      timeout: 1000,
      argv: ["sh", "-c", "missing-tool"],
      viaShell: true,
    });
    assert.strictEqual(result.errored, true);
    assert.match(result.error ?? "", /command not found: sh: 1: missing-tool/u);
  });

  test("classifies shell 126 as a command execution error", async () => {
    class PermissionDeniedManager implements Pick<
      CliProcessManager,
      "spawn" | "cancel" | "dispose"
    > {
      async spawn(): Promise<SpawnResult> {
        return {
          stdout: "",
          stderr: "permission denied",
          exitCode: 126,
          terminatedByManager: false,
        };
      }
      async cancel(): Promise<void> {}
      dispose(): void {}
    }
    const runner = new ScriptProcessRunner(
      process.cwd(),
      new PermissionDeniedManager()
    );
    const result = await runner.run({
      cwd: process.cwd(),
      timeout: 1000,
      argv: ["sh", "-c", "blocked"],
      viaShell: true,
    });
    assert.strictEqual(result.errored, true);
    assert.match(
      result.error ?? "",
      /command could not execute: permission denied/u
    );
  });

  test("keeps stderr separate from process errors", async () => {
    const runner = new ScriptProcessRunner(process.cwd());
    const nodeExecutable = process.platform === "win32" ? "node.exe" : "node";
    const result = await runner.run({
      cwd: process.cwd(),
      timeout: 1000,
      argv: [nodeExecutable, "-e", "console.error('warning')"],
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stderr, "warning");
    assert.strictEqual(result.error, undefined);
    runner.dispose();
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
            "process.stdout.write('partial'); setTimeout(() => process.stdout.write('slow'), 2000)",
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
      assert.strictEqual(timedOut.stdout, "partial");
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
