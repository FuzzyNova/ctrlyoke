import * as assert from "assert";
import { Command } from "commander";
import {
  registerRunCommand,
  registerRunScopedCommands,
  type AppendOptions,
  type ContinueOptions,
  type RerunOptions,
  type RunCommandOptions,
} from "../../cli/CliRunCommandDefinitions";

function createProgram(calls: {
  rerun?: RerunOptions;
  append?: { file: string | undefined; options: AppendOptions };
  continue?: ContinueOptions;
}): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerRunScopedCommands(program, {
    rerun: async (options) => {
      calls.rerun = options;
    },
    append: async (file, options) => {
      calls.append = { file, options };
    },
    continue: async (options) => {
      calls.continue = options;
    },
  });
  return program;
}

function createRunProgram(calls: {
  run?: { file: string | undefined; options: RunCommandOptions };
}): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerRunCommand(program, async (file, options) => {
    calls.run = { file, options };
  });
  return program;
}

suite("CLI run-scoped command parser", () => {
  test("parses rerun selectors and keeps harness/model overrides scoped to rerun", async () => {
    const calls: { rerun?: RerunOptions } = {};
    await createProgram(calls).parseAsync(
      [
        "rerun",
        "--workflow",
        "release",
        "--from",
        "9",
        "--harness",
        "codex-cli",
        "--model",
        "gpt-5",
      ],
      { from: "user" }
    );

    assert.deepStrictEqual(calls.rerun?.workflow, "release");
    assert.strictEqual(calls.rerun?.from, "9");
    assert.strictEqual(calls.rerun?.harness, "codex-cli");
    assert.strictEqual(calls.rerun?.model, "gpt-5");
  });

  test("parses append and continue only with explicit run targets", async () => {
    const appendCalls: {
      append?: { file: string | undefined; options: AppendOptions };
    } = {};
    await createProgram(appendCalls).parseAsync(
      ["append", "tail.ctrlyoke.json", "--workflow", "release", "--run", "7"],
      { from: "user" }
    );
    assert.strictEqual(appendCalls.append?.file, "tail.ctrlyoke.json");
    assert.strictEqual(appendCalls.append?.options.run, "7");

    const continueCalls: { continue?: ContinueOptions } = {};
    await createProgram(continueCalls).parseAsync(
      [
        "continue",
        "--workflow",
        "release",
        "--run",
        "run-2026-07-20T10-30-00-000Z",
      ],
      { from: "user" }
    );
    assert.strictEqual(
      continueCalls.continue?.run,
      "run-2026-07-20T10-30-00-000Z"
    );
  });

  test("rejects missing targets and fresh harness/model overrides for continuation commands", async () => {
    await assert.rejects(
      createProgram({}).parseAsync(
        ["append", "--workflow", "release", "--prompt", "tail"],
        { from: "user" }
      ),
      /required option '--run <ref\|runId>' not specified/
    );
    await assert.rejects(
      createProgram({}).parseAsync(
        [
          "continue",
          "--workflow",
          "release",
          "--run",
          "7",
          "--harness",
          "codex-cli",
        ],
        { from: "user" }
      ),
      /unknown option '--harness'/
    );
  });
});

suite("CLI run command parser", () => {
  test("defaults harness and leaves resumeSession unset when neither flag is passed", async () => {
    const calls: { run?: { file: string | undefined; options: RunCommandOptions } } =
      {};
    await createRunProgram(calls).parseAsync(
      ["run", "workflow.ctrlyoke.json"],
      { from: "user" }
    );

    assert.strictEqual(calls.run?.file, "workflow.ctrlyoke.json");
    assert.strictEqual(calls.run?.options.harness, "copilot-cli");
    assert.strictEqual(calls.run?.options.resumeSession, undefined);
  });

  test("--resume-session and --no-resume-session set explicit tri-state values", async () => {
    // Regression test: these two flags were previously declared as a single
    // invalid `--[no-]resume-session` string, which commander parsed as one
    // unusable literal flag rather than a negatable pair.
    const resumeCalls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(resumeCalls).parseAsync(
      ["run", "--resume-session"],
      { from: "user" }
    );
    assert.strictEqual(resumeCalls.run?.options.resumeSession, true);

    const freshCalls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(freshCalls).parseAsync(
      ["run", "--no-resume-session"],
      { from: "user" }
    );
    assert.strictEqual(freshCalls.run?.options.resumeSession, false);
  });

  test("parses repeatable --var assignments into a key/value record", async () => {
    const calls: { run?: { file: string | undefined; options: RunCommandOptions } } =
      {};
    await createRunProgram(calls).parseAsync(
      ["run", "--var", "foo=bar", "--var", "baz=qux"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.run?.options.var, { foo: "bar", baz: "qux" });
  });

  test("parses repeatable --allow-tool/--deny-tool and negatable --no-color", async () => {
    const calls: { run?: { file: string | undefined; options: RunCommandOptions } } =
      {};
    await createRunProgram(calls).parseAsync(
      [
        "run",
        "--allow-tool",
        "read",
        "--allow-tool",
        "write",
        "--deny-tool",
        "exec",
        "--no-color",
      ],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.run?.options.allowTool, ["read", "write"]);
    assert.deepStrictEqual(calls.run?.options.denyTool, ["exec"]);
    assert.strictEqual(calls.run?.options.color, false);
  });

  test("parses --harness, --model, --prompt, and --session-id overrides", async () => {
    const calls: { run?: { file: string | undefined; options: RunCommandOptions } } =
      {};
    await createRunProgram(calls).parseAsync(
      [
        "run",
        "--harness",
        "claude-cli",
        "--model",
        "opus",
        "--prompt",
        "do the thing",
        "--session-id",
        "abc-123",
      ],
      { from: "user" }
    );
    assert.strictEqual(calls.run?.options.harness, "claude-cli");
    assert.strictEqual(calls.run?.options.model, "opus");
    assert.strictEqual(calls.run?.options.prompt, "do the thing");
    assert.strictEqual(calls.run?.options.sessionId, "abc-123");
  });
});
