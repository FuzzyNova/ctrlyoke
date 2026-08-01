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

  test("shares identical values and rejects conflicting owners", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    const value = "ctrlyoke-status";

    assert.strictEqual(
      await tracker.registerValueLease("wf-1", tmpDir, "statusLine", value),
      "acquired"
    );
    assert.strictEqual(
      await tracker.registerValueLease("wf-2", tmpDir, "statusLine", value),
      "shared"
    );
    await assert.rejects(
      tracker.registerValueLease("wf-3", tmpDir, "statusLine", "other"),
      /statusLine value conflict/
    );

    await tracker.unregisterValueLease("wf-1", tmpDir, "statusLine");
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      value
    );

    await tracker.unregisterValueLease("wf-2", tmpDir, "statusLine");
    await assert.rejects(fs.access(settingsPath), /ENOENT/);
  });

  test("preserves user edits made while a value lease is active", async () => {
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    await tracker.registerValueLease(
      "wf-1",
      tmpDir,
      "statusLine",
      "ctrlyoke-status"
    );

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    settings.statusLine = "user-edit";
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    await tracker.unregisterValueLease("wf-1", tmpDir, "statusLine");

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "user-edit"
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
        owners: [
          {
            pid: 99999999,
            token: "crashed-process",
            workflowKey: "crashed",
            ts: Date.now(),
          },
        ],
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

  test("reacquires after a dead owner with the same workflow key", async () => {
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
        owners: [
          {
            pid: 99999999,
            token: "crashed-process",
            workflowKey: "wf-reused",
            ts: Date.now(),
          },
        ],
      })
    );

    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    assert.strictEqual(
      await tracker.registerValueLease(
        "wf-reused",
        tmpDir,
        "statusLine",
        "replacement"
      ),
      "acquired"
    );
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "replacement"
    );
    await tracker.unregisterValueLease("wf-reused", tmpDir, "statusLine");
    assert.strictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      "baseline"
    );
  });

  test("does not treat a recycled current PID as the old lease owner", async () => {
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
        owners: [
          {
            pid: process.pid,
            token: "previous-process-instance",
            workflowKey: "wf-reused",
            ts: Date.now(),
          },
        ],
      })
    );

    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    assert.strictEqual(
      await tracker.registerValueLease(
        "wf-reused",
        tmpDir,
        "statusLine",
        "replacement"
      ),
      "acquired"
    );
  });

  test("keeps MCP baselines isolated by resolved config path", async () => {
    const firstWorkspace = path.join(tmpDir, "first");
    const secondWorkspace = path.join(tmpDir, "second");
    const firstSettingsPath = path.join(
      firstWorkspace,
      ".qwen",
      "settings.json"
    );
    const secondSettingsPath = path.join(
      secondWorkspace,
      ".qwen",
      "settings.json"
    );
    await fs.mkdir(path.dirname(firstSettingsPath), { recursive: true });
    await fs.writeFile(
      firstSettingsPath,
      JSON.stringify({ mcpServers: { shared: { command: "user" } } })
    );

    const tracker = SettingsJsonMcpTracker.getInstance("multi-root", {
      userConfigPath: () => path.join(tmpDir, "missing-user-settings.json"),
    });
    await tracker.registerServers("wf-second", secondWorkspace, {
      shared: { command: "ctrlyoke" },
    });
    await tracker.unregisterWorkflow("wf-second", secondWorkspace);

    await assert.rejects(fs.access(secondSettingsPath), /ENOENT/);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(firstSettingsPath, "utf-8")),
      { mcpServers: { shared: { command: "user" } } }
    );
  });

  test("adopts the sidecar baseline after in-memory state is lost", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: "user-status" })
    );
    const firstTracker = SettingsJsonMcpTracker.getInstance("global-settings", {
      projectConfigPath: () => settingsPath,
    });
    await firstTracker.registerValueLease(
      "wf-1",
      path.join(tmpDir, "different-workspace"),
      "statusLine",
      "ctrlyoke-installed-by-crashed-host"
    );

    // Simulate a host restart while preserving the on-disk lease sidecar.
    SettingsJsonMcpTracker.resetAll();
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
