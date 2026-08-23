import * as assert from "assert";
import { suite, test } from "mocha";
import { QwenNotificationMonitor } from "../../core/harness/qwen/QwenNotificationMonitor";

suite("QwenNotificationMonitor", () => {
  test("registers Notification for a selected event", () => {
    const config = new QwenNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node user.js" }],
      ["notification"]
    );
    const hooks = (config as { config: { hooks: Record<string, unknown[]> } })
      .config.hooks;

    assert.ok(hooks.Notification);
    assert.strictEqual(hooks.Notification.length, 1);
    assert.ok(JSON.stringify(hooks.Notification).includes("script.js"));
  });
});
