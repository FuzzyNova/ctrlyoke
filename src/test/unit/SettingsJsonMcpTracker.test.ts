import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  SettingsJsonMcpTracker,
  STATUS_LINE_SETTING_KEY,
} from "../../core/harness/shared/SettingsJsonMcpTracker";

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

  test("installs a persistent value idempotently", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const value = { type: "command", command: "node ctrlyoke.js" };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: value, theme: "dark" })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    let captureCalls = 0;

    const result = await tracker.installPersistentValue(
      tmpDir,
      STATUS_LINE_SETTING_KEY,
      value,
      async () => {
        captureCalls++;
      }
    );

    assert.strictEqual(result.kind, "no-op");
    assert.deepStrictEqual(result.preexistingValue, value);
    assert.strictEqual(result.hadKey, true);
    assert.strictEqual(captureCalls, 0);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      { statusLine: value, theme: "dark" }
    );
  });

  test("reports the preexisting value when it performs an install write", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const preexistingValue = {
      type: "command",
      command: "node user-statusline.js",
    };
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: preexistingValue })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    const result = await tracker.installPersistentValue(
      tmpDir,
      STATUS_LINE_SETTING_KEY,
      installedValue
    );

    assert.strictEqual(result.kind, "written");
    assert.deepStrictEqual(result.preexistingValue, preexistingValue);
    assert.strictEqual(result.hadKey, true);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      installedValue
    );
  });

  test("installs and uninstalls a persistent value at a dotted path", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", ui: { sidebar: "visible" } })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    const result = await tracker.installPersistentValue(
      tmpDir,
      "ui.statusLine",
      installedValue
    );

    assert.strictEqual(result.kind, "written");
    assert.strictEqual(result.hadKey, false);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      {
        theme: "dark",
        ui: { sidebar: "visible", statusLine: installedValue },
      }
    );

    await tracker.uninstallPersistentValue(tmpDir, "ui.statusLine", {
      action: "delete",
    });
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      { theme: "dark", ui: { sidebar: "visible" } }
    );
  });

  test("creates missing intermediate objects for a dotted path", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const installedValue = { type: "command", command: "node statusline.js" };
    await fs.writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    await tracker.installPersistentValue(
      tmpDir,
      "ui.statusLine.command",
      installedValue.command
    );

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      { theme: "dark", ui: { statusLine: { command: installedValue.command } } }
    );
  });

  test("declines a persistent install without writing after capture", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const preexistingValue = { type: "preset", items: ["git-branch"] };
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    const originalContents = JSON.stringify(
      { theme: "dark", ui: { statusLine: preexistingValue } },
      null,
      2
    );
    await fs.writeFile(settingsPath, originalContents);
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    const result = await tracker.installPersistentValue(
      tmpDir,
      "ui.statusLine",
      installedValue,
      (capturedValue, hadKey) => {
        assert.deepStrictEqual(capturedValue, preexistingValue);
        assert.strictEqual(hadKey, true);
        return { proceed: false };
      }
    );

    assert.strictEqual(result.kind, "declined");
    assert.deepStrictEqual(result.preexistingValue, preexistingValue);
    assert.strictEqual(result.hadKey, true);
    assert.strictEqual(
      await fs.readFile(settingsPath, "utf-8"),
      originalContents
    );
  });

  test("does not install when capture persistence fails", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const preexistingValue = {
      type: "command",
      command: "node user-statusline.js",
    };
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: preexistingValue })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    await assert.rejects(
      tracker.installPersistentValue(
        tmpDir,
        STATUS_LINE_SETTING_KEY,
        installedValue,
        async (capturedValue) => {
          assert.deepStrictEqual(capturedValue, preexistingValue);
          throw new Error("user settings capture failed");
        }
      ),
      /user settings capture failed/
    );

    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      preexistingValue
    );
  });

  test("restores a persistent value or deletes it as requested", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    const restoredValue = {
      type: "command",
      command: "node user-statusline.js",
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: installedValue, theme: "dark" })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    await tracker.uninstallPersistentValue(tmpDir, STATUS_LINE_SETTING_KEY, {
      action: "restore",
      value: restoredValue,
    });
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      { statusLine: restoredValue, theme: "dark" }
    );

    await tracker.uninstallPersistentValue(tmpDir, STATUS_LINE_SETTING_KEY, {
      action: "delete",
    });
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")),
      { theme: "dark" }
    );
  });

  test("removes only the obsolete statusLine sidecar", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ statusLine: "old" }));
    const statusLineSidecar = path.join(
      settingsDir,
      ".ctrlyoke-lease-statusLine.json"
    );
    const otherSidecar = path.join(
      settingsDir,
      ".ctrlyoke-lease-permission.json"
    );
    await fs.writeFile(statusLineSidecar, "statusline lease");
    await fs.writeFile(otherSidecar, "permission lease");
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");

    await tracker.installPersistentValue(
      tmpDir,
      STATUS_LINE_SETTING_KEY,
      "installed"
    );
    await assert.rejects(fs.access(statusLineSidecar), /ENOENT/);
    await fs.access(otherSidecar);

    await fs.writeFile(statusLineSidecar, "statusline lease");
    await tracker.uninstallPersistentValue(tmpDir, STATUS_LINE_SETTING_KEY, {
      action: "delete",
    });
    await assert.rejects(fs.access(statusLineSidecar), /ENOENT/);
    await fs.access(otherSidecar);
  });

  test("serializes concurrent persistent installs and captures once", async () => {
    await fs.mkdir(settingsDir, { recursive: true });
    const installedValue = {
      type: "command",
      command: "node ctrlyoke-statusline.js",
    };
    const preexistingValue = {
      type: "command",
      command: "node user-statusline.js",
    };
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ statusLine: preexistingValue })
    );
    const tracker = SettingsJsonMcpTracker.getInstance("qwen");
    let captureCalls = 0;

    const results = await Promise.all(
      [1, 2].map(() =>
        tracker.installPersistentValue(
          tmpDir,
          STATUS_LINE_SETTING_KEY,
          installedValue,
          async (capturedValue) => {
            captureCalls++;
            assert.deepStrictEqual(capturedValue, preexistingValue);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        )
      )
    );

    assert.deepStrictEqual(results.map((result) => result.kind).sort(), [
      "no-op",
      "written",
    ]);
    assert.strictEqual(captureCalls, 1);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf-8")).statusLine,
      installedValue
    );
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
