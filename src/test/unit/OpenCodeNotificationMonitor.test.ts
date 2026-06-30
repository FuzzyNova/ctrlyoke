import * as assert from "assert";
import * as path from "path";
import { OpenCodeNotificationMonitor } from "../../core/harness/opencode/OpenCodeNotificationMonitor";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

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

  test("should resolve the notification directory under .ctrlyoke temp", () => {
    const workspaceRoot = path.join("C:", "dev", "ctrlyoke");
    const notifyDir = monitor.getNotificationDirectory(workspaceRoot);

    assert.strictEqual(
      notifyDir,
      path.join(
        workspaceRoot,
        PATH_CONSTANTS.CTRLYOKE_DIR,
        PATH_CONSTANTS.TEMP_DIR,
        "opencode-notifications"
      )
    );
  });
});
