import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkflowSchemaOutline,
  buildWorkflowSchemaOutlineModule,
} from "./generate-workflow-schema-outline.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL("../schemas/workflow-schema.json", import.meta.url),
    "utf8"
  )
);
const outline = buildWorkflowSchemaOutline(schema);

test("checked-in outline matches the generator output", () => {
  assert.equal(
    readFileSync(
      new URL(
        "../src/types/generated/WorkflowSchemaOutline.ts",
        import.meta.url
      ),
      "utf8"
    ),
    buildWorkflowSchemaOutlineModule(schema)
  );
});

test("a step carries no workflow-only or runtime keys", () => {
  for (const kind of ["promptStep", "scriptStep"]) {
    const keys = Object.keys(outline[kind].properties);
    for (const key of [
      "worktree",
      "maxSteps",
      "trustedExternalRoots",
      "_runtime",
    ]) {
      assert.ok(!keys.includes(key), `${kind} must not offer ${key}`);
    }
    assert.deepEqual(
      ["maxSteps", "trustedExternalRoots", "worktree"].filter(
        (key) => !outline[kind].forbiddenKeys.includes(key)
      ),
      [],
      `${kind} forbidden keys`
    );
  }
  assert.ok(outline.promptStep.forbiddenKeys.includes("script"));
});

test("the root accepts steps and finalStep but no runtime fields", () => {
  const keys = Object.keys(outline.workflowRoot.properties);
  assert.ok(keys.includes("steps") && keys.includes("finalStep"));
  for (const key of [
    "_runtime",
    "startedAt",
    "definitionRevision",
    "parallelGroups",
  ]) {
    assert.ok(!keys.includes(key), key);
  }
});

test("enums, defaults and value kinds come through $ref and oneOf", () => {
  const { onPass } = outline.endCondition.properties;
  assert.deepEqual(onPass.enum, ["continue", "retry", "stopWorkflow"]);
  assert.equal(onPass.default, "continue");
  assert.equal(onPass.valueKind, "string");
  assert.deepEqual(
    outline.promptStep.properties.harness.enum,
    schema.$defs.harnessId.enum
  );
  const { priorContext } = outline.promptStep.properties;
  assert.equal(priorContext.valueKind, "oneOf");
  assert.ok(priorContext.alternatives.includes("array"));
  assert.ok(priorContext.enum.includes("previous"));
});

test("the empty-string agent sentinel is not offered as a value", () => {
  assert.equal(outline.promptStep.properties.agent.enum, undefined);
});

test("a $ref sibling description wins over the referenced one", () => {
  assert.match(
    outline.workflowRoot.properties.worktree.description,
    /Run the workflow in the working checkout/
  );
});

test("a .prompt.md frontmatter only offers schemaVersion", () => {
  assert.deepEqual(Object.keys(outline.promptFileFrontmatter.properties), [
    "schemaVersion",
  ]);
});
