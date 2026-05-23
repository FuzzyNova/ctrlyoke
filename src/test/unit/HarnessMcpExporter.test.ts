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

  test("merges Claude exports and reports skipped remote servers", async () => {
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
        { id: "remote-server", url: "https://example.test/mcp" },
      ],
      HARNESS_IDS.CLAUDE_CLI,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(claudeConfigPath, "utf-8"));
    assert.strictEqual(result.filePath, claudeConfigPath);
    assert.strictEqual(result.exportedCount, 1);
    assert.deepStrictEqual(result.skippedIds, ["remote-server"]);
    assert.strictEqual(document.theme, "dark");
    assert.deepStrictEqual(document.mcpServers.existing, {
      command: "node",
      args: ["existing.js"],
    });
    assert.deepStrictEqual(document.mcpServers["stdio-server"], {
      command: "npx",
      args: ["-y", "@scope/pkg"],
    });
    assert.strictEqual(document.mcpServers["remote-server"], undefined);
  });

  test("merges VS Code exports using stdio entries while preserving unrelated keys", async () => {
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
      ],
      SPECIAL_TARGET_IDS.VSCODE,
      SETTING_SCOPES.WORKSPACE
    );

    const document = JSON.parse(await fs.readFile(vscodeConfigPath, "utf-8"));
    assert.strictEqual(result.filePath, vscodeConfigPath);
    assert.strictEqual(result.exportedCount, 1);
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
  });
});
