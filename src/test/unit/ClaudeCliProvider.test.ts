import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { writeStatuslinePackage } from "../helpers/statuslinePackage";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  STATUS_LINE_HARNESS_IDS,
} from "../../types/DashboardConstants";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return {
    getAll: () => data,
    set: async (settingPath, value) => {
      const before = JSON.parse(
        JSON.stringify(data)
      ) as PartialCtrlYokeSettings;
      const parts = settingPath.split(".");
      let current = data as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        if (!current[part] || typeof current[part] !== "object") {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
      return before;
    },
  };
}

function createProperties(
  mcpServers: ResolvedProperties["mcpServers"] = ["ctrlyoke"]
): ResolvedProperties {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    model: "test-model",
    executionMode: EXECUTION_MODES.HEADLESS,
    resumeSession: false,
    mcpServers,
    hooks: null,
    toolPermissions: null,
  };
}

suite("ClaudeCliProvider", () => {
  let tempHome: string;
  let workspaceRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  setup(async () => {
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "claude-provider-home-")
    );
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "claude-provider-workspace-")
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  teardown(async () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("retains hook and statusline artifacts for reusable PTY sessions", () => {
    const provider = new ClaudeCliProvider();

    assert.strictEqual(provider.shouldRetainWorkflowArtifactsForReuse(), true);
  });

  test("strips inherited Claude Code session markers from interactive spawn env", () => {
    const provider = new ClaudeCliProvider();
    const markerVars = [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
    ] as const;
    const originalValues = markerVars.map((name) => process.env[name]);

    try {
      for (const name of markerVars) {
        process.env[name] = "test-value";
      }
      process.env.UNRELATED_VAR = "keep-me";

      const env = provider.getInteractiveSpawnEnv();

      for (const name of markerVars) {
        assert.strictEqual(env[name], undefined, `${name} should be stripped`);
      }
      assert.strictEqual(env.UNRELATED_VAR, "keep-me");
    } finally {
      markerVars.forEach((name, index) => {
        const original = originalValues[index];
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
      delete process.env.UNRELATED_VAR;
    }
  });

  test("matches recoverable session errors from stderr text or a process result", () => {
    const provider = new ClaudeCliProvider();

    for (const message of [
      "--resume requires a valid session ID",
      "Session IDs must be in UUID format",
      "No conversation found with session ID abc",
    ]) {
      assert.strictEqual(provider.isRecoverableSessionError(message), true);
    }
    assert.strictEqual(
      provider.isRecoverableSessionError({
        stderr: "No conversation found with session ID abc",
      }),
      true
    );
    assert.strictEqual(
      provider.isRecoverableSessionError(
        new Error("No conversation found with session ID abc")
      ),
      true
    );

    assert.strictEqual(
      provider.isRecoverableSessionError("Claude authentication failed"),
      false
    );
  });

  const mcpServerCases: Array<
    [string, NonNullable<ResolvedProperties["mcpServers"]>]
  > = [
    ["string form", ["ctrlyoke"]],
    ["object form", [{ id: "ctrlyoke" }]],
    [
      "object form with denied tools",
      [{ id: "ctrlyoke", deniedTools: ["append_step"] }],
    ],
  ];
  for (const [description, mcpServers] of mcpServerCases) {
    test(`auto-approves ctrlyoke MCP tools with ${description}`, async () => {
      const provider = new ClaudeCliProvider();
      const preparation = await provider.planCliArgs(
        { prompt: "use the queue" } as PromptStep,
        false,
        process.cwd(),
        process.cwd(),
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: createProperties(mcpServers),
        }
      );

      const allowedToolsIndex = preparation.cliArgs.indexOf("--allowed-tools");
      assert.strictEqual(
        preparation.cliArgs[allowedToolsIndex + 1],
        "mcp__ctrlyoke"
      );
    });
  }

  test("normalizes MCP server IDs in auto-approved tool rules", async () => {
    const provider = new ClaudeCliProvider();
    const preparation = await provider.planCliArgs(
      { prompt: "use context7" } as PromptStep,
      false,
      process.cwd(),
      process.cwd(),
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        resolvedProperties: createProperties([
          {
            id: "io.github.upstash/context7",
            command: "node",
            autoApprove: ["resolve-library-id"],
          },
        ]),
      }
    );

    assert.ok(
      preparation.cliArgs.some(
        (arg, index) =>
          arg === "--allowed-tools" &&
          preparation.cliArgs[index + 1] ===
            "mcp__io_github_upstash_context7__resolve-library-id"
      )
    );
  });

  test("uses Claude statusline tracking independently of usageTracking", async () => {
    const userSettings = makeBackend({
      usageTracking: { enabled: false },
      permissions: {},
      statusLine: {
        byHarness: {
          "claude-cli": {
            enabled: true,
            customCommand: "node user-statusline.js",
            useCtrlyokeStyle: false,
          },
        },
      },
    });
    configService.setUserBackend(userSettings);
    const settingsPath = path.join(tempHome, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const extensionPath = await writeStatuslinePackage(
      path.join(tempHome, "extension")
    );
    const provider = new ClaudeCliProvider();

    await provider.buildCliArgs(
      {} as never,
      false,
      extensionPath,
      workspaceRoot,
      undefined,
      {
        promptIndex: 0,
        allPrompts: [],
        workingFilePath: path.join(workspaceRoot, "workflow.md"),
      }
    );

    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_CLAUDE_STATUSLINE_FORWARD,
      undefined
    );
    assert.strictEqual(
      provider.getHeadlessSpawnEnv()
        .CTRLYOKE_CLAUDE_STATUSLINE_USE_CTRLYOKE_STYLE,
      undefined
    );
    assert.strictEqual(
      provider.getHeadlessSpawnEnv().CTRLYOKE_STATUSLINE_WORKSPACE_ROOT,
      workspaceRoot
    );
    assert.strictEqual(
      provider.consumeStatuslineInstallResult()?.kind,
      "written"
    );
    await provider.cleanupWorkspaceArtifacts(workspaceRoot);
    assert.ok((await fs.readFile(settingsPath, "utf8")).includes("statusLine"));
    assert.strictEqual(
      configService.get("statusLine").byHarness[STATUS_LINE_HARNESS_IDS.CLAUDE]
        .customCommand,
      "node user-statusline.js"
    );
  });
});
