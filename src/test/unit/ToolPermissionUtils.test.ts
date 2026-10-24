import * as assert from "assert";
import { suite, test } from "mocha";
import { PERMISSION_MODES } from "../../types/DashboardConstants";
import type { ToolPermissionConfig } from "../../types/ExecutionPropertyTypes";
import { isToolPermissionConfigNoWiderThan } from "../../types/ToolPermissionUtils";

function config(
  mode: ToolPermissionConfig["mode"],
  allowedTools: string[] = [],
  deniedTools: string[] = []
): ToolPermissionConfig {
  return { mode, allowedTools, deniedTools };
}

suite("ToolPermissionUtils", () => {
  suite("isToolPermissionConfigNoWiderThan", () => {
    test("orders managed modes custom < allowAll < dangerouslyAllowAll", () => {
      const custom = config(PERMISSION_MODES.CUSTOM);
      const allowAll = config(PERMISSION_MODES.ALLOW_ALL);
      const dangerous = config(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL);
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(custom, allowAll),
        true
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(allowAll, dangerous),
        true
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(dangerous, allowAll),
        false
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(allowAll, custom),
        false
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(dangerous, dangerous),
        true
      );
    });

    test("treats null and mode none as the same harness-owned setting", () => {
      const none = config(PERMISSION_MODES.NONE);
      const allowAll = config(PERMISSION_MODES.ALLOW_ALL);
      assert.strictEqual(isToolPermissionConfigNoWiderThan(null, none), true);
      assert.strictEqual(isToolPermissionConfigNoWiderThan(none, null), true);
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(null, allowAll),
        false
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(allowAll, null),
        false,
        "a managed value can't be proven narrower than the harness's own config"
      );
    });

    test("requires every applied baseline denial to stay denied", () => {
      const baseline = config(PERMISSION_MODES.ALLOW_ALL, [], ["shell(rm:*)"]);
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.ALLOW_ALL, [], ["shell(rm:*)", "web"]),
          baseline
        ),
        true
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.ALLOW_ALL),
          baseline
        ),
        false
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.CUSTOM, ["write"]),
          baseline
        ),
        false,
        "custom against allowAll still has to keep the denials"
      );
    });

    test("compares allow-lists only between two custom configs", () => {
      const baseline = config(PERMISSION_MODES.CUSTOM, ["write", "read"]);
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.CUSTOM, ["read"]),
          baseline
        ),
        true
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.CUSTOM, ["read", "shell"]),
          baseline
        ),
        false
      );
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.CUSTOM, ["shell"]),
          config(PERMISSION_MODES.ALLOW_ALL)
        ),
        true,
        "allowAll ignores its allow-list, so any custom list is a subset"
      );
    });

    test("ignores a denied list the baseline mode does not apply", () => {
      assert.strictEqual(
        isToolPermissionConfigNoWiderThan(
          config(PERMISSION_MODES.ALLOW_ALL),
          config(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["shell(rm:*)"])
        ),
        true
      );
    });
  });
});
