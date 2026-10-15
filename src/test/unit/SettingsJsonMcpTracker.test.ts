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

  test("cleans up MCP state independently for workflows in different roots", async () => {
    const firstWorkspace = path.join(tmpDir, "first");
    const secondWorkspace = path.join(tmpDir, "second");
    const firstSettingsPath = path.join(
      firstWorkspace,
      ".multi-root",
      "settings.json"
    );
    const secondSettingsPath = path.join(
      secondWorkspace,
      ".multi-root",
      "settings.json"
    );
    const firstGitignorePath = path.join(
      path.dirname(firstSettingsPath),
      ".gitignore"
    );
    const secondGitignorePath = path.join(
      path.dirname(secondSettingsPath),
      ".gitignore"
    );
    const tracker = SettingsJsonMcpTracker.getInstance("multi-root", {
      userConfigPath: () => path.join(tmpDir, "missing-user-settings.json"),
    });

    await tracker.registerServers("wf-first", firstWorkspace, {
      shared: { command: "first-server", env: { API_KEY: "first-secret" } },
    });
    await tracker.registerServers("wf-second", secondWorkspace, {
      shared: { command: "second-server", env: { API_KEY: "second-secret" } },
    });

    // Cleanup follows the config path captured at registration, even if the
    // caller's current root differs.
    await tracker.unregisterWorkflow("wf-first", secondWorkspace);

    await assert.rejects(fs.access(firstSettingsPath), /ENOENT/);
    await assert.rejects(fs.access(firstGitignorePath), /ENOENT/);
    assert.deepStrictEqual(
      JSON.parse(await fs.readFile(secondSettingsPath, "utf-8")),
      {
        mcpServers: {
          shared: {
            command: "second-server",
            env: { API_KEY: "second-secret" },
          },
        },
      }
    );
    assert.strictEqual(
      (await fs.readFile(secondGitignorePath, "utf-8")).startsWith(
        "# ctrlyoke temp files"
      ),
      true
    );

    await tracker.unregisterWorkflow("wf-second", firstWorkspace);

    await assert.rejects(fs.access(firstSettingsPath), /ENOENT/);
    await assert.rejects(fs.access(firstGitignorePath), /ENOENT/);
    await assert.rejects(fs.access(secondSettingsPath), /ENOENT/);
    await assert.rejects(fs.access(secondGitignorePath), /ENOENT/);
  });
});
