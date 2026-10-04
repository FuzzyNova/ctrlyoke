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
import { PERMISSION_MODES } from "../../types/DashboardConstants";
import {
  applyCliPropertyOverrides,
  buildCliPropertyOverrides,
  ForceableFlag,
} from "../../cli/CliPropertyOverrides";

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
        "--force",
        "harness",
      ],
      { from: "user" }
    );

    assert.deepStrictEqual(calls.rerun?.workflow, "release");
    assert.strictEqual(calls.rerun?.from, "9");
    assert.strictEqual(calls.rerun?.harness, "codex-cli");
    assert.strictEqual(calls.rerun?.model, "gpt-5");
    assert.deepStrictEqual(calls.rerun?.force, [ForceableFlag.HARNESS]);
  });

  test("execution overrides are shared by append and continue, but force is rerun-only", async () => {
    const appendCalls: {
      append?: { file: string | undefined; options: AppendOptions };
    } = {};
    await createProgram(appendCalls).parseAsync(
      [
        "append",
        "tail.yaml",
        "--workflow",
        "release",
        "--run",
        "7",
        "--headless",
        "--permission-mode",
        "none",
        "--allow-tool",
        "read",
      ],
      { from: "user" }
    );
    assert.strictEqual(appendCalls.append?.options.headless, true);
    assert.strictEqual(appendCalls.append?.options.permissionMode, "none");
    assert.deepStrictEqual(appendCalls.append?.options.allowTool, ["read"]);
    const continueCalls: { continue?: ContinueOptions } = {};
    await createProgram(continueCalls).parseAsync(
      [
        "continue",
        "--workflow",
        "release",
        "--run",
        "7",
        "--interactive",
        "--deny-tool",
        "exec",
      ],
      { from: "user" }
    );
    assert.strictEqual(continueCalls.continue?.interactive, true);
    assert.deepStrictEqual(continueCalls.continue?.denyTool, ["exec"]);
    await assert.rejects(
      createProgram({}).parseAsync(
        ["continue", "--workflow", "release", "--run", "7", "--force", "all"],
        { from: "user" }
      ),
      /unknown option '--force'/
    );
  });

  test("rerun applies harness and model overrides through the workflow override path", async () => {
    const calls: { rerun?: RerunOptions } = {};
    await createProgram(calls).parseAsync(
      [
        "rerun",
        "--workflow",
        "release",
        "--harness",
        "codex-cli",
        "--model",
        "gpt-5",
        "--force",
        "harness",
      ],
      { from: "user" }
    );
    const workflow = {
      harness: "claude-cli" as const,
      model: "sonnet",
      steps: [
        { prompt: "workflow inherited" },
        { prompt: "explicit harness", harness: "opencode-cli" as const },
      ],
    };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides(calls.rerun!)
    );
    assert.strictEqual(workflow.harness, "codex-cli");
    assert.strictEqual(workflow.model, "gpt-5");
    assert.deepStrictEqual(
      workflow.steps.map((step) => step.harness),
      ["codex-cli", "codex-cli"]
    );
  });

  test("append and continue execution flags update workflow defaults and preserve step values", async () => {
    const workflow = {
      executionMode: "interactive" as const,
      toolPermissions: { allowedTools: ["workflow-tool"] },
      steps: [
        { prompt: "completed", executionMode: "interactive" as const },
        {
          prompt: "pending",
          toolPermissions: { deniedTools: ["step-tool"] },
        },
      ],
    };
    const commonOptions = {
      headless: true,
      permissionMode: PERMISSION_MODES.NONE,
      allowTool: [],
      denyTool: [],
    };
    applyCliPropertyOverrides(workflow, buildCliPropertyOverrides(commonOptions));
    assert.strictEqual(workflow.executionMode, "headless");
    assert.deepStrictEqual(workflow.toolPermissions, {
      allowedTools: ["workflow-tool"],
      mode: PERMISSION_MODES.NONE,
    });
    assert.strictEqual(workflow.steps[0].executionMode, "interactive");
    assert.deepStrictEqual(workflow.steps[1].toolPermissions, {
      deniedTools: ["step-tool"],
    });
  });

  test("property help describes workflow scope and forceable names", () => {
    const runHelp = createRunProgram({})
      .commands[0]
      .helpInformation()
      .replace(/\s+/gu, " ");
    const command = createProgram({});
    const rerunHelp = command.commands[0]
      .helpInformation()
      .replace(/\s+/gu, " ");
    const appendHelp = command.commands[1]
      .helpInformation()
      .replace(/\s+/gu, " ");
    for (const description of [runHelp, rerunHelp]) {
      assert.match(
        description,
        /workflow level; add `--force <flag>` to apply to every step/u
      );
    }
    assert.match(rerunHelp, /--force <flags>/u);
    assert.doesNotMatch(appendHelp, /--force <flags>/u);
    for (const flag of Object.values(ForceableFlag)) {
      assert.ok(rerunHelp.includes(flag), `rerun help lists ${flag}`);
    }
    assert.match(runHelp, /--permission-mode.*workflow tool permission mode/u);
    assert.doesNotMatch(runHelp, /overrides the defaults\.toolPermissions\.mode setting/u);
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
  test("leaves harness and resumeSession unset when neither flag is passed", async () => {
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(
      ["run", "workflow.ctrlyoke.json"],
      { from: "user" }
    );

    assert.strictEqual(calls.run?.file, "workflow.ctrlyoke.json");
    // No Commander default: an omitted --harness must stay distinguishable
    // from an explicit one, or it overrides the workflow's own `harness`.
    assert.strictEqual(calls.run?.options.harness, undefined);
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
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(
      ["run", "--var", "foo=bar", "--var", "baz=qux"],
      { from: "user" }
    );
    assert.deepStrictEqual(calls.run?.options.var, { foo: "bar", baz: "qux" });
  });

  test("rejects invalid and case-colliding --var names", async () => {
    const originalExit = process.exit;
    const originalError = console.error;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    console.error = () => undefined;
    try {
      await assert.rejects(
        createRunProgram({}).parseAsync(["run", "--var", "bad-name=value"], {
          from: "user",
        }),
        /process\.exit\(2\)/
      );
      await assert.rejects(
        createRunProgram({}).parseAsync(
          ["run", "--var", "foo=one", "--var", "FOO=two"],
          { from: "user" }
        ),
        /process\.exit\(2\)/
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  test("parses --dry-run without changing the normal run options", async () => {
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(
      ["run", "workflow.ctrlyoke.yaml", "--dry-run", "--json"],
      { from: "user" }
    );

    assert.strictEqual(calls.run?.options.dryRun, true);
    assert.strictEqual(calls.run?.options.json, true);
    assert.deepStrictEqual(calls.run?.options.var, {});
  });

  test("parses repeatable --allow-tool/--deny-tool and negatable --no-color", async () => {
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
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
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
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

  test("leaves setting-backed flags unset when omitted", async () => {
    // A Commander default here would silently override the settings files
    // through the CLI overlay.
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(["run"], { from: "user" });
    assert.strictEqual(calls.run?.options.timeout, undefined);
    assert.strictEqual(calls.run?.options.scriptTimeout, undefined);
    assert.strictEqual(calls.run?.options.permissionMode, undefined);
  });

  test("parses timeout and permission-mode overrides into typed values", async () => {
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(
      [
        "run",
        "-t",
        "-1",
        "--script-timeout",
        "90",
        "--permission-mode",
        PERMISSION_MODES.NONE,
      ],
      { from: "user" }
    );
    assert.strictEqual(calls.run?.options.timeout, -1);
    assert.strictEqual(calls.run?.options.scriptTimeout, 90);
    assert.strictEqual(
      calls.run?.options.permissionMode,
      PERMISSION_MODES.NONE
    );
  });

  test("requires --script-timeout to be a positive whole number", async () => {
    await assert.rejects(
      createRunProgram({}).parseAsync(["run", "--script-timeout", "-1"], {
        from: "user",
      }),
      (error: Error) => {
        assert.match(error.message, /script-timeout/);
        assert.match(error.message, /whole number/);
        assert.doesNotMatch(error.message, /unlimited/);
        return true;
      }
    );

    await assert.rejects(
      createRunProgram({}).parseAsync(["run", "--script-timeout", "1.5"], {
        from: "user",
      }),
      /script-timeout.*whole number/
    );
  });

  test("applies permission flags to a nullable workflow permission object", async () => {
    const calls: {
      run?: { file: string | undefined; options: RunCommandOptions };
    } = {};
    await createRunProgram(calls).parseAsync(
      ["run", "--prompt", "do the thing", "--permission-mode", "custom"],
      { from: "user" }
    );

    const workflow = { toolPermissions: null, steps: [] };
    applyCliPropertyOverrides(
      workflow,
      buildCliPropertyOverrides(calls.run!.options)
    );
    assert.deepStrictEqual(workflow.toolPermissions, {
      mode: PERMISSION_MODES.CUSTOM,
    });
  });

  test("no longer accepts the removed --add-dir flag", async () => {
    await assert.rejects(
      createRunProgram({}).parseAsync(["run", "--add-dir", "/tmp"], {
        from: "user",
      }),
      /unknown option '--add-dir'/
    );
  });
});
