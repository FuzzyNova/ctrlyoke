import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { createRequire } from "module";
import * as ts from "typescript";
import { suite, test } from "mocha";

interface SpawnCall {
  command: string;
  options: Record<string, unknown>;
}

async function loadPlugin(hooks: unknown[]): Promise<{
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
  const module = { exports: {} as Record<string, unknown> };
  const actualRequire = createRequire(__filename);
  const mockRequire = (name: string): unknown => {
    if (name === "child_process") {
      return {
        spawnSync: (command: string, options: Record<string, unknown>) => {
          spawnCalls.push({ command, options });
          return { status: 0, stdout: "", stderr: "" };
        },
      };
    }
    return actualRequire(name);
  };
  const processStub = {
    env: { CTRLYOKE_OPENCODE_HOOKS: JSON.stringify(hooks) },
    pid: 123,
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
    assert.strictEqual(spawnCalls[0].options.timeout, 3000);
    assert.deepStrictEqual(Array.from(spawnCalls[0].options.stdio as string[]), [
      "pipe",
      "inherit",
      "inherit",
    ]);
  });

  test("applies timeoutSec to decision hooks too", async () => {
    const { plugin, spawnCalls } = await loadPlugin([
      { event: "permissionRequest", command: "node decision.js", timeoutSec: 2 },
    ]);
    await plugin["permission.asked"]({ sessionID: "session-2", permission: "write" });

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].options.timeout, 2000);
    assert.deepStrictEqual(JSON.parse(spawnCalls[0].options.input as string), {
      sessionID: "session-2",
      permission: "write",
      hook_event_name: "permissionRequest",
      session_id: "session-2",
    });
  });
});
