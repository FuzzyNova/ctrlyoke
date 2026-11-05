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
  pluginOptions: {
    platform?: string;
    holdHookProcess?: boolean;
    notifyDir?: string;
    runId?: string;
    enabledEvents?: string;
    awaitingInputRule?: string;
    /** Load the OpenCode 2 directory entry instead of the V1 factory. */
    v2?: boolean;
  } = {}
): Promise<{
  plugin: Record<string, (...args: any[]) => unknown>;
  spawnCalls: SpawnCall[];
  v2?: V2PluginHarness;
}> {
  const scriptPath = path.resolve(
    __dirname,
    "../../../src/scripts/ctrlyoke-opencode-plugin.ts"
  );
  const compiled = transpile(scriptPath);
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
              queueMicrotask(() => {
                child.emit("close", 0);
              });
            }
          }
          return child;
        },
      };
    }
    return actualRequire(name);
  };
  const processStub = {
    env: {
      CTRLYOKE_OPENCODE_HOOKS: JSON.stringify(hooks),
      ...(pluginOptions.notifyDir
        ? { CTRLYOKE_NOTIFY_DIR: pluginOptions.notifyDir }
        : {}),
      ...(pluginOptions.runId ? { CTRLYOKE_RUN_ID: pluginOptions.runId } : {}),
      ...(pluginOptions.enabledEvents !== undefined
        ? { CTRLYOKE_NOTIFY_HOOK_EVENTS: pluginOptions.enabledEvents }
        : {}),
      ...(pluginOptions.awaitingInputRule
        ? { CTRLYOKE_NOTIFY_AWAITING_INPUT: pluginOptions.awaitingInputRule }
        : {}),
    },
    pid: 123,
    platform: pluginOptions.platform ?? process.platform,
    cwd: () => path.resolve("."),
  };
  const sandboxGlobals = {
    Buffer,
    Date,
    JSON,
    Math,
    String,
    Set,
    Map,
    Array,
    AbortController,
    process: processStub,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(compiled, {
    ...sandboxGlobals,
    require: mockRequire,
    exports: module.exports,
    module,
  });
  const factory = module.exports.CtrlYokeHook as (
    context: Record<string, unknown>
  ) => Promise<Record<string, (...args: any[]) => unknown>>;
  if (pluginOptions.v2) {
    // The OpenCode 2 entry imports the V1 module above and adapts onto it.
    const v2Module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(transpile(V2_PLUGIN_SOURCE), {
      ...sandboxGlobals,
      require: (name: string) =>
        name === "../ctrlyoke-opencode-plugin"
          ? module.exports
          : mockRequire(name),
      exports: v2Module.exports,
      module: v2Module,
    });
    const v2 = await startV2Plugin(
      v2Module.exports.default as V2PluginDefinition
    );
    return { plugin: {}, spawnCalls, v2 };
  }
  const plugin = await factory({});
  return { plugin, spawnCalls };
}

const V2_PLUGIN_SOURCE = path.resolve(
  __dirname,
  "../../../src/scripts/ctrlyoke-opencode-plugin-v2/index.ts"
);

function transpile(scriptPath: string): string {
  return ts.transpileModule(fs.readFileSync(scriptPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

interface V2PluginDefinition {
  id: string;
  setup(ctx: unknown): Promise<() => void>;
}

type V2ToolHook = (event: Record<string, unknown>) => unknown;

/** A started OpenCode 2 plugin driven through a fake plugin context. */
interface V2PluginHarness {
  id: string;
  /** Deliver one OpenCode 2 event and wait for the plugin to handle it. */
  publish(type: string, data: Record<string, unknown>): Promise<void>;
  toolHooks: Map<string, V2ToolHook>;
  dispose(): void;
}

async function startV2Plugin(
  definition: V2PluginDefinition
): Promise<V2PluginHarness> {
  const queue: Array<{ type: string; data: Record<string, unknown> }> = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const toolHooks = new Map<string, V2ToolHook>();
  const ctx = {
    event: {
      subscribe(options: { signal: AbortSignal }) {
        signal = options.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              const next = queue.shift();
              if (next) {
                yield next;
                continue;
              }
              await new Promise<void>((resolve) => (wake = resolve));
            }
          },
        };
      },
    },
    tool: {
      async hook(name: string, callback: V2ToolHook) {
        toolHooks.set(name, callback);
      },
    },
  };
  const dispose = await definition.setup(ctx);
  return {
    id: definition.id,
    toolHooks,
    async publish(type, data) {
      queue.push({ type, data });
      wake?.();
      // Let the subscription loop and the handlers' file writes run.
      for (let i = 0; i < 20 && queue.length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    dispose: () => {
      dispose();
      wake?.();
    },
  };
}

suite("OpenCode plugin user hooks", () => {
  test("writes child parts and task spawn links to the per-run sidecar", async () => {
    const notifyDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "opencode-sidecar-")
    );
    try {
      const { plugin } = await loadPlugin([], { notifyDir, runId: "run-1" });
      await plugin.event({
        event: {
          type: "session.created",
          properties: { info: { id: "child-1", parentID: "parent" } },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              sessionID: "parent",
              callID: "call-1",
              tool: "task",
              state: { status: "running", metadata: { sessionId: "child-1" } },
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              sessionID: "child-1",
              id: "part-1",
              text: "child output",
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "session.status",
          properties: { sessionID: "child-1", status: { type: "idle" } },
        },
      });
      const lines = (
        await fsPromises.readFile(
          path.join(notifyDir, "run-1-subagents.jsonl"),
          "utf8"
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.strictEqual(lines.length, 3);
      assert.strictEqual(lines[0].kind, "task-running");
      assert.strictEqual(lines[0].childSessionId, "child-1");
      assert.strictEqual(lines[0].part.callID, "call-1");
      assert.strictEqual(lines[1].kind, "part");
      assert.strictEqual(lines[1].part.text, "child output");
      assert.deepStrictEqual(lines[2], {
        kind: "child-idle",
        childSessionId: "child-1",
      });
    } finally {
      await fsPromises.rm(notifyDir, { recursive: true, force: true });
    }
  });
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

  test("runs permissionRequest when permission.asked reaches the event handler", async () => {
    const { plugin, spawnCalls } = await loadPlugin([
      {
        event: "permissionRequest",
        command: "node permission.js",
        timeoutSec: 2,
      },
    ]);
    await plugin.event({
      event: {
        type: "permission.asked",
        properties: {
          sessionID: "session-2",
          type: "edit",
          title: "write a file",
          id: "permission-1",
        },
      },
    });

    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(JSON.parse(spawnCalls[0].options.input as string), {
      sessionID: "session-2",
      type: "edit",
      title: "write a file",
      id: "permission-1",
      hook_event_name: "permissionRequest",
      session_id: "session-2",
      tool_name: "edit",
    });
    assert.deepStrictEqual(
      Array.from(spawnCalls[0].options.stdio as string[]),
      ["pipe", "inherit", "inherit"]
    );
  });

  test("deduplicates permission.asked into awaitingInput when its rule matches", async () => {
    for (const [index, enabledEvents] of ["", "permissionRequest"].entries()) {
      const notifyDir = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), "opencode-awaiting-input-")
      );
      try {
        const runId = `run-opencode-awaiting-input-${index}`;
        const { plugin } = await loadPlugin([], {
          notifyDir,
          runId,
          enabledEvents,
          awaitingInputRule: "permissionRequest",
        });
        await plugin.event({
          event: {
            type: "permission.asked",
            properties: {
              sessionID: "session-awaiting-input",
              type: "edit",
              title: "write a file",
              id: "permission-awaiting-input",
            },
          },
        });

        const files = (await fsPromises.readdir(notifyDir)).filter((file) =>
          file.endsWith(".json")
        );
        assert.strictEqual(files.length, 1);
        const artifact = JSON.parse(
          await fsPromises.readFile(path.join(notifyDir, files[0]), "utf8")
        ) as Record<string, unknown>;
        assert.strictEqual(artifact.hookEvent, "awaitingInput");
        assert.strictEqual(artifact.nativeHookEvent, "permission.asked");
        assert.strictEqual(artifact.toolName, "edit");
        assert.deepStrictEqual(artifact.rawHookData, {
          sessionID: "session-awaiting-input",
          type: "edit",
          title: "write a file",
          id: "permission-awaiting-input",
        });
      } finally {
        await fsPromises.rm(notifyDir, { recursive: true, force: true });
      }
    }
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

suite("OpenCode 2 plugin entry", () => {
  async function withNotifyDir(
    run: (notifyDir: string) => Promise<void>
  ): Promise<void> {
    const notifyDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "opencode-v2-plugin-")
    );
    try {
      await run(notifyDir);
    } finally {
      await fsPromises.rm(notifyDir, { recursive: true, force: true });
    }
  }

  test("default-exports an OpenCode 2 definition with an id and setup", async () => {
    const { v2 } = await loadPlugin([], { v2: true });
    assert.strictEqual(v2!.id, "ctrlyoke");
    assert.deepStrictEqual([...v2!.toolHooks.keys()].sort(), [
      "execute.after",
      "execute.before",
    ]);
    v2!.dispose();
  });

  test("writes the start file and exactly one stop per main-session execution", async () => {
    await withNotifyDir(async (notifyDir) => {
      const { v2 } = await loadPlugin([], {
        v2: true,
        notifyDir,
        runId: "run-1",
      });
      // OpenCode 2 publishes the main session.created before plugins subscribe.
      await v2!.publish("session.execution.started", { sessionID: "main" });
      await v2!.publish("session.execution.succeeded", { sessionID: "main" });
      await v2!.publish("session.execution.interrupted", { sessionID: "main" });

      const start = JSON.parse(
        await fsPromises.readFile(
          path.join(notifyDir, "run-1-start.json"),
          "utf8"
        )
      );
      assert.strictEqual(start.sessionId, "main");
      const stop = JSON.parse(
        await fsPromises.readFile(
          path.join(notifyDir, "main-stop.json"),
          "utf8"
        )
      );
      assert.strictEqual(stop.status, "completed");
      assert.strictEqual(stop.runId, "run-1");
      v2!.dispose();
    });
  });

  test("routes subagent child sessions to the sidecar instead of stopping", async () => {
    await withNotifyDir(async (notifyDir) => {
      const { v2 } = await loadPlugin([], {
        v2: true,
        notifyDir,
        runId: "run-1",
      });
      await v2!.publish("session.execution.started", { sessionID: "main" });
      await v2!.publish("session.tool.input.started", {
        sessionID: "main",
        assistantMessageID: "msg-1",
        id: "call-1",
        name: "subagent",
      });
      await v2!.publish("session.tool.called", {
        sessionID: "main",
        assistantMessageID: "msg-1",
        id: "call-1",
        input: { agent: "general", description: "Read", prompt: "Read a.txt" },
      });
      await v2!.publish("session.created", {
        sessionID: "child-1",
        parentID: "main",
      });
      await v2!.publish("session.tool.progress", {
        sessionID: "main",
        assistantMessageID: "msg-1",
        id: "call-1",
        metadata: { sessionID: "child-1", status: "running" },
      });
      await v2!.publish("session.execution.started", { sessionID: "child-1" });
      await v2!.publish("session.text.ended", {
        sessionID: "child-1",
        assistantMessageID: "msg-c1",
        ordinal: 0,
        text: "child output",
      });
      await v2!.publish("session.execution.succeeded", {
        sessionID: "child-1",
      });

      const lines = (
        await fsPromises.readFile(
          path.join(notifyDir, "run-1-subagents.jsonl"),
          "utf8"
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepStrictEqual(
        lines.map((line) => line.kind),
        ["task-running", "part", "child-idle"]
      );
      assert.strictEqual(lines[0].childSessionId, "child-1");
      assert.strictEqual(lines[0].part.callID, "call-1");
      assert.strictEqual(lines[0].part.tool, "subagent");
      assert.strictEqual(lines[1].part.text, "child output");
      assert.strictEqual(
        fs.existsSync(path.join(notifyDir, "child-1-stop.json")),
        false
      );
      v2!.dispose();
    });
  });

  test("fails the step through the error file when an execution fails", async () => {
    await withNotifyDir(async (notifyDir) => {
      const { v2 } = await loadPlugin([], {
        v2: true,
        notifyDir,
        runId: "run-1",
      });
      await v2!.publish("session.execution.started", { sessionID: "main" });
      await v2!.publish("session.execution.failed", {
        sessionID: "main",
        error: { type: "provider", message: "quota exceeded" },
      });
      const error = JSON.parse(
        await fsPromises.readFile(
          path.join(notifyDir, "main-error.json"),
          "utf8"
        )
      );
      assert.strictEqual(error.status, "error");
      assert.strictEqual(error.rawHookData.error.message, "quota exceeded");
      v2!.dispose();
    });
  });

  test("passes OpenCode 2 tool hook events to user hooks in the documented shape", async () => {
    const { v2, spawnCalls } = await loadPlugin(
      [
        { event: "preToolUse", command: "node pre.js" },
        { event: "postToolUse", command: "node post.js" },
      ],
      { v2: true }
    );
    await v2!.toolHooks.get("execute.before")!({
      tool: "shell",
      sessionID: "main",
      id: "call-1",
      input: { command: "pwd" },
    });
    await v2!.toolHooks.get("execute.after")!({
      tool: "shell",
      sessionID: "main",
      id: "call-1",
      input: { command: "pwd" },
      status: "completed",
      result: {
        content: [{ type: "text", text: "/repo\n" }],
        metadata: { exit: 0 },
      },
    });
    const before = JSON.parse(spawnCalls[0].options.input as string);
    assert.strictEqual(before.hook_event_name, "preToolUse");
    assert.strictEqual(before.tool_name, "shell");
    assert.strictEqual(before.session_id, "main");
    assert.deepStrictEqual(before.tool_input, { command: "pwd" });
    const after = JSON.parse(spawnCalls[1].options.input as string);
    assert.strictEqual(after.hook_event_name, "postToolUse");
    assert.strictEqual(after.tool_output.output, "/repo\n");
    v2!.dispose();
  });
});
