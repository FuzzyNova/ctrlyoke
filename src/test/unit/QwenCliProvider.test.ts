import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";
import { SettingsJsonHooksTracker } from "../../core/harness/shared/SettingsJsonHooksTracker";
import { QwenTrustedHooksTracker } from "../../core/harness/shared/QwenTrustedHooksTracker";
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

suite("QwenCliProvider", () => {
  suite("hook registration", () => {
    test("registers workspace hooks with the hooks tracker lock owner", async () => {
      const workspaceRoot = await createTempWorkspace();
      const trustedHooksPath = path.join(
        workspaceRoot,
        "global",
        "trusted_hooks.json"
      );
      SettingsJsonHooksTracker.resetAll();
      QwenTrustedHooksTracker.resetAll();
      const provider = new QwenCliProvider(
        SettingsJsonHooksTracker.getInstance("qwen"),
        QwenTrustedHooksTracker.getInstance({ trustedHooksPath })
      );

      try {
        await provider.buildNotificationHookArgs(
          "C:\\extension",
          workspaceRoot,
          0,
          path.join(workspaceRoot, "workflow.yaml"),
          undefined,
          ["notification"]
        );

        const settings = JSON.parse(
          await fs.readFile(
            path.join(workspaceRoot, ".qwen", "settings.json"),
            "utf-8"
          )
        ) as { hooks?: Record<string, unknown[]> };
        assert.ok(settings.hooks?.Notification);
        assert.ok(
          (
            JSON.parse(await fs.readFile(trustedHooksPath, "utf-8")) as Record<
              string,
              string[]
            >
          )[workspaceRoot]
        );
        assert.ok(
          (
            JSON.parse(await fs.readFile(trustedHooksPath, "utf-8")) as Record<
              string,
              string[]
            >
          )[workspaceRoot].some((key) => key.includes("ctrlyoke-qwen-hook.js"))
        );
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          path.join(workspaceRoot, "workflow.yaml")
        );
        SettingsJsonHooksTracker.resetAll();
        QwenTrustedHooksTracker.resetAll();
        await removeTempWorkspace(workspaceRoot);
      }
    });
  });

  suite("MCP configuration", () => {
    test("no MCP input returns no inline argument and does not mutate the workspace", async () => {
      const provider = new QwenCliProvider();
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
      const provider = new QwenCliProvider();
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

      const args = await provider.getMcpConfigArgs(
        "C:\\extension\\out\\mcp-server.js",
        workspaceRoot,
        workingFilePath,
        {
          CTRLYOKE_MAX_QUEUE_SIZE: "10",
          CTRLYOKE_DIAGNOSTIC_LOGS: "true",
          CTRLYOKE_API_KEY: "dynamic-secret",
        },
        [localServer, remoteServer]
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
              CTRLYOKE_MAX_QUEUE_SIZE: "10",
              CTRLYOKE_DIAGNOSTIC_LOGS: "true",
              CTRLYOKE_API_KEY: "dynamic-secret",
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
            type: "sse",
            headers: { Authorization: "Bearer remote-secret" },
          },
        },
      });
    });

    test("provider instances keep independent inline MCP argument values", async () => {
      const workspaceRoot = await createTempWorkspace();
      const firstProvider = new QwenCliProvider();
      const secondProvider = new QwenCliProvider();

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
      const provider = new QwenCliProvider();
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
      const provider = new QwenCliProvider();
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
    const provider = new QwenCliProvider();

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
    const provider = new QwenCliProvider();

    test("does not add --output-format/--input-format (interactive mode never hits the non-interactive gate)", () => {
      const result = provider.buildInteractiveArgs(["--base"], "do the thing");
      assert.deepStrictEqual(result, ["-i", "do the thing", "--base"]);
    });
  });
});
