import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { parse } from "smol-toml";
import { CodexHarnessAdapter } from "../../core/harness/codex/CodexHarnessAdapter";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { CodexSandboxMapper } from "../../core/harness/codex/CodexSandboxMapper";
import {
  PERMISSION_MODES,
  SANDBOX_MODES,
  type SandboxMode,
  type SandboxRequest,
} from "../../types/DashboardConstants";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../../types/CompatibilityTypes";
import type { ToolPermissionConfig } from "../../core/harness/shared/interfaces/IToolPermissionMapper";

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

suite("CodexHarnessAdapter", () => {
  test("approval flags follow the permission mode alone, and only interactively", () => {
    const mapper = new CodexToolPermissionMapper();
    const cases = [
      [
        "none",
        { mode: PERMISSION_MODES.NONE, allowedTools: [], deniedTools: [] },
      ],
      [
        "custom",
        { mode: PERMISSION_MODES.CUSTOM, allowedTools: [], deniedTools: [] },
      ],
      [
        "custom denied write",
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: [],
          deniedTools: ["write"],
        },
      ],
      [
        "allowAll",
        { mode: PERMISSION_MODES.ALLOW_ALL, allowedTools: [], deniedTools: [] },
      ],
      [
        "dangerouslyAllowAll",
        {
          mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          allowedTools: [],
          deniedTools: [],
        },
      ],
    ] as const satisfies readonly (readonly [string, ToolPermissionConfig])[];
    const snapshots: Record<
      string,
      { interactive: string[]; headless: string[] }
    > = {};
    for (const [name, config] of cases) {
      snapshots[name] = {
        interactive: mapper.buildCodexSpecificArgs(config, true),
        headless: mapper.buildCodexSpecificArgs(config, false),
      };
    }
    assert.deepStrictEqual(snapshots, {
      none: { interactive: [], headless: [] },
      custom: { interactive: ["-a", "on-request"], headless: [] },
      // No read-only clamp: the deny list is reported, not enforced.
      "custom denied write": {
        interactive: ["-a", "on-request"],
        headless: [],
      },
      allowAll: { interactive: ["-a", "on-request"], headless: [] },
      dangerouslyAllowAll: { interactive: ["-a", "never"], headless: [] },
    });
  });

  test("a denied write tool is reported as not enforced", async () => {
    const result = await new CodexToolPermissionMapper().prepare(
      {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [],
        deniedTools: ["write"],
      },
      { isInteractive: true } as any
    );
    // Nothing clamps the sandbox any more, so the denial is only reported.
    assert.deepStrictEqual(
      result.diagnostics.map((d) => d.code),
      [COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL]
    );
    assert.deepStrictEqual(result.cliArgs, ["-a", "on-request"]);
  });

  test("sandbox flags follow sandbox and sandboxMode alone", async () => {
    const sandboxMapper = new CodexSandboxMapper();
    const rows: Array<[SandboxRequest | undefined, SandboxMode, string[]]> = [
      [true, SANDBOX_MODES.WORKSPACE_WRITE, ["-s", "workspace-write"]],
      [true, SANDBOX_MODES.READ_ONLY, ["-s", "read-only"]],
      [false, SANDBOX_MODES.WORKSPACE_WRITE, ["-s", "danger-full-access"]],
      [false, SANDBOX_MODES.READ_ONLY, ["-s", "danger-full-access"]],
      [null, SANDBOX_MODES.READ_ONLY, []],
      [undefined, SANDBOX_MODES.WORKSPACE_WRITE, []],
    ];
    for (const [request, sandboxMode, expected] of rows) {
      for (const isInteractive of [true, false]) {
        const result = await sandboxMapper.prepare(request, {
          isInteractive,
          writableRoots: [],
          sandboxMode,
          requestFromDefaults: false,
        });
        assert.deepStrictEqual(
          result.cliArgs,
          expected,
          `${request}:${sandboxMode}:${isInteractive}`
        );
      }
    }
  });

  test("passes external roots to --add-dir except under read-only", async () => {
    const provider = new CodexHarnessAdapter();
    const roots = [path.resolve("workspace/extra"), path.resolve("approved")];
    const addDirs = async (resolvedProperties: Record<string, unknown>) => {
      const args = await provider.buildCliArgs(
        {} as any,
        true,
        "/ext",
        path.resolve("workspace"),
        undefined,
        { promptIndex: 0, allPrompts: [], resolvedProperties } as any,
        roots,
        []
      );
      return args.flatMap((arg, index) =>
        arg === "--add-dir" ? [args[index + 1]] : []
      );
    };
    assert.deepStrictEqual(await addDirs({}), roots);
    assert.deepStrictEqual(await addDirs({ sandbox: null }), roots);
    assert.deepStrictEqual(await addDirs({ sandbox: false }), roots);
    assert.deepStrictEqual(
      await addDirs({ sandbox: true, sandboxMode: SANDBOX_MODES.READ_ONLY }),
      []
    );
    assert.deepStrictEqual(
      await addDirs({
        sandbox: false,
        sandboxMode: SANDBOX_MODES.READ_ONLY,
      }),
      roots
    );
  });

  test("grants Git's admin directories as roots under workspace-write, in a plain checkout and a linked worktree", async () => {
    const root = makeTempDir("codex-git-roots-");
    try {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
          { cwd, stdio: "ignore" }
        );
      const plain = path.join(root, "plain");
      const linked = path.join(root, "linked");
      fsSync.mkdirSync(plain);
      git(plain, "init", "--quiet");
      git(plain, "commit", "--quiet", "--allow-empty", "-m", "init");
      git(plain, "worktree", "add", "--quiet", linked, "-b", "linked-branch");
      const plainGit = fsSync.realpathSync(path.join(plain, ".git"));
      const linkedGit = path.join(plainGit, "worktrees", "linked");

      const provider = new CodexHarnessAdapter();
      const addDirs = async (
        workspaceRoot: string,
        resolvedProperties: Record<string, unknown>
      ) => {
        const args = await provider.buildCliArgs(
          {} as any,
          false,
          "/ext",
          workspaceRoot,
          undefined,
          { promptIndex: 0, allPrompts: [], resolvedProperties } as any,
          [],
          []
        );
        return args.flatMap((arg, index) =>
          arg === "--add-dir" ? [args[index + 1]] : []
        );
      };
      const contained = {
        toolPermissions: {
          mode: PERMISSION_MODES.ALLOW_ALL,
          allowedTools: [],
          deniedTools: [],
        },
        sandbox: true,
        sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE,
      };

      // Plain checkout: the common dir is the only admin directory.
      assert.deepStrictEqual(await addDirs(plain, contained), [plainGit]);
      // Linked worktree: Codex protects the worktree's own gitdir even inside
      // the added common dir, so it must be a root in its own right.
      assert.deepStrictEqual(
        (await addDirs(linked, contained)).sort(),
        [plainGit, fsSync.realpathSync(linkedGit)].sort()
      );
      // Read-only containment grants no extra roots, and neither does a
      // sandbox that is off or left to config.toml.
      for (const override of [
        { sandbox: false },
        { sandbox: null },
        { sandboxMode: SANDBOX_MODES.READ_ONLY },
      ]) {
        assert.deepStrictEqual(
          await addDirs(linked, { ...contained, ...override }),
          [],
          JSON.stringify(override)
        );
      }
    } finally {
      removeTempDir(root);
    }
  });

  test("probes Codex rollout files by session ID only", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-probe-"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const provider = new CodexHarnessAdapter();
      const rolloutDir = path.join(home, "sessions", "2026", "11", "01");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-x-test-id.jsonl"),
        "{}\n"
      );
      assert.strictEqual(
        provider.probeResumableSession("test-id", "/workspace"),
        "available"
      );
      assert.strictEqual(
        provider.probeResumableSession("missing-id", "/workspace"),
        "missing"
      );
      assert.strictEqual(
        provider.isRecoverableSessionError("thread test-id not found"),
        true
      );
      assert.strictEqual(
        provider.isRecoverableSessionError("authentication failed"),
        false
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test("emits user hook timeout in native seconds", () => {
    const provider = new CodexHarnessAdapter();
    const hooks = (provider as any).buildUserHooksSection([
      { event: "stop", command: "node slow.js", timeoutSec: 9 },
    ]);
    assert.strictEqual(hooks.Stop[0].hooks[0].timeout, 9);
  });

  test("preserves backslashes in user MCP args and environment values", async () => {
    const provider = new CodexHarnessAdapter();
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
    const preparation = await new CodexHarnessAdapter().planMcpConfigArgs(
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

  test("does not add the working directory as an extra Codex directory", async () => {
    const args = await new CodexHarnessAdapter().buildCliArgs(
      {} as any,
      true,
      "/ext",
      path.resolve("workspace"),
      undefined,
      makeWorkflowContext() as any
    );

    assert.ok(!args.includes("--add-dir"), JSON.stringify(args));
  });

  test("sanitizes MCP server IDs consistently in config and approval overrides", async () => {
    const preparation = await new CodexHarnessAdapter().planMcpConfigArgs(
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
    const preparation = await new CodexHarnessAdapter().planMcpConfigArgs(
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

  test("sends tool-permission MCP denials as the attached server's disabled_tools", async () => {
    const args = await new CodexHarnessAdapter().buildCliArgs(
      {} as any,
      false,
      "/ext",
      "/workspace",
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: {
          mcpServers: [
            {
              id: "github",
              command: "github-mcp",
              deniedTools: ["delete_repo"],
            },
          ],
          toolPermissions: {
            mode: "allowAll",
            allowedTools: [],
            deniedTools: [
              "mcp__github__create_issue",
              "mcp__github__delete_repo",
              "mcp__unattached__tool",
              "shell(git push:*)",
            ],
          },
        },
      } as any
    );
    const serverConfig = args.find((arg) =>
      arg.startsWith("mcp_servers.github=")
    );
    assert.ok(serverConfig, JSON.stringify(args));
    const parsed = parse(serverConfig) as {
      mcp_servers: { github: { disabled_tools: string[] } };
    };

    assert.deepStrictEqual(parsed.mcp_servers.github.disabled_tools, [
      "delete_repo",
      "create_issue",
    ]);
    // Codex refuses to start on an override for a server it can't launch.
    assert.ok(!args.some((arg) => arg.includes("mcp_servers.unattached")));
  });

  suite("MCP capability declaration", () => {
    test("declares native per-server filtering for server-owned denials", () => {
      const filtering = new CodexHarnessAdapter().capabilities.mcp
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
          verificationKind: "behavioral-test",
        }
      );
    });
  });

  suite("buildCliSuffix", () => {
    const provider = new CodexHarnessAdapter();

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
      const args = await new CodexHarnessAdapter().buildCliArgs(
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
    const provider = new CodexHarnessAdapter();

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
    const provider = new CodexHarnessAdapter();

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
    const provider = new CodexHarnessAdapter();

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

    test("reads a rejected request's reason from turn.failed on stdout", () => {
      // Captured from codex 0.162.1 with an unknown --model.
      const apiError = JSON.stringify({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          message:
            "The 'no-such-model' model is not supported when using Codex with a ChatGPT account.",
        },
      });
      const stdout = [
        { type: "thread.started", thread_id: "t1" },
        {
          type: "item.completed",
          item: { id: "item_0", type: "error", message: "Model metadata …" },
        },
        { type: "turn.started" },
        { type: "error", message: apiError },
        { type: "turn.failed", error: { message: apiError } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");

      assert.strictEqual(
        provider.extractErrorFromStdout(stdout),
        "The 'no-such-model' model is not supported when using Codex with a ChatGPT account."
      );
      assert.strictEqual(
        provider.extractErrorFromStdout(
          '{"type":"turn.failed","error":{"message":"stream disconnected"}}'
        ),
        "stream disconnected"
      );
      assert.strictEqual(
        provider.extractErrorFromStdout('{"type":"turn.completed"}'),
        undefined
      );
      // A retried stream error is superseded by the turn that completed.
      assert.strictEqual(
        provider.extractErrorFromStdout(
          [
            '{"type":"turn.started"}',
            '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion)"}',
            '{"type":"turn.completed","usage":{}}',
          ].join("\n")
        ),
        undefined
      );
    });
  });
});
