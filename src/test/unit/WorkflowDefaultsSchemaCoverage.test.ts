import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, test } from "mocha";

const RESHAPED_DEFAULTS: Record<string, string> = {
  model: "defaults.models",
  additionalArgs: "defaults.additionalArgs",
  trustedExternalRoots: "permissions.trustedExternalRoots",
};

const DEFAULT_OPT_OUTS: Record<string, string> = {
  sessionId: "Session IDs identify a particular run and cannot be a reusable default.",
  vars: "Workflow variables are authored per workflow and may contain workflow-specific values.",
};

suite("Workflow defaults schema coverage", () => {
  test("accounts for every execution and workflow-only property", async () => {
    const workflowSchemaPath = path.resolve(
      __dirname,
      "../../../schemas/workflow-schema.json"
    );
    const settingsSchemaPath = path.resolve(
      __dirname,
      "../../../schemas/settings-schema.json"
    );
    const [workflowSchemaText, settingsSchemaText] = await Promise.all([
      fs.readFile(workflowSchemaPath, "utf8"),
      fs.readFile(settingsSchemaPath, "utf8"),
    ]);
    const workflowSchema = JSON.parse(workflowSchemaText) as {
      definitions?: Record<
        string,
        { properties?: Record<string, unknown> }
      >;
    };
    const settingsSchema = JSON.parse(settingsSchemaText) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const defaultsProperties = new Set(
      Object.keys(
        settingsSchema.properties?.defaults?.properties ?? {}
      )
    );
    const workflowPropertyNames = [
      ...Object.keys(
        workflowSchema.definitions?.executionProperties?.properties ?? {}
      ),
      ...Object.keys(
        workflowSchema.definitions?.workflowOnlyProperties?.properties ?? {}
      ),
    ];

    for (const property of workflowPropertyNames) {
      assert.ok(
        defaultsProperties.has(property) ||
          Object.prototype.hasOwnProperty.call(RESHAPED_DEFAULTS, property) ||
          Object.prototype.hasOwnProperty.call(DEFAULT_OPT_OUTS, property),
        `Add ${property} to defaults, RESHAPED_DEFAULTS, or DEFAULT_OPT_OUTS with a reason`
      );
    }

    for (const [property, targetPath] of Object.entries(RESHAPED_DEFAULTS)) {
      const [root, child] = targetPath.split(".");
      const targetProperties = settingsSchema.properties?.[root]?.properties;
      assert.ok(
        targetProperties && Object.prototype.hasOwnProperty.call(targetProperties, child),
        `${property} maps to missing settings schema path ${targetPath}`
      );
    }

    for (const [property, reason] of Object.entries(DEFAULT_OPT_OUTS)) {
      assert.ok(reason.trim().length > 0, `${property} opt-out needs a reason`);
      assert.ok(
        workflowPropertyNames.includes(property),
        `${property} is no longer a workflow property; remove its opt-out`
      );
    }
  });
});
