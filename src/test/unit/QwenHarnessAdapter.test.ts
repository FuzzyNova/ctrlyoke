import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { QwenHarnessAdapter } from "../../core/harness/qwen/QwenHarnessAdapter";
import { TEMP_FILE_CATEGORIES } from "../../types/DashboardConstants";
import { Log } from "../../utils/Log";
import type {
  McpServerConfig,
  PromptStep,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../utils/PropertyResolver";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-qwen-provider-"));
}

async function removeTempWorkspace(workspaceRoot: string): Promise<void> {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}

function parseMcpConfig(args: string[]): Record<string, unknown> {
  assert.deepStrictEqual(args.slice(0, 1), ["--mcp-config"]);
  assert.strictEqual(args.length, 2);
  return JSON.parse(args[1]) as Record<string, unknown>;
}

// ============================================================================

suite("QwenHarnessAdapter", () => {
  test("recognizes Qwen's missing saved session message from stdout", () => {
    const provider = new QwenHarnessAdapter();

    assert.strictEqual(
      provider.isRecoverableSessionError({
        stdout:
          'No saved session found with title "00000000-0000-0000-0000-000000000000".',
      }),
      true
    );
    assert.strictEqual(
      provider.isRecoverableSessionError({
        stderr: "invalid session: session not found",
      }),
      true
    );
    assert.strictEqual(
      provider.isRecoverableSessionError({ stdout: "Another Qwen error" }),
      false
    );
  });

  test("formats file references with spaces for the current platform", () => {
    const provider = new QwenHarnessAdapter();
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );

    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      assert.strictEqual(
        provider.formatFileReference('"docs/Design Notes.md"'),
        "@docs/Design\\ Notes.md"
      );
      assert.strictEqual(
        provider.formatFileReference("docs/readme.md"),
        "@docs/readme.md"
      );

      Object.defineProperty(process, "platform", { value: "win32" });
      assert.strictEqual(
        provider.formatFileReference('"docs/Design Notes.md"'),
        '"docs/Design Notes.md"'
      );
      assert.strictEqual(
        provider.formatFileReference(
          '"C:/Users/test/workspace root/.ctrlyoke/temp/prompt.md"',
          {
            tempFileCategory: TEMP_FILE_CATEGORIES.PROMPT,
          }
        ),
        'Read the file at "C:/Users/test/workspace root/.ctrlyoke/temp/prompt.md" and follow its instructions.'
      );
      assert.strictEqual(
        provider.formatFileReference(
          '"C:/Users/test/workspace root/.ctrlyoke/temp/agent.md"',
          {
            tempFileCategory: TEMP_FILE_CATEGORIES.AGENT,
          }
        ),
        'Read the file at "C:/Users/test/workspace root/.ctrlyoke/temp/agent.md" and follow its instructions.'
      );
      assert.strictEqual(
        provider.formatFileReference(
          '"C:/Users/test/workspace root/.ctrlyoke/temp/skills.md"',
          {
            tempFileCategory: TEMP_FILE_CATEGORIES.SKILLS,
          }
        ),
        'Read the file at "C:/Users/test/workspace root/.ctrlyoke/temp/skills.md" and follow its instructions.'
      );
      assert.strictEqual(
        provider.formatFileReference("docs/readme.md", {
          tempFileCategory: TEMP_FILE_CATEGORIES.PROMPT,
        }),
        "@docs/readme.md"
      );
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  test("converts user hook timeout seconds to native milliseconds", () => {
    const provider = new QwenHarnessAdapter();
    const hooks = (provider as any).buildUserHooksSection([
      { event: "stop", command: "node slow.js", timeoutSec: 2.5 },
    ]);
    assert.strictEqual(hooks.Stop[0].hooks[0].timeout, 2500);
  });

  suite("hook registration", () => {
    /** A provider whose "real" system settings live in the temp workspace. */
    function providerWithSystemSettings(workspaceRoot: string) {
      const basePath = path.join(workspaceRoot, "system", "settings.json");
      return { basePath, provider: new QwenHarnessAdapter(basePath) };
    }

    test("removes orphaned ctrlyoke groups from .qwen/settings.json and keeps user groups", async () => {
      const workspaceRoot = await createTempWorkspace();
      const settingsPath = path.join(workspaceRoot, ".qwen", "settings.json");
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const userGroup = {
        hooks: [{ type: "command", command: "node user-hook.js" }],
      };
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node /old/extension/out/scripts/ctrlyoke-qwen-hook.js old-notifications",
                  },
                ],
              },
              userGroup,
            ],
          },
        })
      );
      const { provider } = providerWithSystemSettings(workspaceRoot);
      const workflowPath = path.join(workspaceRoot, "workflow.yaml");

      try {
        await provider.buildNotificationHookArgs(
          "extension",
          workspaceRoot,
          0,
          workflowPath,
          undefined,
          []
        );

        const settings = JSON.parse(
          await fs.readFile(settingsPath, "utf-8")
        ) as { hooks: { SessionStart: unknown[] } };
        assert.deepStrictEqual(settings.hooks.SessionStart, [userGroup]);
      } finally {
        await provider.cleanupWorkspaceArtifacts(workspaceRoot, workflowPath);
        await removeTempWorkspace(workspaceRoot);
      }
    });

    test("deletes stale-only settings and ctrlyoke gitignore", async () => {
      const workspaceRoot = await createTempWorkspace();
      const settingsDir = path.join(workspaceRoot, ".qwen");
      const settingsPath = path.join(settingsDir, "settings.json");
      const gitignorePath = path.join(settingsDir, ".gitignore");
      await fs.mkdir(settingsDir, { recursive: true });
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "node /old/extension/ctrlyoke-qwen-hook.js old-notifications",
                  },
                ],
              },
            ],
          },
        })
      );
      await fs.writeFile(
        gitignorePath,
        "# ctrlyoke temp files (auto-managed, do not commit)\nsettings.json\n.gitignore\n"
      );
      const { provider } = providerWithSystemSettings(workspaceRoot);
      const workflowPath = path.join(workspaceRoot, "workflow.yaml");

      try {
        await provider.buildNotificationHookArgs(
          "extension",
          workspaceRoot,
          0,
          workflowPath,
          undefined,
          []
        );

        await assert.rejects(fs.access(settingsPath), /ENOENT/);
        await assert.rejects(fs.access(gitignorePath), /ENOENT/);
      } finally {
        await provider.cleanupWorkspaceArtifacts(workspaceRoot, workflowPath);
        await removeTempWorkspace(workspaceRoot);
      }
    });

    test("writes hooks to a per-launch system settings file passed through the environment", async () => {
      const workspaceRoot = await createTempWorkspace();
      const { basePath, provider } = providerWithSystemSettings(workspaceRoot);
      const adminGroup = {
        hooks: [{ type: "command", command: "node admin-audit.js" }],
      };
      await fs.mkdir(path.dirname(basePath), { recursive: true });
      await fs.writeFile(
        basePath,
        `// managed by IT\n${JSON.stringify({
          security: { folderTrust: { enabled: true } },
          hooks: { Stop: [adminGroup] },
        })}`
      );
      const workflowPath = path.join(workspaceRoot, "workflow.yaml");

      try {
        await provider.buildNotificationHookArgs(
          "C:\\extension",
          workspaceRoot,
          0,
          workflowPath,
          [{ event: "stop", command: "node user-stop.js" }],
          ["notification"]
        );

        const settingsPath =
          provider.getInteractiveSpawnEnv().QWEN_CODE_SYSTEM_SETTINGS_PATH;
        assert.ok(settingsPath, "interactive launch gets the settings path");
        assert.strictEqual(
          provider.getHeadlessSpawnEnv().QWEN_CODE_SYSTEM_SETTINGS_PATH,
          settingsPath
        );
        const settings = JSON.parse(
          await fs.readFile(settingsPath, "utf-8")
        ) as {
          security?: unknown;
          hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };
        // The administrator's settings and hooks are kept, ahead of ctrlyoke's.
        assert.deepStrictEqual(settings.security, {
          folderTrust: { enabled: true },
        });
        assert.deepStrictEqual(settings.hooks.Stop[0], adminGroup);
        const stopCommands = settings.hooks.Stop.map(
          (group) => group.hooks[0].command
        );
        assert.ok(
          stopCommands.some((c) => c.includes("ctrlyoke-qwen-hook.js"))
        );
        assert.ok(stopCommands.includes("node user-stop.js"));
        assert.ok(settings.hooks.Notification);
        // Nothing is written to the project settings Qwen gates.
        await assert.rejects(
          fs.access(path.join(workspaceRoot, ".qwen", "settings.json")),
          /ENOENT/
        );
        assert.ok(
          provider
            .getAdditionalCleanupFilePaths(workspaceRoot)
            .includes(settingsPath)
        );

        await provider.cleanupWorkspaceArtifacts(workspaceRoot, workflowPath);
        await assert.rejects(fs.access(settingsPath), /ENOENT/);
        assert.strictEqual(
          provider.getHeadlessSpawnEnv().QWEN_CODE_SYSTEM_SETTINGS_PATH,
          undefined
        );
      } finally {
        await provider.cleanupWorkspaceArtifacts(workspaceRoot, workflowPath);
        await removeTempWorkspace(workspaceRoot);
      }
    });

    test("passes no settings path to a headless launch without hooks", async () => {
      const workspaceRoot = await createTempWorkspace();
      const { provider } = providerWithSystemSettings(workspaceRoot);
      try {
        const preparation = await provider.planHeadlessUserHookArgs(
          "extension",
          workspaceRoot,
          0,
          undefined,
          undefined,
          []
        );
        assert.ok(
          preparation.mutations.every(
            (mutation) => !mutation.path?.includes("qwen-system-settings")
          )
        );
        assert.strictEqual(
          provider.getHeadlessSpawnEnv().QWEN_CODE_SYSTEM_SETTINGS_PATH,
          undefined
        );
      } finally {
        await removeTempWorkspace(workspaceRoot);
      }
    });

    test("refuses to launch when the real system settings cannot be parsed", async () => {
      const workspaceRoot = await createTempWorkspace();
      const { basePath, provider } = providerWithSystemSettings(workspaceRoot);
      await fs.mkdir(path.dirname(basePath), { recursive: true });
      await fs.writeFile(basePath, "{ not json");
      try {
        await assert.rejects(
          provider.planNotificationHookArgs(
            "extension",
            workspaceRoot,
            0,
            undefined,
            undefined,
            []
          ),
          /Cannot read Qwen system settings/
        );
      } finally {
        await removeTempWorkspace(workspaceRoot);
      }
    });
  });

  suite("MCP configuration", () => {
    test("no MCP input returns no inline argument and does not mutate the workspace", async () => {
      const provider = new QwenHarnessAdapter();
      const workspaceRoot = await createTempWorkspace();

      try {
        assert.strictEqual(
          await provider.getMcpConfigArgs(undefined, workspaceRoot),
          null
        );
        assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
      } finally {
        await removeTempWorkspace(workspaceRoot);
      }
    });

    test("serializes dynamic, local, remote, and environment MCP values using Qwen's settings shape", async () => {
      const provider = new QwenHarnessAdapter();
      const workspaceRoot = "C:\\workspace\\project";
      const workingFilePath = "C:\\workspace\\workflow.yaml";
      const localServer: McpServerConfig = {
        id: "local",
        command: "node",
        args: ["server.js"],
        env: { LOCAL_API_KEY: "local-secret" },
        autoApprove: true,
      };
      const remoteServer: McpServerConfig = {
        id: "remote",
        url: "https://mcp.example.test/sse",
        transport: "sse",
        headers: { Authorization: "Bearer remote-secret" },
      };
      const streamableServer: McpServerConfig = {
        id: "streamable",
        url: "https://mcp.example.test/mcp",
      };

      const args = await provider.getMcpConfigArgs(
        "C:\\extension\\out\\mcp-server.js",
        workspaceRoot,
        workingFilePath,
        {
          CTRLYOKE_MAX_STEPS: "10",
          CTRLYOKE_DIAGNOSTIC_LOGS: "true",
          CTRLYOKE_API_KEY: "dynamic-secret",
        },
        [localServer, remoteServer, streamableServer]
      );

      assert.ok(args);
      assert.deepStrictEqual(parseMcpConfig(args), {
        mcpServers: {
          ctrlyoke: {
            command: "node",
            args: ["C:/extension/out/mcp-server.js"],
            env: {
              CTRLYOKE_WORKSPACE: "C:/workspace/project",
              CTRLYOKE_WORKING_FILE: "C:/workspace/workflow.yaml",
              CTRLYOKE_MAX_STEPS: "10",
              CTRLYOKE_DIAGNOSTIC_LOGS: "true",
              CTRLYOKE_API_KEY: "dynamic-secret",
              CTRLYOKE_EXECUTION_ROOT: "C:/workspace/project",
            },
            trust: true,
          },
          local: {
            command: "node",
            args: ["server.js"],
            env: { LOCAL_API_KEY: "local-secret" },
            trust: true,
          },
          remote: {
            url: "https://mcp.example.test/sse",
            headers: { Authorization: "Bearer remote-secret" },
          },
          streamable: { httpUrl: "https://mcp.example.test/mcp" },
        },
      });
    });

    test("substitutes resolved secret values into process-local MCP config", async () => {
      const provider = new QwenHarnessAdapter();
      const secret = "qwen-test-secret-value";
      const args = await provider.getMcpConfigArgs(
        undefined,
        "C:\\workspace\\project",
        undefined,
        undefined,
        [
          {
            id: "secret-server",
            command: "node",
            env: { API_TOKEN: "prefix-${secret:API_TOKEN}" },
          },
        ],
        undefined,
        { API_TOKEN: secret }
      );

      assert.ok(args);
      const config = parseMcpConfig(args) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      assert.strictEqual(
        config.mcpServers["secret-server"].env.API_TOKEN,
        `prefix-${secret}`
      );
      assert.ok(!JSON.stringify(config).includes("${secret:"));
    });

    test("provider instances keep independent inline MCP argument values", async () => {
      const workspaceRoot = await createTempWorkspace();
      const firstProvider = new QwenHarnessAdapter();
      const secondProvider = new QwenHarnessAdapter();

      try {
        const firstArgs = await firstProvider.getMcpConfigArgs(
          undefined,
          workspaceRoot,
          undefined,
          undefined,
          [{ id: "first", command: "first-server" }]
        );
        const secondArgs = await secondProvider.getMcpConfigArgs(
          undefined,
          workspaceRoot,
          undefined,
          undefined,
          [{ id: "second", command: "second-server" }]
        );

        assert.deepStrictEqual(parseMcpConfig(firstArgs!), {
          mcpServers: { first: { command: "first-server" } },
        });
        assert.deepStrictEqual(parseMcpConfig(secondArgs!), {
          mcpServers: { second: { command: "second-server" } },
        });
        assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
      } finally {
        await removeTempWorkspace(workspaceRoot);
      }
    });
  });

  suite("cleanupWorkspaceArtifacts", () => {
    test("leaves existing Qwen settings, backups, and a missing Qwen directory untouched", async () => {
      const provider = new QwenHarnessAdapter();
      const existingWorkspace = await createTempWorkspace();
      const missingWorkspace = await createTempWorkspace();
      const qwenDirectory = path.join(existingWorkspace, ".qwen");
      const settingsPath = path.join(qwenDirectory, "settings.json");
      const backupPath = path.join(qwenDirectory, "settings.json.orig");
      const settingsContent = JSON.stringify({ hooks: { Stop: [] } });
      const backupContent = "user-owned backup";

      try {
        await fs.mkdir(qwenDirectory);
        await fs.writeFile(settingsPath, settingsContent, "utf-8");
        await fs.writeFile(backupPath, backupContent, "utf-8");

        await provider.cleanupWorkspaceArtifacts(existingWorkspace, "existing");
        await provider.cleanupWorkspaceArtifacts(missingWorkspace, "missing");

        assert.strictEqual(
          await fs.readFile(settingsPath, "utf-8"),
          settingsContent
        );
        assert.strictEqual(
          await fs.readFile(backupPath, "utf-8"),
          backupContent
        );
        await assert.rejects(fs.access(path.join(missingWorkspace, ".qwen")));
      } finally {
        await removeTempWorkspace(existingWorkspace);
        await removeTempWorkspace(missingWorkspace);
      }
    });
  });

  suite("buildCliArgs", () => {
    test("keeps inline MCP as two base tokens and redacts its complete value in trace output", async () => {
      const provider = new QwenHarnessAdapter();
      const workspaceRoot = await createTempWorkspace();
      const traceMessages: string[] = [];
      const originalTrace = Log.trace;
      (Log as unknown as { trace(message: string): void }).trace = (message) =>
        traceMessages.push(message);

      const inlineServer: McpServerConfig = {
        id: "private-server",
        command: "private-server",
        env: { API_KEY: "do-not-log-this" },
      };
      const prompt: PromptStep = { prompt: "do the thing" };
      const allPrompts: WorkflowStep[] = [prompt];
      const resolvedProperties = {
        model: "qwen-test-model",
        resumeSession: false,
        additionalArgs: "--extra value",
        mcpServers: [inlineServer],
      } as ResolvedProperties;

      try {
        const args = await provider.buildCliArgs(
          prompt,
          false,
          "C:\\extension",
          workspaceRoot,
          undefined,
          {
            promptIndex: 0,
            allPrompts,
            resolvedProperties,
            workingFilePath: path.join(workspaceRoot, "workflow.yaml"),
          }
        );

        assert.strictEqual(args[0], "--mcp-config");
        assert.notStrictEqual(args[1], "[REDACTED]");
        assert.strictEqual(args[2], "--model");
        assert.strictEqual(args[4], "--extra");
        assert.strictEqual(args[5], "value");
        assert.ok(
          traceMessages.some((message) =>
            message.includes('Qwen CLI arguments: ["--mcp-config","[REDACTED]"')
          )
        );
        assert.ok(!traceMessages.some((message) => message.includes(args[1])));
        assert.ok(
          !traceMessages.some((message) => message.includes("do-not-log-this"))
        );
      } finally {
        (Log as unknown as { trace: typeof Log.trace }).trace = originalTrace;
        await removeTempWorkspace(workspaceRoot);
      }
    });
  });

  suite("buildHeadlessArgs", () => {
    const provider = new QwenHarnessAdapter();

    test("includes --input-format stream-json alongside --output-format stream-json", () => {
      const result = provider.buildHeadlessArgs(["--base"], "do the thing");
      assert.deepStrictEqual(result, [
        "do the thing",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--base",
      ]);
    });
  });

  suite("buildInteractiveArgs", () => {
    const provider = new QwenHarnessAdapter();

    test("does not add --output-format/--input-format (interactive mode never hits the non-interactive gate)", () => {
      const result = provider.buildInteractiveArgs(["--base"], "do the thing");
      assert.deepStrictEqual(result, ["-i", "do the thing", "--base"]);
    });
  });
});
