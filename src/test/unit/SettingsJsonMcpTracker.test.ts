import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SettingsJsonMcpTracker } from "../../core/harness/shared/SettingsJsonMcpTracker";

suite("SettingsJsonMcpTracker", () => {
  let tmpDir: string;
  let settingsDir: string;
  let settingsPath: string;

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tracker-test-"));
    settingsDir = path.join(tmpDir, ".qwen");
    settingsPath = path.join(settingsDir, "settings.json");
    SettingsJsonMcpTracker.resetAll();
  });

  teardown(async () => {
    SettingsJsonMcpTracker.resetAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should remove settings.json when ctrlyoke created it for MCP", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerServers("wf-1", tmpDir, {
      ctrlyoke: { command: "node", args: ["server.js"] },
    });

    JSON.parse(await fs.readFile(settingsPath, "utf-8"));

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    await assert.rejects(fs.access(settingsPath), /ENOENT/);
  });

  test("should keep existing settings.json while removing temporary mcpServers", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ theme: "dark" }));

    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerServers("wf-1", tmpDir, {
      ctrlyoke: { command: "node", args: ["server.js"] },
    });

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.deepStrictEqual(settings, { theme: "dark" });
  });

  test("shares identical permission policies and rejects conflicting owners", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    const policy = {
      "*": "ask" as const,
      edit: "allow" as const,
    };

    assert.strictEqual(
      await tracker.registerPermissionPolicy("wf-1", tmpDir, policy),
      "acquired"
    );
    assert.strictEqual(
      await tracker.registerPermissionPolicy("wf-2", tmpDir, policy),
      "shared"
    );
    await assert.rejects(
      tracker.registerPermissionPolicy("wf-3", tmpDir, {
        "*": "allow",
      }),
      /permission policy conflict/
    );

    await tracker.unregisterPermissionPolicy("wf-1", tmpDir);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).permission,
      policy
    );

    await tracker.unregisterPermissionPolicy("wf-2", tmpDir);
    await assert.rejects(fs.access(settingsPath), /ENOENT/);
  });

  test("preserves permission edits made while a lease is active", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerPermissionPolicy("wf-1", tmpDir, {
      "*": "ask",
      edit: "allow",
    });

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    settings.permission.read = "deny";
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    await tracker.unregisterPermissionPolicy("wf-1", tmpDir);

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).permission,
      {
        "*": "ask",
        edit: "allow",
        read: "deny",
      }
    );
  });
});
