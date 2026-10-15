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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-mcp-exporter-"));
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

  const jsoncFixture = `{
\t// VS Code MCP config (JSONC with comments)
\t"servers": {
\t\t/* commented-out server:
\t\t"disabled": { "type": "stdio", "command": "node" },
\t\t*/
\t\t"context7": {
\t\t\t"type": "stdio",
\t\t\t"command": "npx",
\t\t\t"args": ["-y", "@upstash/context7-mcp@latest"],
\t\t\t"gallery": true // gallery flag used by VS Code MCP browser
\t\t},
\t\t"playwright": {
\t\t\t"type": "stdio",
\t\t\t"command": "npx",
\t\t\t"args": ["@playwright/mcp@latest"]
\t\t}
\t}
}`;

  test("export into JSONC file preserves comments and existing servers", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const vscodeConfigPath = path.join(workspaceRoot, ".vscode", "mcp.json");

    await fs.mkdir(path.dirname(vscodeConfigPath), { recursive: true });
    await fs.writeFile(vscodeConfigPath, jsoncFixture, "utf-8");

    const result = await exporter.export(
      [{ id: "new-server", command: "node", args: ["server.js"] }],
      SPECIAL_TARGET_IDS.VSCODE,
      SETTING_SCOPES.WORKSPACE
    );

    const rawText = await fs.readFile(result.filePath, "utf-8");
    assert.strictEqual(result.exportedCount, 1);
    assert.deepStrictEqual(result.skippedIds, []);
    assert.ok(
      rawText.includes("// VS Code MCP config (JSONC with comments)"),
      "top-level comment preserved"
    );
    assert.ok(
      rawText.includes("/* commented-out server:"),
      "block comment preserved"
    );
    assert.ok(
      rawText.includes("// gallery flag used by VS Code MCP browser"),
      "inline comment preserved"
    );
    const document = JSON.parse(
      rawText.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
    );
    assert.deepStrictEqual(document.servers["context7"], {
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@latest"],
      gallery: true,
    });
    assert.deepStrictEqual(document.servers["new-server"], {
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });

  test("delete from JSONC file preserves comments on remaining servers", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const vscodeConfigPath = path.join(workspaceRoot, ".vscode", "mcp.json");

    await fs.mkdir(path.dirname(vscodeConfigPath), { recursive: true });
    await fs.writeFile(vscodeConfigPath, jsoncFixture, "utf-8");

    const result = await exporter.remove(
      ["playwright"],
      SPECIAL_TARGET_IDS.VSCODE,
      SETTING_SCOPES.WORKSPACE,
      vscodeConfigPath
    );

    const rawText = await fs.readFile(result.filePath, "utf-8");
    assert.strictEqual(result.removedCount, 1);
    assert.ok(
      rawText.includes("// VS Code MCP config (JSONC with comments)"),
      "top-level comment preserved after delete"
    );
    assert.ok(
      rawText.includes("/* commented-out server:"),
      "block comment preserved after delete"
    );
    assert.ok(
      rawText.includes("// gallery flag used by VS Code MCP browser"),
      "inline comment preserved after delete"
    );
    assert.ok(!rawText.includes('"playwright"'), "deleted server is gone");
    assert.ok(rawText.includes('"context7"'), "other server still present");
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
    assert.ok(
      result.filePath.endsWith(path.join(".copilot", "mcp-config.json"))
    );
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
    assert.strictEqual(
      result.filePath,
      path.join(workspaceRoot, "opencode.json")
    );
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

  test("writes Antigravity MCP config with serverUrl for remotes", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const result = await exporter.export(
      [
        { id: "stdio-server", command: "node", args: ["server.js"] },
        {
          id: "remote-server",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
      HARNESS_IDS.ANTIGRAVITY_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(result.filePath, "utf-8"));
    assert.strictEqual(
      result.filePath,
      path.join(workspaceRoot, ".agents", "mcp_config.json")
    );
    assert.deepStrictEqual(document.mcpServers["stdio-server"], {
      command: "node",
      args: ["server.js"],
    });
    assert.deepStrictEqual(document.mcpServers["remote-server"], {
      serverUrl: "https://example.test/mcp",
      headers: { Authorization: "Bearer token" },
    });
  });

  test("removes Antigravity MCP servers from the user config path", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const antigravityConfigPath = path.join(
      userHome,
      ".gemini",
      "config",
      "mcp_config.json"
    );

    await fs.mkdir(path.dirname(antigravityConfigPath), { recursive: true });
    await fs.writeFile(
      antigravityConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            keep: { command: "node", args: ["keep.js"] },
            remove: { command: "node", args: ["remove.js"] },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await exporter.remove(
      ["remove"],
      HARNESS_IDS.ANTIGRAVITY_CLI,
      SETTING_SCOPES.USER
    );

    const document = JSON.parse(await fs.readFile(result.filePath, "utf-8"));
    assert.strictEqual(result.filePath, antigravityConfigPath);
    assert.strictEqual(result.removedCount, 1);
    assert.deepStrictEqual(document.mcpServers.keep, {
      command: "node",
      args: ["keep.js"],
    });
    assert.strictEqual(document.mcpServers.remove, undefined);
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
    assert.ok(text.includes('headers = { "Authorization" = "Bearer token" }'));
  });

  test("does not replace config directories when an edit read fails", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const target = path.join(workspaceRoot, ".mcp.json");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "sentinel"), "preserve");

    await assert.rejects(
      exporter.export([{ id: "new", command: "node" }], HARNESS_IDS.CLAUDE_CLI, SETTING_SCOPES.WORKSPACE)
    );
    await assert.rejects(
      exporter.remove(["old"], HARNESS_IDS.CLAUDE_CLI, SETTING_SCOPES.WORKSPACE)
    );
    assert.strictEqual(await fs.readFile(path.join(target, "sentinel"), "utf8"), "preserve");
  });

  test("updates a symlinked JSON config without replacing the link", async function () {
    if (process.platform === "win32") this.skip();
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const target = path.join(workspaceRoot, "real-config.json");
    const link = path.join(workspaceRoot, ".mcp.json");
    await fs.writeFile(target, '{"theme":"dark"}', "utf8");
    await fs.symlink(target, link);

    await exporter.export([{ id: "new", command: "node" }], HARNESS_IDS.CLAUDE_CLI, SETTING_SCOPES.WORKSPACE);
    assert.strictEqual((await fs.lstat(link)).isSymbolicLink(), true);
    assert.strictEqual(JSON.parse(await fs.readFile(target, "utf8")).theme, "dark");
    assert.ok(JSON.parse(await fs.readFile(target, "utf8")).mcpServers.new);
  });

  test("replaces Codex env subtables and preserves commented neighboring headers", async () => {
    const exporter = new HarnessMcpExporter(workspaceRoot);
    const config = path.join(workspaceRoot, ".codex", "config.toml");
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, '[mcp_servers.foo]\ncommand = "old"\n[mcp_servers.foo.env]\nAPI_KEY = "old"\n\n[mcp_servers.a]\ncommand = "a"\n[mcp_servers.bar] # keep this\ncommand = "bar"\n');

    await exporter.export([{ id: "foo", command: "new", env: { API_KEY: "new" } }], HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.WORKSPACE);
    let text = await fs.readFile(config, "utf8");
    assert.strictEqual((text.match(/env\s*=/g) ?? []).length, 1);
    assert.ok(!text.includes("[mcp_servers.foo.env]"));
    assert.ok(text.includes("[mcp_servers.bar] # keep this"));

    await exporter.remove(["foo", "a"], HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.WORKSPACE);
    text = await fs.readFile(config, "utf8");
    assert.ok(!text.includes("[mcp_servers.foo.env]"));
    assert.ok(!text.includes("[mcp_servers.a]"));
    assert.ok(text.includes("[mcp_servers.bar] # keep this"));
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
