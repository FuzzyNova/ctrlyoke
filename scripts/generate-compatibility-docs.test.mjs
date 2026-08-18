import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCompatibilityDocumentation,
  loadDocumentationFacts,
} from "./generate-compatibility-docs.mjs";

const require = createRequire(import.meta.url);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadFacts() {
  const compatibilityTypes = require(
    resolve(ROOT_DIR, "out/types/CompatibilityTypes.js")
  );
  return {
    facts: loadDocumentationFacts(),
    compatibilityTypes,
  };
}

test("compatibility documentation covers the current registry without uniform features", () => {
  const { facts, compatibilityTypes } = loadFacts();
  const generated = buildCompatibilityDocumentation(facts, compatibilityTypes);

  assert.deepEqual(
    facts.harnesses.map(({ harnessId }) => harnessId),
    [
      "copilot-cli",
      "claude-cli",
      "codex-cli",
      "opencode-cli",
      "qwen-cli",
      "antigravity-cli",
    ]
  );
  assert.deepEqual(facts.enabledDomains, [
    "permissions",
    "promptInputs",
    "hooks",
    "mcp",
  ]);
  assert.equal(
    generated.split("\n").filter((line) => line.startsWith("| ")).length,
    74,
    "six harnesses × twelve leaves plus the table header and divider"
  );
  assert.match(generated, /sandbox\/approval modes/);
  assert.match(generated, /Remove the server filter/);
  for (const uniformFeature of [
    "executionMode",
    "sessions",
    "mcp.injection",
    "usage",
    "workflow agents",
    "workflow skills",
  ]) {
    assert.equal(
      generated.includes(`| ${uniformFeature} |`),
      false,
      `uniform feature leaked into capability rows: ${uniformFeature}`
    );
  }
});

test("checked-in compatibility documentation matches the generator output", () => {
  const { facts, compatibilityTypes } = loadFacts();
  const generated = buildCompatibilityDocumentation(facts, compatibilityTypes);
  const checkedIn = readFileSync(
    resolve(ROOT_DIR, "docs/harnesses/compatibility.md"),
    "utf8"
  );
  assert.equal(checkedIn, generated);
});
