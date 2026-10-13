import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildHookTimeoutOptions,
  HOOK_TIMEOUT_UNITS,
} from "../../core/harness/shared/interfaces/INotificationMonitor";
import { ClaudeNotificationMonitor } from "../../core/harness/claude/ClaudeNotificationMonitor";

suite("ClaudeNotificationMonitor", () => {
  test("builds native timeout options in typed units", () => {
    assert.deepStrictEqual(buildHookTimeoutOptions(undefined), {});
    assert.deepStrictEqual(buildHookTimeoutOptions(7), { timeout: 7 });
    assert.deepStrictEqual(
      buildHookTimeoutOptions(7, HOOK_TIMEOUT_UNITS.MILLISECONDS),
      { timeout: 7000 }
    );
  });

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

  test("applies timeoutSec to native Claude hook timeout in seconds", () => {
    const userHook = {
      event: "stop" as const,
      command: "node slow.js",
      timeoutSec: 7,
    };
    const config = JSON.parse(
      ClaudeNotificationMonitor.buildUserOnlyConfig([userHook])
    );
    assert.strictEqual(config.hooks.Stop[0].hooks[0].timeout, 7);

    const combined = new ClaudeNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [userHook],
      []
    );
    const hooks = JSON.parse((combined as { config: string }).config).hooks;
    assert.strictEqual(hooks.Stop[0].hooks[0].timeout, 7);
  });
});
