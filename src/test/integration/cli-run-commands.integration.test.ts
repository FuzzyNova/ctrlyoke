import * as assert from "assert";
import { Command } from "commander";
import {
  registerRunScopedCommands,
  type AppendOptions,
  type ContinueOptions,
  type RerunOptions,
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
