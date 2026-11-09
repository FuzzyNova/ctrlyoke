import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addPropertyTitles,
  generateYamlSchema,
  humanizePropertyKey,
  isYamlSchemaCurrent,
} from "./generate-yaml-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in YAML matches the generator output", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, "schemas/workflow-schema.json"), "utf8")
  );
  const generated = generateYamlSchema(schema);
  const current = fs.readFileSync(
    path.join(root, "schemas/workflow-schema.yaml"),
    "utf8"
  );
  assert.equal(isYamlSchemaCurrent(generated, current), true);
  assert.equal(isYamlSchemaCurrent(generated, `${current}stale`), false);
});

test("property keys become readable titles", () => {
  assert.equal(humanizePropertyKey("resumeSession"), "Resume Session");
  assert.equal(humanizePropertyKey("mcpServers"), "MCP Servers");
  assert.equal(humanizePropertyKey("sessionId"), "Session ID");
  assert.equal(humanizePropertyKey("_templateMeta"), "Template Meta");
  assert.equal(humanizePropertyKey("$schema"), "Schema");
});

test("every nested property gets its own title so hovers stop inheriting the root branch title", () => {
  const schema = {
    title: "Root",
    oneOf: [
      {
        title: "Multiple Steps (or Working File)",
        allOf: [{ $ref: "#/$defs/exec" }],
        properties: {
          steps: { type: "array", items: { properties: { name: {} } } },
        },
      },
    ],
    $defs: { exec: { properties: { model: { $ref: "#/$defs/m" } } } },
    allOf: [{ then: { properties: { harness: { title: "Kept" } } } }],
  };
  addPropertyTitles(schema);
  const branch = schema.oneOf[0];
  assert.equal(branch.properties.steps.title, "Steps");
  assert.equal(branch.properties.steps.items.properties.name.title, "Name");
  assert.equal(schema.$defs.exec.properties.model.title, "Model");
  assert.equal(schema.allOf[0].then.properties.harness.title, "Kept");
  assert.equal(branch.title, "Multiple Steps (or Working File)");
});
