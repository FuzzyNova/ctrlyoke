import * as assert from "assert";
import { suite, test } from "mocha";
import { PromptFileLoader } from "../../flightpath/orchestration/PromptFileLoader";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

suite("PromptFileLoader Tests", () => {
  suite("populateSettingsDefaults", () => {
    test("should seed toolPermissions from VS Code settings when not explicitly set", () => {
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        model: "claude-sonnet-4.5",
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // toolPermissions should be seeded since it was not in explicitValues
      assert.ok(
        defaults.toolPermissions !== undefined,
        "toolPermissions should be seeded"
      );
      const tp = defaults.toolPermissions as {
        mode: string;
        allowedTools: string[];
        deniedTools: string[];
      };
      assert.ok(
        typeof tp.mode === "string",
        "toolPermissions.mode should be a string"
      );
      assert.ok(
        Array.isArray(tp.allowedTools),
        "toolPermissions.allowedTools should be an array"
      );
      assert.ok(
        Array.isArray(tp.deniedTools),
        "toolPermissions.deniedTools should be an array"
      );
    });

    test("should NOT overwrite toolPermissions when explicitly set in source", () => {
      const explicitPermissions = {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write"],
        deniedTools: ["shell(rm:*)"],
      };
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        toolPermissions: explicitPermissions,
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // toolPermissions should NOT appear in defaults since it was explicitly provided
      assert.strictEqual(
        defaults.toolPermissions,
        undefined,
        "toolPermissions should not be overwritten when explicitly set"
      );
    });

    test("should preserve toolPermissions null (explicit none)", () => {
      const explicitValues: Record<string, unknown> = {
        harness: "copilot-cli",
        toolPermissions: null,
      };

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // null is a defined value (explicit none) — should not be overwritten
      // The check is `explicitValues.toolPermissions === undefined`, and null !== undefined
      assert.strictEqual(
        defaults.toolPermissions,
        undefined,
        "toolPermissions null should be preserved (not overwritten)"
      );
    });

    test("should seed other properties alongside toolPermissions", () => {
      const explicitValues: Record<string, unknown> = {};

      const defaults =
        PromptFileLoader.populateSettingsDefaults(explicitValues);

      // All settings-backed properties should be seeded
      assert.ok(defaults.harness !== undefined, "harness should be seeded");
      assert.ok(defaults.model !== undefined, "model should be seeded");
      assert.ok(
        defaults.resumeSession !== undefined,
        "resumeSession should be seeded"
      );
      assert.ok(
        defaults.toolPermissions !== undefined,
        "toolPermissions should be seeded"
      );
    });
  });
});
