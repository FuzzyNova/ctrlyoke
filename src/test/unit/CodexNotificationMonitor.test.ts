import * as assert from "assert";
import { suite, test } from "mocha";
import { CodexNotificationMonitor } from "../../core/harness/codex/CodexNotificationMonitor";

suite("CodexNotificationMonitor", () => {
  test("does not register unsupported notification hooks", () => {
    const config = new CodexNotificationMonitor().buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace",
      [{ event: "notification", command: "node user.js" }],
      ["notification"]
    );
    const hooks = (config as { config: { hooks: Record<string, unknown[]> } })
      .config.hooks;

    assert.deepStrictEqual(hooks, {});
    assert.strictEqual(
      CodexNotificationMonitor.CAPABILITIES.notification.fidelity,
      "unsupported"
    );
    assert.strictEqual(
      CodexNotificationMonitor.CAPABILITIES.notification.mechanism,
      "none"
    );
  });
});
