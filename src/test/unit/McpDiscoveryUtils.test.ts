import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { safeDiscoverLocalMcpServers } from "../../utils/McpDiscoveryUtils";

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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-mcp-discovery-"));
    workspaceRoot = path.join(tempRoot, "workspace");
    userHome = path.join(tempRoot, "user-home");
    appDataRoot = path.join(userHome, "AppData", "Roaming");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(appDataRoot, { recursive: true });
    await fs.mkdir(path.join(userHome, ".copilot"), { recursive: true });
    await fs.mkdir(path.join(userHome, ".codex"), { recursive: true });
    await fs.mkdir(path.join(userHome, ".config", "opencode"), {
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
        '[mcp_servers.cclsp]',
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
        source: "claude-user",
        path: path.join(userHome, ".claude.json"),
        command: "node",
        args: ["claude-server.js"],
      },
      {
        source: "codex-user",
        path: path.join(userHome, ".codex", "config.toml"),
        command: "node",
        args: ["codex-server.js"],
      },
      {
        source: "copilot-user",
        path: path.join(userHome, ".copilot", "mcp-config.json"),
        command: "node",
        args: ["copilot-server.js"],
      },
      {
        source: "opencode-user",
        path: path.join(userHome, ".config", "opencode", "opencode.json"),
        command: "node",
        args: ["opencode-server.js"],
      },
    ]);
  });
});
