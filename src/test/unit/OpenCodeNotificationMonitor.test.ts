import * as assert from "assert";
import * as path from "path";
import { OpenCodeNotificationMonitor } from "../../core/harness/opencode/OpenCodeNotificationMonitor";
import { HOOK_CAVEAT_CODES } from "../../types/CompatibilityTypes";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

suite("OpenCodeNotificationMonitor", () => {
  let monitor: OpenCodeNotificationMonitor;

  setup(() => {
    monitor = new OpenCodeNotificationMonitor();
  });

  test("buildHookConfig should return none because OpenCode uses inline plugin config", () => {
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

  test("leaves notification unmapped and declares it unsupported", () => {
    assert.strictEqual(
      OpenCodeNotificationMonitor.EVENT_MAP.notification,
      undefined
    );
    assert.strictEqual(
      OpenCodeNotificationMonitor.CAPABILITIES.notification.fidelity,
      "unsupported"
    );
    assert.strictEqual(
      OpenCodeNotificationMonitor.CAPABILITIES.notification.mechanism,
      "none"
    );
  });

  test("marks pre-tool hooks partial because they cannot block the tool call", () => {
    const declaration = OpenCodeNotificationMonitor.CAPABILITIES.preToolUse;

    assert.strictEqual(declaration.fidelity, "partial");
    assert.strictEqual(declaration.caveatCode, HOOK_CAVEAT_CODES.CANNOT_BLOCK);
  });
});
