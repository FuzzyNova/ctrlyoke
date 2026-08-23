import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotNotificationMonitor } from "../../core/harness/copilot/CopilotNotificationMonitor";

suite("CopilotNotificationMonitor", () => {
  test("registers lowercase notification and preserves a separate user command", () => {
    const config = new CopilotNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node user.js" }],
      ["notification"]
    );
    const hooks = (config as { config: { hooks: Record<string, unknown[]> } })
      .config.hooks;

    assert.strictEqual(hooks.notification.length, 2);
    assert.ok(
      (hooks.notification[0] as { bash: string }).bash.includes(
        '"notification"'
      )
    );
    assert.strictEqual(
      (hooks.notification[1] as { bash: string }).bash,
      "node user.js"
    );
  });

  test("uses the lowercase native key in a user-only config", () => {
    const config = CopilotNotificationMonitor.buildUserOnlyConfig([
      { event: "notification", command: "node user.js" },
    ]);
    const hooks = config.hooks as Record<string, unknown[]>;

    assert.strictEqual(hooks.notification.length, 1);
    assert.strictEqual(
      (hooks.notification[0] as { bash: string }).bash,
      "node user.js"
    );
  });
});
