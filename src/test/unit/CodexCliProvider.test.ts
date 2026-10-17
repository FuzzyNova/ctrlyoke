import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { parse } from "smol-toml";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeWorkflowContext(resumeSession?: boolean): {
  promptIndex: number;
  allPrompts: never[];
  resolvedProperties: { resumeSession?: boolean };
} {
  return {
    promptIndex: 0,
    allPrompts: [],
    resolvedProperties: { resumeSession },
  };
}

// ============================================================================

suite("CodexCliProvider", () => {
  test("emits user hook timeout in native seconds", () => {
    const provider = new CodexCliProvider();
    const hooks = (provider as any).buildUserHooksSection([
      { event: "stop", command: "node slow.js", timeoutSec: 9 },
    ]);
    assert.strictEqual(hooks.Stop[0].hooks[0].timeout, 9);
  });

  test("preserves backslashes in user MCP args and environment values", async () => {
    const provider = new CodexCliProvider();
    const args = ["server.js", String.raw`\\d+`];
    const env = { DOMAIN_USER: String.raw`CORP\\alice` };
    const preparation = await provider.planMcpConfigArgs(
      undefined,
      "/workspace",
      undefined,
      undefined,
      [{ id: "user-server", command: "node", args, env }]
    );
    const configIndex = preparation.cliArgs.indexOf("-c") + 1;
    const parsed = parse(preparation.cliArgs[configIndex]) as {
      mcp_servers: {
        "user-server": { args: string[]; env: Record<string, string> };
      };
    };

    assert.deepStrictEqual(parsed.mcp_servers["user-server"].args, args);
    assert.deepStrictEqual({ ...parsed.mcp_servers["user-server"].env }, env);
  });

  test("skips an unrepresentable MCP server and keeps ctrlyoke and valid servers", async () => {
    const preparation = await new CodexCliProvider().planMcpConfigArgs(
      ".ctrlyoke-mcp-server",
      "/workspace",
      undefined,
      undefined,
      [
        {
          id: "invalid-server",
          command: "node",
          env: { TOKEN: "prefix-${secret:API_KEY}" },
        },
        { id: "valid-server", command: "node", args: ["server.js"] },
      ]
    );

    assert.ok(
      preparation.cliArgs.some((arg) => arg.includes("mcp_servers.ctrlyoke"))
    );
    assert.ok(
      preparation.cliArgs.some((arg) =>
        arg.includes("mcp_servers.valid-server")
      )
    );
    assert.ok(
      !preparation.cliArgs.some((arg) =>
        arg.includes("mcp_servers.invalid-server")
      )
    );
    assert.strictEqual(preparation.diagnostics.length, 1);
    assert.match(preparation.diagnostics[0].message, /invalid-server/);
    assert.strictEqual(preparation.diagnostics[0].state.fidelity, "partial");
    assert.match(
      preparation.diagnostics[0].message,
      /composite secret interpolation/
    );
  });

  test("sanitizes MCP server IDs consistently in config and approval overrides", async () => {
    const preparation = await new CodexCliProvider().planMcpConfigArgs(
      undefined,
      "/workspace",
      undefined,
      undefined,
      [
        {
          id: "io.github.upstash/context7",
          command: "npx",
          autoApprove: ["list-tools", "files/read", "tool.with.dot"],
        },
      ]
    );
    const args = preparation.cliArgs;

    assert.ok(
      args.some((arg) =>
        arg.includes("mcp_servers.io_github_upstash_context7=")
      )
    );
    assert.ok(
      args.some((arg) =>
        arg.includes(
          "mcp_servers.io_github_upstash_context7.tools.list-tools.approval_mode"
        )
      )
    );
    // Tool names are server-defined, so they are never renamed.
    assert.ok(
      args.some((arg) =>
        arg.includes(
          "mcp_servers.io_github_upstash_context7.tools.files/read.approval_mode"
        )
      )
    );
    assert.ok(!args.some((arg) => arg.includes("tool.with.dot")));
  });

  test("skips MCP server IDs that collide after Codex key sanitization", async () => {
    const preparation = await new CodexCliProvider().planMcpConfigArgs(
      undefined,
      "/workspace",
      undefined,
      undefined,
      [
        { id: "my.server", command: "first" },
        { id: "my_server", command: "second" },
      ]
    );
    const serverConfigs = preparation.cliArgs.filter(
      (arg) => arg.startsWith("mcp_servers.") && arg.includes("={")
    );

    assert.strictEqual(serverConfigs.length, 1);
    assert.ok(serverConfigs[0].includes('command="first"'));
  });

  suite("MCP capability declaration", () => {
    test("declares native per-server filtering for server-owned denials", () => {
      const filtering = new CodexCliProvider().capabilities.mcp
        ?.perServerToolFiltering;

      assert.deepStrictEqual(
        {
          fidelity: filtering?.fidelity,
          mechanism: filtering?.mechanism,
          verificationKind: filtering?.verification?.kind,
        },
        {
          fidelity: "exact",
          mechanism: "native",
          verificationKind: "manual",
        }
      );
    });
  });

  suite("buildCliSuffix", () => {
    const provider = new CodexCliProvider();

    test("returns ['resume', sessionId] when resumeSession=true and sessionId is set", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, ["resume", "thread_abc123"]);
    });

    test("returns [] when resumeSession=true but sessionId is undefined", () => {
      const result = provider.buildCliSuffix(
        undefined,
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession=false", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(false)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession is undefined", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(undefined)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when workflowContext is undefined", () => {
      const result = provider.buildCliSuffix("thread_abc123", undefined);
      assert.deepStrictEqual(result, []);
    });
  });

  test("requests concise reasoning summaries ahead of any user additionalArgs", async () => {
    // Codex's reasoning is encrypted; without a summary the dashboard has no
    // readable trace of it. additionalArgs follow, so a user's own
    // `-c model_reasoning_summary=...` still wins (Codex keeps the last -c).
    for (const isInteractive of [true, false]) {
      const args = await new CodexCliProvider().buildCliArgs(
        {} as any,
        isInteractive,
        "/ext",
        "/workspace",
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            additionalArgs: "-c model_reasoning_summary=detailed",
          },
        } as any
      );
      const ours = args.indexOf('model_reasoning_summary="concise"');
      assert.ok(ours > 0 && args[ours - 1] === "-c", JSON.stringify(args));
      assert.ok(
        args.indexOf("model_reasoning_summary=detailed") > ours,
        "user additionalArgs must come after the default"
      );
    }
  });

  suite("buildCliArgs resume ordering", () => {
    const provider = new CodexCliProvider();

    test("does not include 'resume' token in buildCliArgs output when resumeSession=true", async () => {
      // The "resume" subcommand must NOT be added by buildCliArgs — it belongs in
      // buildCliSuffix so it appears after all global flags (hooks, permissions).
      const args = await provider.buildCliArgs(
        {} as any,
        true, // interactive
        "/ext",
        "/workspace",
        "thread_abc123",
        makeWorkflowContext(true) as any
      );
      assert.ok(
        !args.includes("resume"),
        `buildCliArgs must not include 'resume' (got: ${JSON.stringify(args)})`
      );
    });

    test("combined arg order puts resume after hook args", () => {
      // Simulate the CliIntegration assembly: baseArgs → hookArgs pushed → suffix appended
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);

      const suffixArgs = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      baseArgs.push(...suffixArgs);

      const resumeIndex = baseArgs.indexOf("resume");
      const enableIndex = baseArgs.indexOf("--enable");
      const configIndex = baseArgs.indexOf("-c");

      assert.ok(resumeIndex > -1, "resume must be present");
      assert.ok(enableIndex > -1, "--enable must be present");
      assert.ok(configIndex > -1, "-c must be present");

      assert.ok(
        resumeIndex > enableIndex,
        `'resume' (index ${resumeIndex}) must appear after '--enable' (index ${enableIndex})`
      );
      assert.ok(
        resumeIndex > configIndex,
        `'resume' (index ${resumeIndex}) must appear after '-c' (index ${configIndex})`
      );

      // Session ID immediately follows "resume"
      assert.strictEqual(
        baseArgs[resumeIndex + 1],
        "thread_abc123",
        "session ID must immediately follow 'resume'"
      );
    });

    test("interactive resumed command puts global hook trust before resume and prompt after session ID", () => {
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);
      baseArgs.push(
        ...provider.buildCliSuffix("thread_abc123", makeWorkflowContext(true))
      );

      const result = provider.buildInteractiveArgs(baseArgs, "continue work");

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--add-dir",
        "/workspace",
        "--enable",
        "hooks",
        "-c",
        "hooks.state={...}",
        "--approval-policy=auto",
        "resume",
        "thread_abc123",
        "continue work",
      ]);
    });

    test("interactive new-session command puts prompt after global args", () => {
      const result = provider.buildInteractiveArgs(
        ["--model", "gpt-5.2-codex", "--enable", "hooks"],
        "start work"
      );

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--enable",
        "hooks",
        "start work",
      ]);
    });

    test("builds native image arguments for resolved attachments", () => {
      assert.deepStrictEqual(
        provider.buildImageAttachmentArgs(
          ["shots/one.png", "shots/two.jpg"],
          true
        ),
        ["--image", "shots/one.png", "--image", "shots/two.jpg"]
      );
    });
  });

  suite("buildNotificationHookArgs", () => {
    const provider = new CodexCliProvider();

    test("emits notification and user hooks as inline trusted overrides", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-hook-args-")
      );

      try {
        const args = await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          [
            { event: "stop", command: "node user-stop.js" },
            { event: "userPromptSubmit", command: "node prompt-check.js" },
          ],
          []
        );

        assert.deepStrictEqual(args.slice(0, 2), ["--enable", "hooks"]);
        assert.ok(
          !args.includes("--dangerously-bypass-hook-trust"),
          "hook trust bypass should not be emitted when inline trust state is present"
        );
        const overrides = args.filter(
          (arg) => arg.startsWith("hooks.") && !arg.startsWith("hooks.state=")
        );
        assert.strictEqual(overrides.length, 3);
        assert.ok(
          overrides.some((arg) => arg.startsWith("hooks.SessionStart="))
        );
        assert.ok(
          overrides.some(
            (arg) =>
              arg.startsWith("hooks.Stop=") &&
              arg.includes("ctrlyoke-codex-notify.js") &&
              arg.includes("user-stop.js")
          )
        );
        assert.ok(
          overrides.some(
            (arg) =>
              arg.startsWith("hooks.UserPromptSubmit=") &&
              arg.includes("prompt-check.js")
          )
        );
        assert.ok(args.some((arg) => arg.startsWith("hooks.state=")));
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("does not create files or directories under the workspace root", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-inline-workspace-")
      );

      try {
        await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          undefined,
          []
        );
        await provider.buildHeadlessUserHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          [{ event: "stop", command: "node user-stop.js" }],
          []
        );

        assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("emits headless user hooks inline without notification hooks", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-headless-hook-args-")
      );

      try {
        const args = await provider.buildHeadlessUserHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          [{ event: "userPromptSubmit", command: "node prompt-check.js" }],
          []
        );

        assert.deepStrictEqual(args.slice(0, 2), ["--enable", "hooks"]);
        assert.ok(
          args.some((arg) => arg.startsWith("hooks.UserPromptSubmit="))
        );
        assert.ok(args.some((arg) => arg.startsWith("hooks.state=")));
        assert.ok(
          !args.some((arg) => arg.startsWith("hooks.SessionStart=")),
          "headless mode should not add notification hooks"
        );
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  suite("log-sourced headless mode", () => {
    const provider = new CodexCliProvider();

    test("selects the session log and reads thread.started from stdout", () => {
      assert.strictEqual(provider.headlessSource, "log");
      assert.strictEqual(
        provider.extractSessionIdFromStdout?.(
          '{"type":"thread.started","thread_id":"thread_abc123"}\n'
        ),
        "thread_abc123"
      );
      assert.strictEqual(
        provider.extractSessionIdFromStdout?.('{"type":"turn.started"}\n'),
        undefined
      );
    });
  });
});
