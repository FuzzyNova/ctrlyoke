import assert from "node:assert/strict";
import test from "node:test";

import {
  addPropertyTitles,
  humanizePropertyKey,
} from "./generate-yaml-schema.mjs";

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
