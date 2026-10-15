import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  getMcpLocalSource,
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../../types/DashboardConstants";
import {
  findTomlTableHeaderLines,
  getTomlMcpServerSectionId,
  safeDiscoverLocalMcpServers,
} from "../../utils/McpDiscoveryUtils";

const REMOTE_SERVER_ID = "remote";

suite("McpDiscoveryUtils", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let userHome: string;
  let appDataRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalAppData: string | undefined;
  let originalCodeXHome: string | undefined;
  let originalOpenCodeConfig: string | undefined;
  let originalOpenCodeConfigDir: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-mcp-discovery-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    userHome = path.join(tempRoot, "user-home");
    appDataRoot = path.join(userHome, "AppData", "Roaming");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, ".codex"), { recursive: true });
    await fs.mkdir(appDataRoot, { recursive: true });
    await fs.mkdir(path.join(userHome, ".copilot"), { recursive: true });
    await fs.mkdir(path.join(userHome, ".codex"), { recursive: true });
    await fs.mkdir(path.join(userHome, ".config", "opencode"), {
      recursive: true,
    });
    await fs.mkdir(path.join(userHome, ".gemini", "config"), {
      recursive: true,
    });

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalAppData = process.env.APPDATA;
    originalCodeXHome = process.env.CODEX_HOME;
    originalOpenCodeConfig = process.env.OPENCODE_CONFIG;
    originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    process.env.APPDATA = appDataRoot;
    delete process.env.CODEX_HOME;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_DIR;
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

    if (originalCodeXHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodeXHome;
    }

    if (originalOpenCodeConfig === undefined) {
      delete process.env.OPENCODE_CONFIG;
    } else {
      process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
    }

    if (originalOpenCodeConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("keeps duplicate server ids when they come from different harness config files", async () => {
    await fs.writeFile(
      path.join(userHome, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            cclsp: {
              command: "node",
              args: ["claude-server.js"],
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await fs.writeFile(
      path.join(userHome, ".copilot", "mcp-config.json"),
      JSON.stringify(
        {
          mcpServers: {
            cclsp: {
              type: "local",
              command: "node",
              args: ["copilot-server.js"],
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await fs.writeFile(
      path.join(userHome, ".codex", "config.toml"),
      [
        "[mcp_servers.cclsp]",
        'command = "node"',
        'args = ["codex-server.js"]',
        "",
      ].join("\n"),
      "utf-8"
    );

    await fs.writeFile(
      path.join(userHome, ".config", "opencode", "opencode.json"),
      JSON.stringify(
        {
          mcp: {
            cclsp: {
              type: "local",
              command: ["node", "opencode-server.js"],
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await fs.writeFile(
      path.join(userHome, ".gemini", "config", "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            cclsp: {
              command: "node",
              args: ["antigravity-server.js"],
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    assert.strictEqual(result.error, undefined);

    const cclspEntries = result.servers
      .filter((entry) => entry.id === "cclsp")
      .map((entry) => ({
        source: entry.source,
        path: entry.path,
        command: entry.command,
        args: entry.args ?? [],
      }))
      .sort((a, b) => a.source.localeCompare(b.source));

    assert.deepStrictEqual(cclspEntries, [
      {
        source: getMcpLocalSource(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          SETTING_SCOPES.USER
        ),
        path: path.join(userHome, ".gemini", "config", "mcp_config.json"),
        command: "node",
        args: ["antigravity-server.js"],
      },
      {
        source: getMcpLocalSource(HARNESS_IDS.CLAUDE_CLI, SETTING_SCOPES.USER),
        path: path.join(userHome, ".claude.json"),
        command: "node",
        args: ["claude-server.js"],
      },
      {
        source: getMcpLocalSource(HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.USER),
        path: path.join(userHome, ".codex", "config.toml"),
        command: "node",
        args: ["codex-server.js"],
      },
      {
        source: getMcpLocalSource(HARNESS_IDS.COPILOT_CLI, SETTING_SCOPES.USER),
        path: path.join(userHome, ".copilot", "mcp-config.json"),
        command: "node",
        args: ["copilot-server.js"],
      },
      {
        source: getMcpLocalSource(
          HARNESS_IDS.OPENCODE_CLI,
          SETTING_SCOPES.USER
        ),
        path: path.join(userHome, ".config", "opencode", "opencode.json"),
        command: "node",
        args: ["opencode-server.js"],
      },
    ]);
  });

  test("discovers Antigravity workspace MCP remotes from serverUrl", async () => {
    const antigravityConfigPath = path.join(
      workspaceRoot,
      ".agents",
      "mcp_config.json"
    );
    await fs.mkdir(path.dirname(antigravityConfigPath), { recursive: true });
    await fs.writeFile(
      antigravityConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            remote: {
              serverUrl: "https://example.test/mcp",
              headers: { Authorization: "Bearer token" },
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    assert.strictEqual(result.error, undefined);

    const entry = result.servers.find(
      (server) =>
        server.source ===
          getMcpLocalSource(
            HARNESS_IDS.ANTIGRAVITY_CLI,
            SETTING_SCOPES.WORKSPACE
          ) && server.id === REMOTE_SERVER_ID
    );
    assert.deepStrictEqual(entry, {
      id: REMOTE_SERVER_ID,
      source: getMcpLocalSource(
        HARNESS_IDS.ANTIGRAVITY_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      path: antigravityConfigPath,
      url: "https://example.test/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer token" },
    });
  });

  test("decodes Codex TOML Windows path escapes once", async () => {
    const configPath = path.join(workspaceRoot, ".codex", "config.toml");
    await fs.writeFile(
      configPath,
      String.raw`[mcp_servers.winsrv]
command = "C:\\tools\\node.exe"
args = ["C:\\new\\server.js"]
`,
      "utf-8"
    );

    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    const entry = result.servers.find(
      (server) =>
        server.id === "winsrv" &&
        server.source ===
          getMcpLocalSource(HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.WORKSPACE)
    );

    assert.strictEqual(entry?.command, String.raw`C:\tools\node.exe`);
    assert.deepStrictEqual(entry?.args, [String.raw`C:\new\server.js`]);
  });

  test("discovers Codex TOML env sub-table values", async () => {
    await fs.writeFile(
      path.join(workspaceRoot, ".codex", "config.toml"),
      `[mcp_servers.ctx7]\ncommand = "npx"\n[mcp_servers.ctx7.env]\nAPI_KEY = "abc"\n`,
      "utf-8"
    );

    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    const entry = result.servers.find(
      (server) =>
        server.id === "ctx7" &&
        server.source ===
          getMcpLocalSource(HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.WORKSPACE)
    );

    assert.deepStrictEqual(entry?.env, { API_KEY: "abc" });
  });

  test("discovers VS Code MCP servers from JSONC with trailing commas", async () => {
    const configPath = path.join(workspaceRoot, ".vscode", "mcp.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      '{ "servers": { "gh": { "command": "npx", "args": ["-y", "server-github",], }, }, }',
      "utf-8"
    );

    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    const entry = result.servers.find(
      (server) =>
        server.id === "gh" &&
        server.source ===
          getMcpLocalSource(SPECIAL_TARGET_IDS.VSCODE, SETTING_SCOPES.WORKSPACE)
    );

    assert.strictEqual(entry?.command, "npx");
    assert.deepStrictEqual(entry?.args, ["-y", "server-github"]);
  });

  test("maps every Codex server header shape to its owning server id", () => {
    const cases: Array<[string, string | null]> = [
      ["mcp_servers.foo", "foo"],
      ["mcp_servers.foo.env", "foo"],
      ["mcp_servers.foo.http_headers", "foo"],
      ["mcp_servers.foo.tools.search", "foo"],
      ['mcp_servers."foo.bar".env', "foo.bar"],
      ["mcp_servers.'lit'.tools", "lit"],
      ["mcp_servers . foo . env", "foo"],
      ['"mcp_servers".foo', "foo"],
      ["mcp_servers", null],
      ["profiles.foo", null],
      ['mcp_servers."unterminated', null],
    ];
    for (const [header, expected] of cases) {
      assert.strictEqual(getTomlMcpServerSectionId(header), expected, header);
    }
  });

  test("finds only real TOML headers, not lookalikes inside strings or arrays", () => {
    const lines = [
      "[a] # comment",
      "x = [",
      '  ["not-a-header"],',
      "]",
      "[[b]]",
      'y = """',
      "[not.a.header]",
      '"""',
      "[c]",
    ];
    assert.deepStrictEqual(findTomlTableHeaderLines(lines), [0, 4, 8]);
  });

  test("discovers a Codex server whose tools subtable follows its env table", async () => {
    const configPath = path.join(workspaceRoot, ".codex", "config.toml");
    await fs.writeFile(
      configPath,
      [
        "[mcp_servers.foo] # local",
        'command = "node"',
        "[mcp_servers.foo.env]",
        'TOKEN = "t"',
        "[mcp_servers.foo.tools.search]",
        'command = "ignored"',
      ].join("\n"),
      "utf8"
    );
    const result = await safeDiscoverLocalMcpServers(workspaceRoot);
    const foo = result.servers.find(
      (server) =>
        server.id === "foo" &&
        server.source ===
          getMcpLocalSource(HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.WORKSPACE)
    );
    assert.ok(foo, JSON.stringify(result.servers));
    assert.strictEqual(foo.command, "node");
    assert.deepStrictEqual(foo.env, { TOKEN: "t" });
  });
});
