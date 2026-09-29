import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishSchemas } from "./publish-schemas-to-landing.mjs";

function makeSchema(id, title) {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    title,
    type: "object",
  });
}

test("publishes current schemas to the version and filenames in their $ids", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-schema-publish-"));
  try {
    const schemasDir = path.join(root, "schemas");
    const outputDir = path.join(root, "landing", "dist");
    mkdirSync(schemasDir, { recursive: true });
    const workflow = makeSchema(
      "https://ctrlyoke.dev/schema/v1/workflow.json",
      "workflow"
    );
    const settings = makeSchema(
      "https://ctrlyoke.dev/schema/v1/settings.json",
      "settings"
    );
    writeFileSync(path.join(schemasDir, "workflow-schema.json"), workflow);
    writeFileSync(path.join(schemasDir, "settings-schema.json"), settings);

    publishSchemas({ root, outputDir });

    assert.equal(
      readFileSync(
        path.join(outputDir, "schema", "v1", "workflow.json"),
        "utf8"
      ),
      workflow
    );
    assert.equal(
      readFileSync(
        path.join(outputDir, "schema", "v1", "settings.json"),
        "utf8"
      ),
      settings
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const schemasDir = path.join(root, "schemas");
  mkdirSync(schemasDir, { recursive: true });
  return {
    root,
    schemasDir,
    outputDir: path.join(root, "landing", "dist"),
    write(relativePath, content) {
      const filePath = path.join(schemasDir, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    },
    published(version, fileName) {
      return readFileSync(
        path.join(root, "landing", "dist", "schema", version, fileName),
        "utf8"
      );
    },
  };
}

test("publishes a superseded version from the archive beside the current one", () => {
  const fixture = makeFixture("ctrlyoke-schema-archive-");
  try {
    const v1 = makeSchema("https://ctrlyoke.dev/schema/v1/workflow.json", "v1");
    const v2 = makeSchema("https://ctrlyoke.dev/schema/v2/workflow.json", "v2");
    fixture.write("workflow-schema.json", v2);
    fixture.write("archive/v1/workflow-schema.json", v1);

    publishSchemas({ root: fixture.root, outputDir: fixture.outputDir });

    assert.equal(fixture.published("v1", "workflow.json"), v1);
    assert.equal(fixture.published("v2", "workflow.json"), v2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publishes an archived schema whose version is still current for a sibling", () => {
  const fixture = makeFixture("ctrlyoke-schema-sibling-");
  try {
    const workflow = makeSchema(
      "https://ctrlyoke.dev/schema/v1/workflow.json",
      "workflow"
    );
    const settingsV1 = makeSchema(
      "https://ctrlyoke.dev/schema/v1/settings.json",
      "settings v1"
    );
    fixture.write("workflow-schema.json", workflow);
    fixture.write(
      "settings-schema.json",
      makeSchema("https://ctrlyoke.dev/schema/v2/settings.json", "settings v2")
    );
    fixture.write("archive/v1/settings-schema.json", settingsV1);

    publishSchemas({ root: fixture.root, outputDir: fixture.outputDir });

    assert.equal(fixture.published("v1", "settings.json"), settingsV1);
    assert.equal(fixture.published("v1", "workflow.json"), workflow);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an archive entry that duplicates a current schema's $id", () => {
  const fixture = makeFixture("ctrlyoke-schema-duplicate-");
  try {
    const workflow = makeSchema(
      "https://ctrlyoke.dev/schema/v1/workflow.json",
      "workflow"
    );
    fixture.write("workflow-schema.json", workflow);
    fixture.write("archive/v1/workflow-schema.json", workflow);

    assert.throws(
      () =>
        publishSchemas({ root: fixture.root, outputDir: fixture.outputDir }),
      /same \$id as a current schema/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a cross-schema $ref that resolves to an unpublished URL", () => {
  const fixture = makeFixture("ctrlyoke-schema-ref-");
  try {
    fixture.write(
      "workflow-schema.json",
      makeSchema("https://ctrlyoke.dev/schema/v1/workflow.json", "workflow")
    );
    fixture.write(
      "settings-schema.json",
      JSON.stringify({
        $id: "https://ctrlyoke.dev/schema/v2/settings.json",
        properties: { harness: { $ref: "workflow.json#/$defs/harnessId" } },
      })
    );

    assert.throws(
      () =>
        publishSchemas({ root: fixture.root, outputDir: fixture.outputDir }),
      /unpublished https:\/\/ctrlyoke\.dev\/schema\/v2\/workflow\.json/
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
