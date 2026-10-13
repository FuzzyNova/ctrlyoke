import * as assert from "assert";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { createRequire } from "module";
import * as ts from "typescript";
import { EventEmitter } from "events";
import { suite, test } from "mocha";

interface SpawnCall {
  command: string;
  options: Record<string, unknown>;
}

async function loadPlugin(
  hooks: unknown[],
  pluginOptions: { platform?: string; holdHookProcess?: boolean } = {}
): Promise<{
  plugin: Record<string, (...args: any[]) => unknown>;
  spawnCalls: SpawnCall[];
}> {
  const scriptPath = path.resolve(
    __dirname,
    "../../../src/scripts/ctrlyoke-opencode-plugin.ts"
  );
  const source = fs.readFileSync(scriptPath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const spawnCalls: SpawnCall[] = [];
  const hookChildren: EventEmitter[] = [];
  const module = { exports: {} as Record<string, unknown> };
  const actualRequire = createRequire(__filename);
  const mockRequire = (name: string): unknown => {
    if (name === "child_process") {
      return {
        spawn: (
          command: string,
          argsOrOptions: string[] | Record<string, unknown>,
          _spawnOptions?: Record<string, unknown>
        ) => {
          const spawnOptions = Array.isArray(argsOrOptions)
            ? { args: argsOrOptions }
            : argsOrOptions;
          spawnCalls.push({ command, options: spawnOptions });
          const child = new EventEmitter() as EventEmitter & {
            pid: number;
            stdin: EventEmitter & { end: (input: string) => void };
            stdout: EventEmitter & { setEncoding: (encoding: string) => void };
            kill: () => void;
          };
          child.pid = 4321;
          child.stdin = Object.assign(new EventEmitter(), {
            end: (input: string) => {
              (spawnOptions as Record<string, unknown>).input = input;
              // Hooks that never read stdin surface EPIPE here; it must not throw.
              child.stdin.emit("error", new Error("write EPIPE"));
            },
          });
          child.stdout = Object.assign(new EventEmitter(), {
            setEncoding: () => undefined,
          });
          child.kill = () => undefined;
          if (command === "taskkill") {
            queueMicrotask(() => hookChildren[0]?.emit("close", 1));
          } else {
            hookChildren.push(child);
            if (!pluginOptions.holdHookProcess) {
              queueMicrotask(() => child.emit("close", 0));
            }
          }
          return child;
        },
      };
    }
    return actualRequire(name);
  };
  const processStub = {
    env: { CTRLYOKE_OPENCODE_HOOKS: JSON.stringify(hooks) },
    pid: 123,
    platform: pluginOptions.platform ?? process.platform,
    cwd: () => path.resolve("."),
  };
  vm.runInNewContext(compiled, {
    Buffer,
    Date,
    JSON,
    Math,
    String,
    Set,
    process: processStub,
    require: mockRequire,
    exports: module.exports,
    module,
    setTimeout,
    clearTimeout,
  });
  const factory = module.exports.CtrlYokeHook as (
    context: Record<string, unknown>
  ) => Promise<Record<string, (...args: any[]) => unknown>>;
  const plugin = await factory({});
  return { plugin, spawnCalls };
}

suite("OpenCode plugin user hooks", () => {
  test("pipes the documented tool payload to user hooks", async () => {
    const { plugin, spawnCalls } = await loadPlugin([
      { event: "preToolUse", command: "node hook.js", timeoutSec: 3 },
    ]);
    await plugin["tool.execute.before"](
      { tool: "bash", sessionID: "session-1", callID: "call-1" },
      { args: { command: "pwd" } }
    );

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].command, "node hook.js");
    assert.deepStrictEqual(JSON.parse(spawnCalls[0].options.input as string), {
      tool: "bash",
      sessionID: "session-1",
      callID: "call-1",
      hook_event_name: "preToolUse",
      session_id: "session-1",
      tool_name: "bash",
      tool_input: { command: "pwd" },
    });
    assert.strictEqual(spawnCalls[0].options.shell, true);
    assert.deepStrictEqual(
      Array.from(spawnCalls[0].options.stdio as string[]),
      ["pipe", "inherit", "inherit"]
    );
  });

  test("applies timeoutSec to decision hooks too", async () => {
    const { plugin, spawnCalls } = await loadPlugin([
      {
        event: "permissionRequest",
        command: "node decision.js",
        timeoutSec: 2,
      },
    ]);
    await plugin["permission.asked"]({
      sessionID: "session-2",
      permission: "write",
    });

    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(JSON.parse(spawnCalls[0].options.input as string), {
      sessionID: "session-2",
      permission: "write",
      hook_event_name: "permissionRequest",
      session_id: "session-2",
    });
  });

  test("sends payloads for sessionStart, userPromptSubmit, stop, error, and postToolUse", async () => {
    const events = [
      "sessionStart",
      "userPromptSubmit",
      "stop",
      "error",
      "postToolUse",
    ];
    const { plugin, spawnCalls } = await loadPlugin(
      events.map((event) => ({ event, command: `hook-${event}` }))
    );
    await plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id: "session-start" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "session-prompt", status: { type: "busy" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "session-stop", status: { type: "idle" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "session-error", message: "failed" },
      },
    });
    await plugin["tool.execute.after"](
      {
        tool: "bash",
        sessionID: "session-tool",
        callID: "call-1",
        args: { command: "pwd" },
      },
      { title: "pwd", output: "/tmp", metadata: {} }
    );

    assert.deepStrictEqual(
      spawnCalls.map(({ command }) => command),
      events.map((event) => `hook-${event}`)
    );
    const payloads = spawnCalls.map(({ options }) =>
      JSON.parse(options.input as string)
    );
    assert.strictEqual(payloads[0].hook_event_name, "sessionStart");
    assert.strictEqual(payloads[0].session_id, "session-start");
    assert.strictEqual(payloads[1].hook_event_name, "userPromptSubmit");
    assert.strictEqual(payloads[1].session_id, "session-prompt");
    assert.strictEqual(payloads[2].hook_event_name, "stop");
    assert.strictEqual(payloads[2].session_id, "session-stop");
    assert.strictEqual(payloads[3].hook_event_name, "error");
    assert.strictEqual(payloads[3].session_id, "session-error");
    assert.deepStrictEqual(payloads[4], {
      tool: "bash",
      sessionID: "session-tool",
      callID: "call-1",
      args: { command: "pwd" },
      hook_event_name: "postToolUse",
      session_id: "session-tool",
      tool_name: "bash",
      tool_input: { command: "pwd" },
      tool_output: { title: "pwd", output: "/tmp", metadata: {} },
    });
  });

  test("kills the hook process tree when an OpenCode hook times out", async () => {
    const { plugin, spawnCalls } = await loadPlugin(
      [{ event: "preToolUse", command: "slow hook", timeoutSec: 0 }],
      { platform: "win32", holdHookProcess: true }
    );
    await plugin["tool.execute.before"](
      { tool: "bash", sessionID: "session-1", callID: "call-1" },
      { args: { command: "pwd" } }
    );

    assert.strictEqual(spawnCalls[1].command, "taskkill");
    assert.deepStrictEqual(Array.from(spawnCalls[1].options.args as string[]), [
      "/PID",
      "4321",
      "/T",
      "/F",
    ]);
  });

  test("loads hook environment values from the structured env file entry", async () => {
    const tempDirectory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-opencode-hook-env-")
    );
    const envFile = path.join(tempDirectory, "env.json");
    try {
      await fsPromises.writeFile(
        envFile,
        JSON.stringify({ "hook-0": { env: { HOOK_TOKEN: "scoped" } } })
      );
      const { plugin, spawnCalls } = await loadPlugin([
        {
          event: "preToolUse",
          command: "node hook.js",
          envFile,
          envId: "hook-0",
        },
      ]);
      await plugin["tool.execute.before"](
        { tool: "bash", sessionID: "session-1", callID: "call-1" },
        { args: { command: "pwd" } }
      );

      assert.strictEqual(
        (spawnCalls[0].options.env as NodeJS.ProcessEnv).HOOK_TOKEN,
        "scoped"
      );
    } finally {
      await fsPromises.rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
