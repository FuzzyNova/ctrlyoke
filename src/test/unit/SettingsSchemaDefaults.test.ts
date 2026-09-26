import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";

interface SettingsSchema {
  $ref?: string;
  type?: string;
  properties?: Record<string, SettingsSchema>;
  default?: unknown;
}

const OPTIONAL_NO_DEFAULT_LEAVES = [
  {
    path: /^defaults\.additionalArgs\.[^.]+$/,
    reason:
      "Per-harness additional arguments are sparse overrides; an absent harness entry means no extra arguments.",
  },
  {
    path: /^ui\.harnessColors\.byHarness\.[^.]+$/,
    reason:
      "Per-harness colors are sparse overrides; an absent harness entry uses its built-in theme-aware color.",
  },
] as const;

const LOCAL_DEFINITION_REF_PREFIX = "#/$defs/";

suite("Settings schema defaults", () => {
  const schemaPath = path.resolve(
    __dirname,
    "../../../schemas/settings-schema.json"
  );
  const schema = JSON.parse(
    fs.readFileSync(schemaPath, "utf-8")
  ) as SettingsSchema & { $defs: Record<string, SettingsSchema> };

  test("every leaf default matches DEFAULT_SETTINGS", () => {
    const walk = (node: SettingsSchema, segments: string[]): void => {
      if (node.$ref?.startsWith(LOCAL_DEFINITION_REF_PREFIX)) {
        const definition =
          schema.$defs[node.$ref.slice(LOCAL_DEFINITION_REF_PREFIX.length)];
        assert.ok(definition, `Missing schema definition for ${node.$ref}`);
        walk(definition, segments);
        return;
      }

      if (node.type === "object") {
        // Container objects are navigation/grouping nodes, not setting values.
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          walk(child, [...segments, key]);
        }
        return;
      }

      const settingPath = segments.join(".");
      if (
        node.type === "array" &&
        ["format", "sharedFormat"].includes(segments.at(-1) ?? "")
      ) {
        // Format arrays contain ordered statusline segments with shared derived defaults.
        return;
      }

      let value: unknown = CTRLYOKE_SETTINGS_DEFAULTS;
      let hasSettingsValue = true;
      for (const segment of segments) {
        if (
          value === null ||
          typeof value !== "object" ||
          !Object.prototype.hasOwnProperty.call(value, segment)
        ) {
          hasSettingsValue = false;
          break;
        }
        value = (value as Record<string, unknown>)[segment];
      }

      if (node.default === undefined && !hasSettingsValue) {
        const exemption = OPTIONAL_NO_DEFAULT_LEAVES.find(({ path: pattern }) =>
          pattern.test(settingPath)
        );
        assert.ok(
          exemption,
          `Leaf ${settingPath} has no schema default or DEFAULT_SETTINGS value and has no documented exemption.`
        );
        assert.ok(
          exemption.reason,
          `Missing exemption reason for ${settingPath}`
        );
        return;
      }

      assert.notStrictEqual(
        node.default,
        undefined,
        `Leaf ${settingPath} has no schema default.`
      );
      assert.ok(
        hasSettingsValue,
        `Leaf ${settingPath} has a schema default but no DEFAULT_SETTINGS value.`
      );
      assert.deepStrictEqual(node.default, value, settingPath);
    };

    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      walk(property, [key]);
    }
  });
});
