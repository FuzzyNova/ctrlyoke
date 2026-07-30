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

  test("acquires, shares, and restores a generic single-value lease", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: "user-status", theme: "dark" })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    assert.strictEqual(
      await tracker.registerValueLease(
        "wf-1",
        tmpDir,
        "statusLine",
        "ctrlyoke-status"
      ),
      "acquired"
    );
    assert.strictEqual(
      await tracker.registerValueLease(
        "wf-2",
        tmpDir,
        "statusLine",
        "ctrlyoke-status"
      ),
      "shared"
    );
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "ctrlyoke-status"
    );

    await tracker.unregisterValueLease("wf-1", tmpDir, "statusLine");
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "ctrlyoke-status"
    );
    await tracker.unregisterValueLease("wf-2", tmpDir, "statusLine");
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      {
        statusLine: "user-status",
        theme: "dark",
      }
    );
  });

  test("keeps leases for different keys independent in one file", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerValueLease("wf-1", tmpDir, "first", "one");
    await tracker.registerValueLease("wf-2", tmpDir, "second", { value: 2 });

    await tracker.unregisterValueLease("wf-1", tmpDir, "first");
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      {
        second: { value: 2 },
      }
    );

    await tracker.unregisterValueLease("wf-2", tmpDir, "second");
    await assert.rejects(fs.access(settingsPath), /ENOENT/);
  });

  test("allows the sole owner to replace a conflicting generic value", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: "baseline" })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    await tracker.registerValueLease("wf-1", tmpDir, "statusLine", "first");
    assert.strictEqual(
      await tracker.registerValueLease("wf-1", tmpDir, "statusLine", "second"),
      "acquired"
    );
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "second"
    );

    await tracker.unregisterValueLease("wf-1", tmpDir, "statusLine");
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "baseline"
    );
  });

  test("preserves a user edit made to a generic leased value", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerValueLease("wf-1", tmpDir, "statusLine", "owned");

    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: "user-edited" }, null, 2)
    );
    await tracker.unregisterValueLease("wf-1", tmpDir, "statusLine");

    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "user-edited"
    );
  });

  test("prunes a dead owner and restores the on-disk baseline", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: "owned" }));
    const sidecarPath = path.join(
      settingsDir,
      ".ctrlyoke-lease-statusLine.json"
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        baseline: "baseline",
        baselineHadKey: true,
        owners: [{ pid: 99999999, workflowKey: "crashed", ts: Date.now() }],
      })
    );

    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.pruneDeadOwners(tmpDir, "statusLine");

    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "baseline"
    );
    await assert.rejects(fs.access(sidecarPath), /ENOENT/);
  });

  test("adopts the sidecar baseline after in-memory state is lost", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: "ctrlyoke-installed-by-crashed-host" })
    );
    const sidecarPath = path.join(
      settingsDir,
      ".ctrlyoke-lease-statusLine.json"
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        baseline: "user-status",
        baselineHadKey: true,
        owners: [{ pid: process.pid, workflowKey: "wf-1", ts: Date.now() }],
      })
    );

    const tracker = SettingsJsonMcpTracker.getInstance("global-settings", {
      projectConfigPath: () => settingsPath,
    });
    assert.strictEqual(
      await tracker.registerValueLease(
        "wf-1",
        path.join(tmpDir, "different-workspace"),
        "statusLine",
        "ctrlyoke-current"
      ),
      "acquired"
    );
    await tracker.unregisterValueLease(
      "wf-1",
      path.join(tmpDir, "different-workspace"),
      "statusLine"
    );

    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "user-status"
    );
  });
});
