import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bumpSchema } from "./schema-bump.mjs";
import { publishSchemas } from "./publish-schemas-to-landing.mjs";

const GUARD = `export const CURRENT_SCHEMA_VERSIONS = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: 1,
  [PERSISTED_STORES.SETTINGS]: 1,
} as const satisfies Record<PersistedStore, number>;

const BASELINE = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: 1,
  [PERSISTED_STORES.SETTINGS]: 1,
};
`;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-schema-bump-"));
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  const workflow = json({
    $id: "https://ctrlyoke.dev/schema/v1/workflow.json",
    $defs: { harnessId: { type: "string" } },
  });
  const settings = json({
    $id: "https://ctrlyoke.dev/schema/v1/settings.json",
    properties: { harness: { $ref: "workflow.json#/$defs/harnessId" } },
  });
  writeFileSync(path.join(root, "schemas", "workflow-schema.json"), workflow);
  writeFileSync(path.join(root, "schemas", "settings-schema.json"), settings);
  writeFileSync(
    path.join(root, "src", "utils", "PersistedSchemaGuard.ts"),
    GUARD
  );
  return {
    root,
    workflow,
    settings,
    read: (relativePath) => readFileSync(path.join(root, relativePath), "utf8"),
    publish: () =>
      publishSchemas({ root, outputDir: path.join(root, "landing", "dist") }),
  };
}

test("freezes the published version and moves the schema to the next one", () => {
  const repo = makeRepo();
  try {
    bumpSchema({ root: repo.root, name: "workflow" });

    assert.equal(
      repo.read("schemas/archive/v1/workflow-schema.json"),
      repo.workflow
    );
    assert.equal(
      JSON.parse(repo.read("schemas/workflow-schema.json")).$id,
      "https://ctrlyoke.dev/schema/v2/workflow.json"
    );
    const guard = repo.read("src/utils/PersistedSchemaGuard.ts");
    assert.match(
      guard,
      /CURRENT_SCHEMA_VERSIONS = \{\n.*WORKFLOW_DEFINITION\]: 2,/
    );
    assert.match(guard, /BASELINE = \{\n.*WORKFLOW_DEFINITION\]: 1,/);
    assert.equal(
      JSON.parse(repo.read("schemas/settings-schema.json")).properties.harness
        .$ref,
      "../v2/workflow.json#/$defs/harnessId",
      "current settings must follow the current workflow schema"
    );
    repo.publish();
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("keeps cross-schema refs resolvable when the siblings bump separately", () => {
  const repo = makeRepo();
  try {
    bumpSchema({ root: repo.root, name: "settings" });
    assert.equal(
      JSON.parse(repo.read("schemas/settings-schema.json")).properties.harness
        .$ref,
      "../v1/workflow.json#/$defs/harnessId"
    );
    repo.publish();

    bumpSchema({ root: repo.root, name: "workflow" });
    assert.equal(
      JSON.parse(repo.read("schemas/settings-schema.json")).properties.harness
        .$ref,
      "workflow.json#/$defs/harnessId"
    );
    assert.equal(
      repo.read("schemas/archive/v1/settings-schema.json"),
      repo.settings,
      "a frozen schema is never rewritten"
    );
    repo.publish();
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("refuses to bump when the format version and $id disagree", () => {
  const repo = makeRepo();
  try {
    writeFileSync(
      path.join(repo.root, "src", "utils", "PersistedSchemaGuard.ts"),
      GUARD.replace("WORKFLOW_DEFINITION]: 1", "WORKFLOW_DEFINITION]: 2")
    );
    assert.throws(
      () => bumpSchema({ root: repo.root, name: "workflow" }),
      /is 2 but the schema \$id is v1/
    );
    assert.equal(
      existsSync(path.join(repo.root, "schemas", "archive")),
      false,
      "nothing is written when validation fails"
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
