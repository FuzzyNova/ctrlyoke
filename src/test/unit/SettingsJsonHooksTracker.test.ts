import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SettingsJsonHooksTracker } from "../../flightpath/harness/shared/SettingsJsonHooksTracker";

suite("SettingsJsonHooksTracker", () => {
  let tmpDir: string;
  let settingsDir: string;
  let settingsPath: string;

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-tracker-test-"));
    settingsDir = path.join(tmpDir, ".qwen");
    settingsPath = path.join(settingsDir, "settings.json");
    await fs.mkdir(settingsDir, { recursive: true });
    SettingsJsonHooksTracker.resetAll();
  });

  teardown(async () => {
    SettingsJsonHooksTracker.resetAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should capture baseline on first registration", async () => {
    // Write initial settings with user hooks
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo user" }] }],
        },
      })
    );

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    // Settings should have both FlightPath and user hooks
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 2);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);
  });

  test("should restore baseline on last unregister", async () => {
    const originalHooks = {
      Stop: [{ hooks: [{ type: "command", command: "echo user" }] }],
    };
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: originalHooks }));

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    await tracker.unregisterWorkflow("wf-1", tmpDir);

    // Settings should be restored to original
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.deepStrictEqual(settings.hooks, originalHooks);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });

  test("should handle parallel workflows correctly", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: null }));

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");

    // Workflow A registers
    await tracker.registerWorkflow(
      "wf-A",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node a.js" }] }],
      },
      {}
    );
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);

    // Workflow B registers
    await tracker.registerWorkflow(
      "wf-B",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node b.js" }] }],
      },
      {}
    );
    assert.strictEqual(tracker.getActiveWorkflowCount(), 2);

    // Settings should have both
    let settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 2);

    // Workflow A unregisters — B's hooks should remain
    await tracker.unregisterWorkflow("wf-A", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 1);

    settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.ok(settings.hooks.Stop.length >= 1);

    // Workflow B unregisters — baseline restored
    await tracker.unregisterWorkflow("wf-B", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });

  test("should handle no existing settings file", async () => {
    // Don't write any settings file
    await fs.rm(settingsPath, { force: true });

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {}
    );

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 1);

    await tracker.unregisterWorkflow("wf-1", tmpDir);
  });

  test("should include workflow user hooks in middle layer", async () => {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo baseline" }] }],
        },
      })
    );

    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    await tracker.registerWorkflow(
      "wf-1",
      tmpDir,
      {
        Stop: [{ hooks: [{ type: "command", command: "node fp.js" }] }],
      },
      {
        Stop: [{ hooks: [{ type: "command", command: "npm test" }] }],
      }
    );

    // Order should be: FlightPath first, user hooks middle, baseline last
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    assert.strictEqual(settings.hooks.Stop.length, 3);
    assert.strictEqual(
      settings.hooks.Stop[0].hooks[0].command,
      "node fp.js"
    );
    assert.strictEqual(
      settings.hooks.Stop[1].hooks[0].command,
      "npm test"
    );
    assert.strictEqual(
      settings.hooks.Stop[2].hooks[0].command,
      "echo baseline"
    );
  });

  test("should use separate instances per tool name", () => {
    const qwen = SettingsJsonHooksTracker.getInstance("qwen");
    const gemini = SettingsJsonHooksTracker.getInstance("gemini");
    assert.notStrictEqual(qwen, gemini);

    // Same name returns same instance
    const qwen2 = SettingsJsonHooksTracker.getInstance("qwen");
    assert.strictEqual(qwen, qwen2);
  });

  test("unregister for unknown workflow is no-op", async () => {
    const tracker = SettingsJsonHooksTracker.getInstance("qwen");
    // Should not throw
    await tracker.unregisterWorkflow("nonexistent", tmpDir);
    assert.strictEqual(tracker.getActiveWorkflowCount(), 0);
  });
});
