import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";

/**
 * Coverage for the Antigravity (agy) MCP wiring. agy auto-discovers a
 * workspace `.agents/mcp_config.json` (a bare `{ mcpServers }` object) and its
 * schema uses `serverUrl` for remote servers with no `type`/`trust` fields —
 * both differences from the Gemini/Qwen `settings.json` shape.
 */
suite("Antigravity MCP", () => {
  suite("entry format (buildSettingsJsonMcpEntries agy options)", () => {
    const userServers: McpServerConfig[] = [
      {
        id: "remote1",
        url: "https://example.com/mcp",
        transport: "sse",
        headers: { A: "1" },
        autoApprove: true,
      },
      { id: "local1", command: "node", args: ["s.js"], env: { E: "1" } },
    ];
    const agyOptions = {
      remoteUrlKey: "serverUrl" as const,
      includeRemoteType: false,
      includeTrust: false,
    };

    test("remote servers use serverUrl with no type/trust, keep headers", () => {
      const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
        undefined,
        "c:/ws",
        undefined,
        undefined,
        userServers,
        agyOptions
      );
      const remote = entries.remote1 as Record<string, unknown>;
      assert.strictEqual(remote.serverUrl, "https://example.com/mcp");
      assert.strictEqual(remote.url, undefined);
      assert.strictEqual(remote.type, undefined);
      assert.strictEqual(remote.trust, undefined);
      assert.deepStrictEqual(remote.headers, { A: "1" });
    });

    test("stdio servers keep command/args/env", () => {
      const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
        undefined,
        "c:/ws",
        undefined,
        undefined,
        userServers,
        agyOptions
      );
      const local = entries.local1 as Record<string, unknown>;
      assert.strictEqual(local.command, "node");
      assert.deepStrictEqual(local.args, ["s.js"]);
      assert.deepStrictEqual(local.env, { E: "1" });
    });

    test("ctrlyoke server omits trust under agy options", () => {
      const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
        "c:/x/out/mcp-server.js",
        "c:/ws",
        undefined,
        undefined,
        undefined,
        agyOptions
      );
      const ctrlyoke = entries.ctrlyoke as Record<string, unknown>;
      assert.strictEqual(ctrlyoke.command, "node");
      assert.strictEqual(ctrlyoke.trust, undefined);
    });

    test("default options are unchanged (Gemini/Qwen url/type/trust)", () => {
      const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
        "c:/x/out/mcp-server.js",
        "c:/ws",
        undefined,
        undefined,
        [
          {
            id: "remote1",
            url: "https://e.com",
            transport: "streamable-http",
            autoApprove: true,
          },
        ]
      );
      assert.strictEqual(
        (entries.ctrlyoke as Record<string, unknown>).trust,
        true
      );
      const remote = entries.remote1 as Record<string, unknown>;
      assert.strictEqual(remote.url, "https://e.com");
      assert.strictEqual(remote.type, "streamable-http");
      assert.strictEqual(remote.trust, true);
    });
  });

  suite("tracker writes .agents/mcp_config.json", () => {
    let tmpDir: string;
    let configPath: string;
    let gitignorePath: string;

    setup(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-mcp-test-"));
      configPath = path.join(tmpDir, ".agents", "mcp_config.json");
      gitignorePath = path.join(tmpDir, ".agents", ".gitignore");
      SettingsJsonMcpTracker.resetAll();
    });

    teardown(async () => {
      SettingsJsonMcpTracker.resetAll();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function agyTracker(): SettingsJsonMcpTracker {
      return SettingsJsonMcpTracker.getInstance("antigravity", {
        projectConfigPath: (ws) => path.join(ws, ".agents", "mcp_config.json"),
        userConfigPath: () =>
          path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
      });
    }

    test("registers a bare mcpServers object at .agents/mcp_config.json", async () => {
      const tracker = agyTracker();
      await tracker.registerServers("wf-1", tmpDir, {
        ctrlyoke: { command: "node", args: ["server.js"] },
      });

      const written = JSON.parse(await fs.readFile(configPath, "utf-8"));
      assert.deepStrictEqual(written, {
        mcpServers: { ctrlyoke: { command: "node", args: ["server.js"] } },
      });
    });

    test("removes the file it created on unregister", async () => {
      const tracker = agyTracker();
      await tracker.registerServers("wf-1", tmpDir, {
        ctrlyoke: { command: "node", args: ["server.js"] },
      });
      await tracker.unregisterWorkflow("wf-1", tmpDir);
      await assert.rejects(fs.access(configPath), /ENOENT/);
      await assert.rejects(fs.access(gitignorePath), /ENOENT/);
    });

    test("creates a self-ignoring .gitignore for a fresh config", async () => {
      const tracker = agyTracker();
      await tracker.registerServers("wf-1", tmpDir, {
        ctrlyoke: { command: "node", args: ["server.js"] },
      });

      const content = await fs.readFile(gitignorePath, "utf-8");
      assert.strictEqual(
        content,
        [
          "# ctrlyoke temp files (auto-managed, do not commit)",
          "mcp_config.json",
          ".gitignore",
          "",
        ].join("\n")
      );
    });

    test("preserves a user-owned .gitignore", async () => {
      const userGitignore = "# user rules\n*.log\n";
      await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
      await fs.writeFile(gitignorePath, userGitignore, "utf-8");

      const tracker = agyTracker();
      await tracker.registerServers("wf-1", tmpDir, {
        ctrlyoke: { command: "node", args: ["server.js"] },
      });
      await tracker.unregisterWorkflow("wf-1", tmpDir);

      assert.strictEqual(
        await fs.readFile(gitignorePath, "utf-8"),
        userGitignore
      );
    });

    test("removes a server registered by each step of the same workflow", async () => {
      const tracker = agyTracker();
      const servers = {
        ctrlyoke: { command: "node", args: ["server.js"] },
      };

      await tracker.registerServers("wf-1", tmpDir, servers);
      await tracker.registerServers("wf-1", tmpDir, servers);
      await tracker.unregisterWorkflow("wf-1", tmpDir);

      await assert.rejects(fs.access(configPath), /ENOENT/);
    });

    test("preserves existing MCP servers while removing ctrlyoke's server", async () => {
      const userConfig = {
        mcpServers: {
          existing: { command: "node", args: ["existing-server.js"] },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(userConfig), "utf-8");

      const tracker = agyTracker();
      await tracker.registerServers("wf-1", tmpDir, {
        ctrlyoke: { command: "node", args: ["server.js"] },
      });

      const merged = JSON.parse(await fs.readFile(configPath, "utf-8"));
      assert.deepStrictEqual(merged, {
        mcpServers: {
          ...userConfig.mcpServers,
          ctrlyoke: { command: "node", args: ["server.js"] },
        },
      });

      await tracker.unregisterWorkflow("wf-1", tmpDir);

      const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
      assert.deepStrictEqual(restored, userConfig);
    });
  });
});
