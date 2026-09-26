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

test("uses the current v1 source and requires its release archive to match", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-schema-archive-"));
  try {
    const schemasDir = path.join(root, "schemas");
    const archiveDir = path.join(schemasDir, "archive", "v1");
    const outputDir = path.join(root, "landing", "dist");
    mkdirSync(archiveDir, { recursive: true });
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
    writeFileSync(path.join(archiveDir, "workflow-schema.json"), workflow);
    writeFileSync(path.join(archiveDir, "settings-schema.json"), settings);

    publishSchemas({ root, outputDir });
    assert.equal(
      readFileSync(
        path.join(outputDir, "schema", "v1", "workflow.json"),
        "utf8"
      ),
      workflow
    );

    writeFileSync(
      path.join(archiveDir, "workflow-schema.json"),
      `${workflow}\n`
    );
    assert.throws(
      () => publishSchemas({ root, outputDir }),
      /schemas\/archive\/v1\/workflow-schema\.json must exactly match/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
