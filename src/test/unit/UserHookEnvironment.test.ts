import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { EventEmitter } from "events";
import { spawn, spawnSync, type SpawnSyncReturns } from "child_process";
import { suite, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { prepareUserHookEnvironments } from "../../core/harness/shared/UserHookEnvironment";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CliExecutionSession } from "../../core/harness/shared/CliExecutionSession";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";

const extensionPath = path.resolve(__dirname, "../../..");
const launcherPath = path.resolve(
  __dirname,
  "../../scripts/ctrlyoke-hook-run.js"
);

suite("UserHookEnvironment", () => {
  test("plans per-user env files and wires them to the session outside the workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-env-workspace-")
    );
    try {
      const properties = {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "model-x",
        executionMode: "interactive" as const,
        resumeSession: false,
        mcpServers: null,
        hooks: [
          {
            event: "stop" as const,
            command: "node stop.js",
            env: { TOKEN: "value" },
          },
        ],
        toolPermissions: null,
      };
      const session = new CliExecutionSession({
        prompt: { prompt: "prompt" },
        resolvedProperties: properties,
        workflowContext: {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: properties,
        },
      });
      const plan = await new ExecutionPlanBuilder({
        provider: new ClaudeCliProvider(),
        getWorkspaceRoot: () => workspaceRoot,
        getWorkspaceRoots: () => [workspaceRoot],
        getExtensionPath: () => extensionPath,
        getExecutionMode: () => "interactive",
        getEnabledHookNotificationEvents: () => [],
        resolveCliCommand: async (command, args) => ({
          command,
          args,
          displayCommand: command,
          launcherKind: "direct",
        }),
      }).plan(session);
      assert.strictEqual(plan.deferredHookEnvironmentFilePaths.length, 1);
      const [envFilePath] = plan.deferredHookEnvironmentFilePaths;
      assert.ok(!envFilePath.startsWith(workspaceRoot));
      for (const filePath of plan.deferredHookEnvironmentFilePaths) {
        session.addDeferredHookEnvironmentFilePath(filePath);
      }
      assert.deepStrictEqual(session.deferredHookEnvironmentFilePaths, [
        envFilePath,
      ]);
      assert.deepStrictEqual(session.tempFilePaths, []);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("writes isolated per-hook values and registers the file for cleanup", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-env-")
    );
    try {
      const printTokenCommand =
        'node -e "process.stdout.write(process.env.TOKEN)"';
      const prepared = prepareUserHookEnvironments({
        harnessId: HARNESS_IDS.CODEX_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 3,
        hooks: [
          {
            event: "stop",
            command: printTokenCommand,
            env: { TOKEN: "first" },
            timeoutSec: 9,
          },
          {
            event: "stop",
            command: printTokenCommand,
            env: { TOKEN: "second" },
          },
        ],
      });
      assert.ok(prepared.tempFilePath);
      assert.ok(prepared.mutation);
      await prepared.mutation.apply();

      const envByHookId = JSON.parse(
        await fs.readFile(prepared.tempFilePath!, "utf8")
      ) as Record<string, { env: Record<string, string>; timeoutSec?: number }>;
      assert.strictEqual(envByHookId["hook-0"].env.TOKEN, "first");
      assert.strictEqual(envByHookId["hook-1"].env.TOKEN, "second");
      assert.strictEqual(envByHookId["hook-0"].timeoutSec, 9);
      assert.strictEqual(prepared.hooks?.[0].env, undefined);
      assert.strictEqual(prepared.hooks?.[1].env, undefined);

      const launcher = prepared.hooks?.[0].command ?? "";
      assert.ok(launcher.includes("ctrlyoke-hook-run.js"));
      assert.ok(launcher.includes("hook-0"));
      for (const [hookId, expectedToken] of [
        ["hook-0", "first"],
        ["hook-1", "second"],
      ]) {
        const command = prepared.hooks?.[Number(hookId.slice(-1))].command;
        assert.ok(command);
        for (const result of runThroughHarnessShell(command)) {
          assert.strictEqual(result.status, 0, result.stderr);
          assert.strictEqual(result.stdout, expectedToken);
        }
      }

      await fs.rm(prepared.tempFilePath!, { force: true });
      await assert.rejects(fs.access(prepared.tempFilePath!));
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("uses unquoted commands for Qwen and Antigravity", () => {
    for (const harnessId of [
      HARNESS_IDS.QWEN_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
    ]) {
      const prepared = prepareUserHookEnvironments({
        harnessId,
        extensionPath,
        hookTempDirectory: os.tmpdir(),
        promptIndex: 0,
        hooks: [
          { event: "stop", command: "echo hook", env: { TOKEN: "value" } },
        ],
      });
      const command = prepared.hooks?.[0].command ?? "";
      assert.ok(command.includes("ctrlyoke-hook-run.js"));
      assert.ok(
        !/[\"']/.test(command),
        `${harnessId} command should be unquoted`
      );
    }
  });

  test("uses a stable run-scoped environment file when requested", () => {
    const hooks = [
      { event: "stop" as const, command: "echo hook", env: { TOKEN: "value" } },
    ];
    const first = prepareUserHookEnvironments({
      harnessId: HARNESS_IDS.QWEN_CLI,
      extensionPath,
      hookTempDirectory: os.tmpdir(),
      promptIndex: 0,
      stableFileStem: "workflow-run-123",
      hooks,
    });
    const nextStep = prepareUserHookEnvironments({
      harnessId: HARNESS_IDS.QWEN_CLI,
      extensionPath,
      hookTempDirectory: os.tmpdir(),
      promptIndex: 1,
      stableFileStem: "workflow-run-123",
      hooks,
    });
    const concurrentRun = prepareUserHookEnvironments({
      harnessId: HARNESS_IDS.QWEN_CLI,
      extensionPath,
      hookTempDirectory: os.tmpdir(),
      promptIndex: 0,
      stableFileStem: "workflow-run-456",
      hooks,
    });

    assert.strictEqual(first.tempFilePath, nextStep.tempFilePath);
    assert.notStrictEqual(first.tempFilePath, concurrentRun.tempFilePath);
    assert.strictEqual(
      first.hooks?.[0].command,
      nextStep.hooks?.[0].command
    );
  });

  test("launcher passes stdin and stdout through and returns the command exit code", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-launcher-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    try {
      await fs.writeFile(
        envFile,
        JSON.stringify({
          "hook-0": { env: { HOOK_TOKEN: "first" } },
          "hook-1": { env: { HOOK_TOKEN: "second" } },
        })
      );
      const command =
        "node -e \"process.stdin.pipe(process.stdout); process.exitCode = process.env.HOOK_TOKEN === 'first' ? 7 : 8\"";
      const result = spawnSync(
        process.execPath,
        [
          launcherPath,
          envFile,
          "hook-0",
          "default",
          Buffer.from(command, "utf8").toString("base64"),
        ],
        { input: "permission payload", encoding: "utf8" }
      );
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.stdout, "permission payload");
      assert.strictEqual(result.status, 7);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("runs a PowerShell-syntax command under PowerShell on Windows", async function () {
    if (process.platform !== "win32") return;
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-powershell-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    try {
      await fs.writeFile(
        envFile,
        JSON.stringify({ "hook-0": { env: { HOOK_TOKEN: "value" } } })
      );
      const command = "Write-Output $env:HOOK_TOKEN";
      const result = spawnSync(
        process.execPath,
        [
          launcherPath,
          envFile,
          "hook-0",
          "powershell.exe",
          Buffer.from(command, "utf8").toString("base64"),
        ],
        { encoding: "utf8" }
      );
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), "value");
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("kills a launched hook's child process tree when the launcher is terminated", async function () {
    if (process.platform === "win32") return;
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-kill-tree-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    const childPidPath = path.join(tempDirectory, "child.pid");
    await fs.writeFile(envFile, JSON.stringify({ "hook-0": { env: {} } }));
    const command = `node -e "require('fs').writeFileSync(process.env.HOOK_CHILD_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)"`;
    const launcher = spawn(
      process.execPath,
      [
        launcherPath,
        envFile,
        "hook-0",
        "default",
        Buffer.from(command, "utf8").toString("base64"),
      ],
      {
        env: { ...process.env, HOOK_CHILD_PID_FILE: childPidPath },
        stdio: "ignore",
      }
    );
    try {
      const childPid = await waitForChildPid(childPidPath);
      const launcherExit = new Promise<void>((resolve, reject) => {
        launcher.once("exit", () => resolve());
        launcher.once("error", reject);
      });
      launcher.kill("SIGTERM");
      await launcherExit;
      await waitForProcessExit(childPid);
      assert.strictEqual(isProcessRunning(childPid), false);
    } finally {
      launcher.kill("SIGKILL");
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("uses taskkill for the launcher child tree on Windows", function () {
    if (process.platform !== "win32") return;
    const handlers = new Map<string, () => void>();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: () => void;
    };
    child.pid = 4321;
    child.kill = () => undefined;
    const processStub = {
      argv: ["node", launcherPath, "env.json", "hook-0", "default", "YQ=="],
      platform: "win32",
      env: {},
      pid: 123,
      ppid: 1,
      exitCode: undefined as number | undefined,
      cwd: () => os.tmpdir(),
      kill: () => undefined,
      on: (signal: string, handler: () => void) =>
        handlers.set(signal, handler),
      removeListener: () => undefined,
    };
    vm.runInNewContext(fsSync.readFileSync(launcherPath, "utf8"), {
      Buffer,
      setTimeout: () => ({ unref: () => undefined }),
      clearTimeout: () => undefined,
      setInterval: () => ({ unref: () => undefined }),
      clearInterval: () => undefined,
      process: processStub,
      require: (name: string) => {
        if (name === "node:fs") {
          return {
            readFileSync: () => JSON.stringify({ "hook-0": { env: {} } }),
          };
        }
        if (name === "node:child_process") {
          return {
            spawn: (command: string, args: string[]) => {
              spawnCalls.push({ command, args });
              return command === "taskkill" ? new EventEmitter() : child;
            },
          };
        }
        throw new Error(`Unexpected module ${name}`);
      },
    });
    handlers.get("SIGINT")?.();

    assert.strictEqual(spawnCalls[1].command, "taskkill");
    assert.deepStrictEqual(Array.from(spawnCalls[1].args), [
      "/PID",
      "4321",
      "/T",
      "/F",
    ]);
  });

  test("kills a hook tree when the wrapping cmd.exe parent is terminated", async function () {
    if (process.platform !== "win32") return;
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-parent-kill-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    const childPidPath = path.join(tempDirectory, "child.pid");
    await fs.writeFile(envFile, JSON.stringify({ "hook-0": { env: {} } }));
    const encodedCommand = Buffer.from(
      `node -e "require('fs').writeFileSync(process.env.HOOK_CHILD_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)"`,
      "utf8"
    ).toString("base64");
    const command = `node "${launcherPath}" "${envFile}" hook-0 default ${encodedCommand}`;
    const parent = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        env: { ...process.env, HOOK_CHILD_PID_FILE: childPidPath },
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }
    );
    let childPid: number | undefined;
    try {
      childPid = await waitForChildPid(childPidPath);
      const parentExit = new Promise<void>((resolve, reject) => {
        parent.once("exit", () => resolve());
        parent.once("error", reject);
      });
      parent.kill();
      await parentExit;
      await waitForProcessExit(childPid);
      assert.strictEqual(isProcessRunning(childPid), false);
    } finally {
      parent.kill();
      if (childPid !== undefined) terminateProcessTree(childPid);
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("kills a hook process tree at its configured timeout", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-hook-timeout-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    const childPidPath = path.join(tempDirectory, "child.pid");
    await fs.writeFile(
      envFile,
      JSON.stringify({ "hook-0": { env: {}, timeoutSec: 1 } })
    );
    const command = `node -e "require('fs').writeFileSync(process.env.HOOK_CHILD_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)"`;
    const launcher = spawn(
      process.execPath,
      [
        launcherPath,
        envFile,
        "hook-0",
        "default",
        Buffer.from(command, "utf8").toString("base64"),
      ],
      {
        env: { ...process.env, HOOK_CHILD_PID_FILE: childPidPath },
        stdio: "ignore",
      }
    );
    let childPid: number | undefined;
    try {
      childPid = await waitForChildPid(childPidPath);
      await new Promise<void>((resolve, reject) => {
        launcher.once("close", (code) => {
          if (code === 0)
            reject(new Error("Timed-out hook exited successfully"));
          else resolve();
        });
        launcher.once("error", reject);
      });
      await waitForProcessExit(childPid);
      assert.strictEqual(isProcessRunning(childPid), false);
    } finally {
      launcher.kill();
      if (childPid !== undefined) terminateProcessTree(childPid);
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

async function waitForChildPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return Number(await fs.readFile(filePath, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Hook child did not write its PID");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may have exited before cleanup.
      }
    }
  }
}

function runThroughHarnessShell(command: string): SpawnSyncReturns<string>[] {
  if (process.platform === "win32") {
    const cmdResult = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", command],
      { encoding: "utf8", windowsVerbatimArguments: true }
    );
    assert.strictEqual(cmdResult.error, undefined, "cmd.exe must be available");
    const powershellResult = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8" }
    );
    assert.strictEqual(
      powershellResult.error,
      undefined,
      "Windows PowerShell must be available"
    );
    return [cmdResult, powershellResult];
  }
  return [spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" })];
}
