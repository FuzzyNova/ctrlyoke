import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeNotificationMonitor } from "../../core/harness/claude/ClaudeNotificationMonitor";

suite("ClaudeNotificationMonitor", () => {
  test("registers Notification for combined and user-only hook configs", () => {
    const userHook = {
      event: "notification" as const,
      command: "node user.js",
    };
    const monitor = new ClaudeNotificationMonitor();
    const combined = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [userHook],
      ["notification"]
    );
    const combinedHooks = JSON.parse(
      (combined as { config: string }).config
    ).hooks;

    assert.strictEqual(combinedHooks.Notification.length, 2);
    assert.ok(
      combinedHooks.Notification[0].hooks[0].command.includes("script.js")
    );
    assert.strictEqual(
      combinedHooks.Notification[1].hooks[0].command,
      "node user.js"
    );

    const userOnly = JSON.parse(
      ClaudeNotificationMonitor.buildUserOnlyConfig([userHook])
    );
    assert.strictEqual(userOnly.hooks.Notification.length, 1);
    assert.strictEqual(
      userOnly.hooks.Notification[0].hooks[0].command,
      "node user.js"
    );
  });
});
