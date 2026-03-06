import * as assert from "assert";
import * as path from "path";
import { OpenCodeNotificationMonitor } from "../../flightpath/harness/opencode/OpenCodeNotificationMonitor";

suite("OpenCodeNotificationMonitor", () => {
  let monitor: OpenCodeNotificationMonitor;

  setup(() => {
    monitor = new OpenCodeNotificationMonitor();
  });

  test("buildHookConfig should return none because OpenCode uses a plugin file", () => {
    const config = monitor.buildHookConfig(
      "script.js",
      "notify-dir",
      "workspace"
    );

    assert.deepStrictEqual(config, { type: "none" });
  });

  test("should resolve the notification directory under .flightpath temp", () => {
    const workspaceRoot = path.join("C:", "dev", "FlightPath");
    const notifyDir = monitor.getNotificationDirectory(workspaceRoot);

    assert.strictEqual(
      notifyDir,
      path.join(workspaceRoot, ".flightpath", "temp", "opencode-notifications")
    );
  });

  test("should generate plugin content that writes start and stop notifications", () => {
    const plugin = monitor.getPluginContent(
      "C:\\repo\\.flightpath\\temp\\opencode-notifications"
    );

    assert.ok(
      plugin.includes(
        'const NOTIFY_DIR = "C:/repo/.flightpath/temp/opencode-notifications";'
      )
    );
    assert.ok(plugin.includes('event.type === "session.created"'));
    assert.ok(plugin.includes('event.type === "session.status"'));
    assert.ok(plugin.includes("-start.json"));
    assert.ok(plugin.includes("-stop.json"));
    assert.ok(plugin.includes('status: "started"'));
    assert.ok(plugin.includes('status: "completed"'));
  });
});
