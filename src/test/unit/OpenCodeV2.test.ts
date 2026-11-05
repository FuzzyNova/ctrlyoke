import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { buildOpenCodeMcpEntries } from "../../core/harness/opencode/OpenCodeInlineConfig";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";
import {
  OPENCODE_CLI_FLAGS,
  OPENCODE_PLUGIN_PATHS,
  OPENCODE_RESUME_PROMPT_ENV,
} from "../../core/harness/opencode/OpenCodeProtocolConstants";
import {
  isOpenCodeV2Version,
  setOpenCodeVersionProbe,
} from "../../core/harness/opencode/OpenCodeVersion";
import type {
  BashCommandData,
  CliEvent,
  FileEditData,
  FileReadData,
  FileWriteData,
  TextData,
  ToolCall,
} from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  PERMISSION_MODES,
} from "../../types/DashboardConstants";

/** Real OpenCode 2.2.5 captures (workspace path replaced). */
const FIXTURE_ROOT = path.resolve(
  __dirname,
  "../../../src/test/fixtures/opencode"
);
const readFixture = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8");

const SESSION_ID = "ses_e539f82b9ffeChWNlWdR7GyDE4";
const MODEL = "opencode/big-pickle";

/** Data of the first event of `type`, which the caller names the shape of. */
function eventOf<D>(events: CliEvent[], type: CliEvent["type"]): D {
  const match = events.find((event) => event.type === type);
  assert.ok(match, `expected a ${type} event`);
  return match.data as D;
}

/** The tool events the `v2-tools` capture produces from either source. */
function assertToolCaptureEvents(events: CliEvent[]): void {
  const shell = eventOf<BashCommandData>(events, CLI_EVENT_TYPES.BASH_COMMAND);
  assert.strictEqual(shell.command, "echo probe-ok");
  assert.strictEqual(shell.output, "probe-ok\n");
  assert.strictEqual(shell.exitCode, 0);

  const write = eventOf<FileWriteData>(events, CLI_EVENT_TYPES.FILE_WRITE);
  assert.strictEqual(write.path, "b.txt");
  assert.strictEqual(write.content, "two");

  const edit = eventOf<FileEditData>(events, CLI_EVENT_TYPES.FILE_EDIT);
  assert.strictEqual(edit.path, "a.txt");
  assert.strictEqual(edit.oldContent, "hello");
  assert.strictEqual(edit.newContent, "world");
  assert.strictEqual(edit.success, true);
  assert.ok(
    edit.structuredPatch?.length,
    "edit diff parsed from files[].patch"
  );

  assert.strictEqual(
    eventOf<FileReadData>(events, CLI_EVENT_TYPES.FILE_READ).path,
    "a.txt"
  );
  const texts = events
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
    .map((event) => (event.data as { text: string }).text);
  assert.strictEqual(texts.at(-1), "DONE");
}

suite("OpenCode 2 support", () => {
  test("recognizes OpenCode 2 from its --version output", () => {
    assert.strictEqual(isOpenCodeV2Version("opencode v2.2.5"), true);
    assert.strictEqual(isOpenCodeV2Version("2.0.0"), true);
    assert.strictEqual(isOpenCodeV2Version("1.19.5"), false);
    assert.strictEqual(isOpenCodeV2Version(undefined), false);
  });

  test("maps `run --format json` tool parts, tokens and session", () => {
    const provider = new OpenCodeCliProvider();
    const stdout = readFixture("v2-tools.stdout.jsonl");
    const output = provider.logParser.extractResponse(
      provider.parseHeadlessStdout(stdout)
    );

    assertToolCaptureEvents(output.events);
    assert.strictEqual(output.metadata.sessionId, SESSION_ID);
    assert.strictEqual(provider.extractSessionIdFromStdout(stdout), SESSION_ID);
    assert.strictEqual(output.metadata.usage?.inputTokens, 9217);
    assert.strictEqual(output.metadata.usage?.outputTokens, 235);
    // OpenCode 2 has no tokens.total; the last step's occupancy is rebuilt.
    assert.strictEqual(
      output.metadata.usage?.contextWindowUsedTokens,
      104 + 4 + 9728
    );
  });

  test("maps a subagent call and follows its child session", () => {
    const provider = new OpenCodeCliProvider();
    const output = provider.logParser.extractResponse(
      provider.parseHeadlessStdout(readFixture("v2-subagent.stdout.jsonl"))
    );
    const call = eventOf<ToolCall>(output.events, CLI_EVENT_TYPES.TOOL_CALL);
    assert.strictEqual(call.name, "subagent");
    assert.ok(call.id, "subagent call id taken from OpenCode 2 `id`");
    assert.strictEqual(call.subagentSpawn?.agentType, "general");
    assert.match(call.subagentSpawn?.children?.[0]?.agentId ?? "", /^ses_/);
  });

  test("converts `session export` messages into the same events, once", async () => {
    const parser = new OpenCodeLogParser(
      () => undefined,
      async () => readFixture("v2-tools-export.json")
    );
    const events = await parser.readNewLines(SESSION_ID);
    const output = parser.extractResponse(events);

    assertToolCaptureEvents(output.events);
    assert.strictEqual(output.metadata.sessionId, SESSION_ID);
    assert.strictEqual(
      parser.classifyUserEvent(events[0], {
        dispatchedPromptText: "Do exactly these steps using tools",
      }),
      "injected-prompt"
    );
    assert.ok(events.some((event) => parser.isComplete(event)));
    assert.deepStrictEqual(await parser.readNewLines(SESSION_ID), []);
  });

  test("holds back streaming export content until it is final", async () => {
    let completed = false;
    const exportJson = () =>
      JSON.stringify({
        info: { id: "ses_live" },
        messages: [
          {
            id: "msg_a",
            type: "assistant",
            time: completed ? { created: 1, completed: 2 } : { created: 1 },
            content: [
              {
                type: "tool",
                id: "call_1",
                name: "shell",
                state: completed
                  ? {
                      status: "completed",
                      input: { command: "ls" },
                      content: [{ type: "text", text: "a.txt\n" }],
                      metadata: { exit: 0 },
                    }
                  : {
                      status: "running",
                      input: { command: "ls" },
                      metadata: {},
                    },
              },
              { type: "text", text: completed ? "Listed." : "List" },
            ],
            ...(completed
              ? {
                  finish: "stop",
                  tokens: {
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                }
              : {}),
          },
        ],
      });
    const parser = new OpenCodeLogParser(
      () => undefined,
      async () => exportJson()
    );

    assert.deepStrictEqual(await parser.readNewLines("ses_live"), []);
    completed = true;
    const output = parser.extractResponse(
      await parser.readNewLines("ses_live")
    );
    assert.strictEqual(
      eventOf<BashCommandData>(output.events, CLI_EVENT_TYPES.BASH_COMMAND)
        .output,
      "a.txt\n"
    );
    assert.strictEqual(
      eventOf<TextData>(output.events, CLI_EVENT_TYPES.TEXT).text,
      "Listed."
    );
  });

  test("reads OpenCode 2 `{ type, message }` errors", () => {
    const provider = new OpenCodeCliProvider();
    const output = provider.logParser.extractResponse(
      provider.parseHeadlessStdout(
        JSON.stringify({
          type: "error",
          timestamp: 1,
          sessionID: "ses_x",
          error: { type: "unknown", message: "You must provide a message" },
        })
      )
    );
    assert.strictEqual(output.metadata.error, "You must provide a message");
  });

  suite("launch arguments", () => {
    let restore: () => void;
    const extensionPath = path.resolve("/extension");
    const context = (additionalArgs?: string) =>
      ({
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: { model: MODEL, additionalArgs },
      }) as any;

    setup(() => {
      restore = setOpenCodeVersionProbe(async () => "opencode v2.2.5");
    });
    teardown(() => restore());

    test("runs headless against a private server with the model flag", async () => {
      const provider = new OpenCodeCliProvider();
      const args = await provider.buildCliArgs(
        { prompt: "x" },
        false,
        extensionPath,
        undefined,
        undefined,
        context()
      );
      assert.deepStrictEqual(args, [
        "run",
        OPENCODE_CLI_FLAGS.STANDALONE,
        "--format",
        "json",
        OPENCODE_CLI_FLAGS.MODEL,
        MODEL,
      ]);
      const config = JSON.parse(
        provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.deepStrictEqual(config.plugins, [
        path.resolve(
          extensionPath,
          "out",
          "scripts",
          OPENCODE_PLUGIN_PATHS.V2_DIRECTORY
        ),
      ]);
      assert.strictEqual(config.plugin, undefined);
      assert.strictEqual(config.model, undefined);
    });

    test("moves the interactive model into config, since the TUI has no -m", async () => {
      const provider = new OpenCodeCliProvider();
      const args = await provider.buildCliArgs(
        { prompt: "x" },
        true,
        extensionPath,
        undefined,
        undefined,
        context()
      );
      assert.deepStrictEqual(args, [OPENCODE_CLI_FLAGS.STANDALONE]);
      const config = JSON.parse(
        provider.getInteractiveSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.strictEqual(config.model, MODEL);
    });

    test("passes a resumed prompt as --prompt, which the OpenCode 2 TUI honours", () => {
      const provider = new OpenCodeCliProvider();
      const baseArgs = [
        OPENCODE_CLI_FLAGS.STANDALONE,
        OPENCODE_CLI_FLAGS.SESSION,
        "ses_resumed",
      ];
      assert.deepStrictEqual(
        provider.buildInteractiveArgs(baseArgs, "second step"),
        [OPENCODE_CLI_FLAGS.PROMPT, "second step", ...baseArgs]
      );
      const env = provider.getInteractiveSpawnEnv();
      for (const name of Object.values(OPENCODE_RESUME_PROMPT_ENV)) {
        assert.strictEqual(env[name], undefined, name);
      }
    });

    test("leaves out --standalone when the user chose --server", async () => {
      const provider = new OpenCodeCliProvider();
      const args = await provider.buildCliArgs(
        { prompt: "x" },
        false,
        extensionPath,
        undefined,
        undefined,
        context("--server http://127.0.0.1:4096")
      );
      assert.ok(!args.includes(OPENCODE_CLI_FLAGS.STANDALONE));
      assert.deepStrictEqual(args.slice(-2), [
        "--server",
        "http://127.0.0.1:4096",
      ]);
    });

    test("keeps MCP tools out of Code Mode only on OpenCode 2", () => {
      const servers = [{ id: "probe", command: "node", args: ["probe.js"] }];
      const v2 = buildOpenCodeMcpEntries(
        undefined,
        undefined,
        undefined,
        undefined,
        servers,
        undefined,
        undefined,
        true
      );
      assert.strictEqual(v2.probe?.codemode, false);
      const v1 = buildOpenCodeMcpEntries(
        undefined,
        undefined,
        undefined,
        undefined,
        servers
      );
      assert.ok(v1.probe && !("codemode" in v1.probe));
    });

    test("does not rename colliding permission keys, which OpenCode 2 would not migrate", async () => {
      const workspaceRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "opencode-v2-collision-")
      );
      try {
        await fs.promises.writeFile(
          path.join(workspaceRoot, "opencode.json"),
          JSON.stringify({ permission: { bash: { "foo *": "allow" } } }),
          "utf8"
        );
        const provider = new OpenCodeCliProvider();
        await provider.buildCliArgs(
          { prompt: "x" },
          false,
          extensionPath,
          workspaceRoot,
          undefined,
          context()
        );
        await provider.prepareToolPermissions(
          {
            mode: PERMISSION_MODES.CUSTOM,
            allowedTools: [],
            deniedTools: ["shell(foo:*)"],
          },
          { workspaceRoot }
        );
        const config = JSON.parse(
          provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
        );
        assert.deepStrictEqual(config.permission.bash, { "foo *": "deny" });
        assert.strictEqual(config.permission["bash*"], undefined);
      } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });
});
