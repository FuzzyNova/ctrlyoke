import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { AntigravityNotificationMonitor } from "../../core/harness/antigravity/AntigravityNotificationMonitor";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("AntigravityNotificationMonitor", () => {
  test("supports session start via PreInvocation", async () => {
    const monitor = new AntigravityNotificationMonitor();
    const tempDir = makeTempDir("ctrlyoke-antigravity-notify-");

    try {
      const runId = "run-123";
      const startFile = path.join(tempDir, `${runId}-start.json`);
      await fs.promises.writeFile(
        startFile,
        JSON.stringify({
          hookEvent: "PreInvocation",
          sessionId: "conversation-123",
          status: "started",
        }),
        "utf8"
      );

      const result = await monitor.waitForSessionStart!(
        {
          directory: tempDir,
          timeoutMs: 200,
          pollMs: 25,
        },
        new Date(Date.now() - 50),
        runId
      );

      assert.strictEqual(monitor.supportsSessionStart, true);
      assert.strictEqual(result.completed, true);
      assert.strictEqual(result.data?.sessionId, "conversation-123");
      assert.strictEqual(fs.existsSync(startFile), false);
    } finally {
      removeTempDir(tempDir);
    }
  });

  test("buildHookConfig registers PreInvocation for sessionStart", () => {
    const monitor = new AntigravityNotificationMonitor();
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      undefined,
      ["sessionStart", "stop"]
    );

    assert.strictEqual(config.type, "json");
    const group = (config as { config: Record<string, any> }).config.ctrlyoke;
    assert.ok(Array.isArray(group.PreInvocation));
    assert.strictEqual(group.PostInvocation, null);
    assert.ok(Array.isArray(group.Stop));
  });

  test("buildHookConfig maps notification events to agy hook groups", () => {
    const monitor = new AntigravityNotificationMonitor();
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      undefined,
      ["preToolUse", "postToolUse", "permissionRequest"]
    );

    assert.strictEqual(config.type, "json");
    const group = (config as { config: Record<string, any> }).config.ctrlyoke;
    assert.ok(Array.isArray(group.PreToolUse));
    assert.ok(Array.isArray(group.PostToolUse));
    assert.strictEqual(group.PreInvocation, null);
    assert.strictEqual(group.PostInvocation, null);
    assert.strictEqual(group.Stop, null);
    assert.strictEqual(group.PreToolUse.length, 1);
    assert.strictEqual(
      group.PreToolUse[0].command,
      "node script.js notify-dir PreToolUse"
    );
    assert.strictEqual(
      group.PostToolUse[0].command,
      "node script.js notify-dir PostToolUse"
    );
  });

  test("buildHookConfig wires user hooks from HooksEditor to supported agy events", () => {
    const monitor = new AntigravityNotificationMonitor();
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [
        { event: "stop", command: "node stop-hook.js" },
        { event: "sessionStart", command: "node start-hook.js" },
        { event: "preToolUse", command: "node pre-hook.js" },
        { event: "postToolUse", command: "node post-hook.js" },
        { event: "permissionRequest", command: "node permission-hook.js" },
        { event: "userPromptSubmit", command: "node unsupported-hook.js" },
        { event: "error", command: "node error-hook.js" },
      ],
      []
    );

    assert.strictEqual(config.type, "json");
    const group = (config as { config: Record<string, any> }).config.ctrlyoke;
    assert.deepStrictEqual(
      group.Stop.map((h: { command: string }) => h.command),
      ["node stop-hook.js"]
    );
    assert.deepStrictEqual(
      group.PreInvocation.map((h: { command: string }) => h.command),
      ["node start-hook.js"]
    );
    assert.deepStrictEqual(
      group.PreToolUse.map((h: { command: string }) => h.command),
      ["node pre-hook.js"]
    );
    assert.deepStrictEqual(
      group.PostToolUse.map((h: { command: string }) => h.command),
      ["node post-hook.js"]
    );
    assert.strictEqual(group.PostInvocation, null);
  });

  test("uses second timeout for configured user hooks and defaults the rest to 0", () => {
    const monitor = new AntigravityNotificationMonitor();
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [
        { event: "stop", command: "node slow.js", timeoutSec: 4 },
        { event: "preToolUse", command: "node default.js" },
      ],
      ["stop"]
    );
    const group = (config as { config: Record<string, any> }).config.ctrlyoke;
    assert.strictEqual(group.Stop[0].timeout, 0);
    assert.strictEqual(group.Stop[1].timeout, 4);
    assert.strictEqual(group.PreToolUse[0].timeout, 0);
  });

  test("silently skips notification as an unsupported event", () => {
    const monitor = new AntigravityNotificationMonitor();
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node notify.js" }],
      ["notification"]
    );
    const group = (config as { config: Record<string, any> }).config.ctrlyoke;

    assert.strictEqual(group.PreToolUse, null);
    assert.strictEqual(group.PostToolUse, null);
    assert.strictEqual(group.PreInvocation, null);
    assert.strictEqual(group.PostInvocation, null);
    assert.strictEqual(group.Stop, null);
    assert.strictEqual(
      AntigravityNotificationMonitor.CAPABILITIES.notification.fidelity,
      "unsupported"
    );
  });
});
