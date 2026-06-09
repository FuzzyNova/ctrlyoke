import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import {
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../../types/DashboardConstants";
import { HarnessMcpExporter } from "../../utils/HarnessMcpExporter";

suite("HarnessMcpExporter", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let userHome: string;
  let appDataRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalAppData: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-mcp-exporter-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    userHome = path.join(tempRoot, "user-home");
    appDataRoot = path.join(userHome, "AppData", "Roaming");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(appDataRoot, { recursive: true });

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalAppData = process.env.APPDATA;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    process.env.APPDATA = appDataRoot;
  });

  teardown(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("merges Claude exports and preserves remote entries", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const claudeConfigPath = path.join(workspaceRoot, ".mcp.json");

    await fs.writeFile(
      claudeConfigPath,
      JSON.stringify(
        {
          theme: "dark",
          mcpServers: {
            existing: { command: "node", args: ["existing.js"] },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await exporter.export(
      [
        { id: "stdio-server", command: "npx", args: ["-y", "@scope/pkg"] },
        {
          id: "remote-server",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
      HARNESS_IDS.CLAUDE_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(claudeConfigPath, "utf-8"));
    assert.strictEqual(result.filePath, claudeConfigPath);
    assert.strictEqual(result.exportedCount, 2);
    assert.deepStrictEqual(result.skippedIds, []);
    assert.strictEqual(document.theme, "dark");
    assert.deepStrictEqual(document.mcpServers.existing, {
      command: "node",
      args: ["existing.js"],
    });
    assert.deepStrictEqual(document.mcpServers["stdio-server"], {
      command: "npx",
      args: ["-y", "@scope/pkg"],
    });
    assert.deepStrictEqual(document.mcpServers["remote-server"], {
      type: "http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer token" },
    });
  });

  test("merges VS Code exports while preserving unrelated keys", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const vscodeConfigPath = path.join(workspaceRoot, ".vscode", "mcp.json");

    await fs.mkdir(path.dirname(vscodeConfigPath), { recursive: true });
    await fs.writeFile(
      vscodeConfigPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          servers: {
            existing: { type: "stdio", command: "node", args: ["existing.js"] },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await exporter.export(
      [
        {
          id: "stdio-server",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "token" },
        },
        {
          id: "remote-server",
          url: "https://example.test/mcp",
          transport: "sse",
        },
      ],
      SPECIAL_TARGET_IDS.VSCODE,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(vscodeConfigPath, "utf-8"));
    assert.strictEqual(result.filePath, vscodeConfigPath);
    assert.strictEqual(result.exportedCount, 2);
    assert.deepStrictEqual(result.skippedIds, []);
    assert.strictEqual(document.schemaVersion, 1);
    assert.deepStrictEqual(document.servers.existing, {
      type: "stdio",
      command: "node",
      args: ["existing.js"],
    });
    assert.deepStrictEqual(document.servers["stdio-server"], {
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "token" },
    });
    assert.deepStrictEqual(document.servers["remote-server"], {
      type: "sse",
      url: "https://example.test/mcp",
    });
  });

  test("writes Copilot MCP config using the documented schema", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const result = await exporter.export(
      [
        { id: "stdio-server", command: "node", args: ["server.js"] },
        { id: "remote-server", url: "https://example.test/mcp" },
      ],
      HARNESS_IDS.COPILOT_CLI,
      SETTING_SCOPES.USER
    );

    const document = JSON.parse(await fs.readFile(result.filePath, "utf-8"));
    assert.ok(result.filePath.endsWith(path.join(".copilot", "mcp-config.json")));
    assert.deepStrictEqual(document.mcpServers["stdio-server"], {
      type: "local",
      command: "node",
      args: ["server.js"],
      tools: ["*"],
    });
    assert.deepStrictEqual(document.mcpServers["remote-server"], {
      type: "http",
      url: "https://example.test/mcp",
      tools: ["*"],
    });
  });

  test("writes OpenCode MCP config under the mcp key", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const result = await exporter.export(
      [
        {
          id: "stdio-server",
          command: "uvx",
          args: ["my-server"],
          env: { TOKEN: "abc" },
        },
        {
          id: "remote-server",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
      HARNESS_IDS.OPENCODE_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(result.filePath, "utf-8"));
    assert.strictEqual(result.filePath, path.join(workspaceRoot, "opencode.json"));
    assert.deepStrictEqual(document.mcp["stdio-server"], {
      type: "local",
      command: ["uvx", "my-server"],
      environment: { TOKEN: "abc" },
    });
    assert.deepStrictEqual(document.mcp["remote-server"], {
      type: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer token" },
    });
  });

  test("writes Qwen MCP config with httpUrl for streamable-http remotes", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const result = await exporter.export(
      [
        { id: "stdio-server", command: "node", args: ["server.js"] },
        { id: "remote-server", url: "https://example.test/mcp" },
      ],
      HARNESS_IDS.QWEN_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(result.filePath, "utf-8"));
    assert.strictEqual(
      result.filePath,
      path.join(workspaceRoot, ".qwen", "settings.json")
    );
    assert.deepStrictEqual(document.mcpServers["stdio-server"], {
      command: "node",
      args: ["server.js"],
    });
    assert.deepStrictEqual(document.mcpServers["remote-server"], {
      httpUrl: "https://example.test/mcp",
    });
  });

  test("writes Codex MCP config in TOML form", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const codexConfigPath = path.join(workspaceRoot, ".codex", "config.toml");
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(codexConfigPath, 'model = "gpt-5"\n', "utf-8");

    const result = await exporter.export(
      [
        {
          id: "stdio-server",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret" },
        },
        {
          id: "remote-server",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
      HARNESS_IDS.CODEX_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const text = await fs.readFile(result.filePath, "utf-8");
    assert.strictEqual(result.filePath, codexConfigPath);
    assert.ok(text.includes('model = "gpt-5"'));
    assert.ok(text.includes('[mcp_servers."stdio-server"]'));
    assert.ok(text.includes('command = "node"'));
    assert.ok(text.includes('args = ["server.js"]'));
    assert.ok(text.includes('env = { "API_KEY" = "secret" }'));
    assert.ok(text.includes('[mcp_servers."remote-server"]'));
    assert.ok(text.includes('url = "https://example.test/mcp"'));
    assert.ok(
      text.includes('headers = { "Authorization" = "Bearer token" }')
    );
  });

  test("removes a single exported OpenCode MCP server", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const openCodeConfigPath = path.join(workspaceRoot, "opencode.json");

    await fs.writeFile(
      openCodeConfigPath,
      JSON.stringify(
        {
          mcp: {
            existing: {
              type: "local",
              command: ["node", "existing.js"],
            },
            removable: {
              type: "local",
              command: ["node", "remove-me.js"],
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await exporter.remove(
      ["removable"],
      HARNESS_IDS.OPENCODE_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(openCodeConfigPath, "utf-8"));
    assert.strictEqual(result.filePath, openCodeConfigPath);
    assert.strictEqual(result.removedCount, 1);
    assert.deepStrictEqual(document.mcp.existing, {
      type: "local",
      command: ["node", "existing.js"],
    });
    assert.strictEqual(document.mcp.removable, undefined);
  });

  test("removes a Codex MCP server section without touching other config", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const codexConfigPath = path.join(workspaceRoot, ".codex", "config.toml");
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(
      codexConfigPath,
      [
        'model = "gpt-5"',
        "",
        '[mcp_servers."keep-me"]',
        'command = "node"',
        'args = ["keep.js"]',
        "",
        '[mcp_servers."remove-me"]',
        'command = "node"',
        'args = ["remove.js"]',
        "",
      ].join("\n"),
      "utf-8"
    );

    const result = await exporter.remove(
      ["remove-me"],
      HARNESS_IDS.CODEX_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const text = await fs.readFile(codexConfigPath, "utf-8");
    assert.strictEqual(result.filePath, codexConfigPath);
    assert.strictEqual(result.removedCount, 1);
    assert.ok(text.includes('model = "gpt-5"'));
    assert.ok(text.includes('[mcp_servers."keep-me"]'));
    assert.ok(!text.includes('[mcp_servers."remove-me"]'));
  });
});
