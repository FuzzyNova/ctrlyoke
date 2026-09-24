import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSchemaDocumentation,
  loadSchemaDocumentationInputs,
} from "./generate-schema-docs.mjs";

function build(overrides = {}) {
  return buildSchemaDocumentation({
    ...loadSchemaDocumentationInputs(),
    ...overrides,
  });
}

function pageEndingWith(result, name) {
  return result.pages.find(({ path }) =>
    path.replaceAll("\\", "/").endsWith(`/docs/reference/${name}.md`)
  ).markdown;
}

test("schema docs build without coverage errors", () => {
  assert.deepEqual(build().errors, []);
});

test("checked-in schema reference pages match the generator output", () => {
  for (const { path, markdown } of build().pages) {
    assert.equal(readFileSync(path, "utf8"), markdown, path);
  }
});

test("every settings leaf is documented with its compiled default", () => {
  const result = build();
  const settings = pageEndingWith(result, "settings");
  assert.match(
    settings,
    /### `execution\.scriptTimeout` \{#execution-scripttimeout\}/
  );
  assert.match(settings, /\*\*Default:\*\* `3600`/);
  assert.match(
    settings,
    /\*\*Workflow field:\*\* \[`harness`\]\(\/reference\/workflow-schema#execution-properties-harness\)/
  );
});

test("a new settings field without a description fails generation", () => {
  const inputs = loadSchemaDocumentationInputs();
  inputs.settingsSchema.properties.queue.properties.undocumented = {
    type: "boolean",
  };
  const { errors } = buildSchemaDocumentation(inputs);
  assert.ok(
    errors.includes("missing description: settings: queue.undocumented"),
    errors.join("\n")
  );
});

test("a new workflow definition must be assigned to a docs section", () => {
  const inputs = loadSchemaDocumentationInputs();
  inputs.workflowSchema.definitions.brandNewShape = { type: "object" };
  const { errors } = buildSchemaDocumentation(inputs);
  assert.ok(
    errors.some((error) => error.includes('"brandNewShape"')),
    errors.join("\n")
  );
});

test("description text cannot inject Vue interpolation or HTML", () => {
  const workflow = pageEndingWith(build(), "workflow-schema");
  const interpolations = workflow.match(/.{0,12}\{\{varName\}\}/g) ?? [];
  assert.ok(interpolations.length > 0);
  for (const match of interpolations) {
    assert.match(match, /<code v-pre>\{\{varName\}\}$/);
  }
  assert.doesNotMatch(workflow, /[^`]<agentInstructions>/);
});
