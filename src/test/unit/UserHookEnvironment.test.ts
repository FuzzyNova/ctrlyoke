import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { EventEmitter } from "events";
import { spawn, spawnSync, type SpawnSyncReturns } from "child_process";
import { afterEach, beforeEach, suite, test } from "mocha";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { UserHookConfig } from "../../types/CtrlYokeTypes";
import { prepareUserHookLaunchers } from "../../core/harness/shared/UserHookEnvironment";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CliExecutionSession } from "../../core/harness/shared/CliExecutionSession";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";

const extensionPath = path.resolve(__dirname, "../../..");
const launcherPath = path.resolve(
  __dirname,
  "../../scripts/ctrlyoke-hook-run.js"
);

suite("UserHookEnvironment", () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let originalEnvironment: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnvironment)) delete process.env[name];
    }
    Object.assign(process.env, originalEnvironment);
  });

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
        getInstallHookNotificationEvents: () => [],
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
      const prepared = prepareUserHookLaunchers({
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
      const prepared = prepareUserHookLaunchers({
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

  test("routes quoted Qwen hook commands through the launcher on Windows", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-qwen-quoted-hook-")
    );
    const markerPath = path.join(tempDirectory, "marker.txt");
    const scriptPath = path.join(tempDirectory, "hook.js");
    await fs.writeFile(
      scriptPath,
      "require('fs').writeFileSync(process.argv[2], 'ran');"
    );
    const quotedCommand = `node "${scriptPath}" "${markerPath}"`;
    const unquotedCommand = "echo hook";
    try {
      process.env.MSYSTEM = "";
      process.env.TERM = "";
      process.env.ComSpec = "cmd.exe";
      const prepared = prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 0,
        hooks: [
          { event: "stop", command: quotedCommand },
          { event: "sessionStart", command: unquotedCommand },
        ],
      });
      if (process.platform !== "win32") {
        // Qwen runs hooks through `bash -c` here, which handles quotes.
        assert.strictEqual(prepared.tempFilePath, undefined);
        assert.strictEqual(prepared.hooks?.[0].command, quotedCommand);
        return;
      }

      const wrapped = prepared.hooks?.[0].command ?? "";
      assert.ok(wrapped.includes("ctrlyoke-hook-run.js"));
      assert.ok(!wrapped.includes('"'), "the launcher command is unquoted");
      assert.strictEqual(prepared.hooks?.[1].command, unquotedCommand);
      await prepared.mutation!.apply();
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(prepared.tempFilePath!, "utf8")),
        { "hook-0": { env: {} } }
      );

      // Launch both the way Qwen Code does on Windows: cmd.exe with
      // shell: false, so Node escapes every quote in the command to \".
      const runLikeQwen = (command: string) =>
        spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", command],
          {
            encoding: "utf8",
            shell: false,
          }
        );
      runLikeQwen(quotedCommand);
      assert.ok(
        !fsSync.existsSync(markerPath),
        "the raw quoted command should fail under Qwen's launch"
      );
      const result = runLikeQwen(wrapped);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(await fs.readFile(markerPath, "utf8"), "ran");
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("uses Qwen's Windows shell choice for quoted and env-bearing hooks", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    const prepare = (env: NodeJS.ProcessEnv, hooks: UserHookConfig[]) => {
      for (const name of ["MSYSTEM", "TERM", "ComSpec"]) {
        delete process.env[name];
      }
      Object.assign(process.env, env);
      return prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: os.tmpdir(),
        promptIndex: 0,
        hooks,
      });
    };
    const quotedHook = { event: "stop" as const, command: 'echo "quoted"' };
    const envHook = {
      event: "stop" as const,
      command: "echo hook",
      env: { TOKEN: "value" },
    };

    const gitBash = prepare({ MSYSTEM: "MINGW64" }, [quotedHook]);
    assert.strictEqual(gitBash.tempFilePath, undefined);
    assert.strictEqual(gitBash.hooks?.[0].command, quotedHook.command);

    const gitBashEnvHook = prepare({ MSYSTEM: "MINGW64" }, [envHook]);
    assert.ok(gitBashEnvHook.hooks?.[0].command?.includes("hook-0 bash "));

    const msysTerm = prepare({ TERM: "xterm-msys" }, [quotedHook]);
    assert.strictEqual(msysTerm.tempFilePath, undefined);
    assert.strictEqual(msysTerm.hooks?.[0].command, quotedHook.command);

    const cmd = prepare({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, [
      quotedHook,
    ]);
    assert.ok(cmd.hooks?.[0].command?.includes("ctrlyoke-hook-run.js"));
    assert.ok(cmd.hooks?.[0].command?.includes("hook-0 default "));

    const powershell = prepare(
      {
        ComSpec:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      [quotedHook, envHook]
    );
    assert.strictEqual(powershell.hooks?.[0].command, quotedHook.command);
    const powershellEnvHook = prepare(
      {
        ComSpec:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      [envHook]
    );
    assert.ok(
      powershellEnvHook.hooks?.[0].command?.includes("hook-0 powershell.exe ")
    );
  });

  test("isolates concurrent Qwen step env files and reuses each step path", async () => {
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-qwen-step-env-")
    );
    const hooksFor = (token: string) => [
      { event: "stop" as const, command: "echo hook", env: { TOKEN: token } },
    ];
    try {
      const first = prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 0,
        stableFileStem: "workflow-run-123-step-0",
        hooks: hooksFor("first"),
      });
      const nextStep = prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 1,
        stableFileStem: "workflow-run-123-step-1",
        hooks: hooksFor("second"),
      });
      const rerunFirstStep = prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 0,
        stableFileStem: "workflow-run-123-step-0",
        hooks: hooksFor("first"),
      });
      const concurrentRun = prepareUserHookLaunchers({
        harnessId: HARNESS_IDS.QWEN_CLI,
        extensionPath,
        hookTempDirectory: tempDirectory,
        promptIndex: 0,
        stableFileStem: "workflow-run-456-step-0",
        hooks: hooksFor("other run"),
      });

      assert.notStrictEqual(first.tempFilePath, nextStep.tempFilePath);
      assert.strictEqual(first.tempFilePath, rerunFirstStep.tempFilePath);
      assert.notStrictEqual(first.tempFilePath, concurrentRun.tempFilePath);
      await first.mutation!.apply();
      await nextStep.mutation!.apply();
      await fs.rm(first.tempFilePath!, { force: true });
      await assert.rejects(fs.access(first.tempFilePath!));
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(nextStep.tempFilePath!, "utf8")),
        { "hook-0": { env: { TOKEN: "second" } } }
      );
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
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
    // Long enough for the shell and child node to start while all test suites
    // run concurrently; at 1 s the tree was killed before the child wrote its PID.
    await fs.writeFile(
      envFile,
      JSON.stringify({ "hook-0": { env: {}, timeoutSec: 5 } })
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
