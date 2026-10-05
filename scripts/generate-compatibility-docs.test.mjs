import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCompatibilityDocumentation,
  loadCompatibilityTypes,
  loadDocumentationFacts,
} from "./generate-compatibility-docs.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadFacts() {
  return {
    facts: loadDocumentationFacts(),
    compatibilityTypes: loadCompatibilityTypes(),
  };
}

function matrixSection(generated) {
  return generated.slice(
    generated.indexOf("## Compatibility matrix"),
    generated.indexOf("### Notes")
  );
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
  const matrixRows = matrixSection(generated)
    .split("\n")
    .filter((line) => line.startsWith("| "));
  assert.equal(
    matrixRows.length,
    19,
    "thirteen capability rows, four domain rows, plus the header and divider"
  );
  assert.equal(
    matrixRows[0].split(" | ").length,
    7,
    "one capability column plus one column per harness"
  );
  assert.ok(
    matrixRows[0].includes("[Copilot](/harnesses/copilot-cli)<br>`copilot-cli`")
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

test("every limited matrix cell links to a note with a reason", () => {
  const { facts, compatibilityTypes } = loadFacts();
  const generated = buildCompatibilityDocumentation(facts, compatibilityTypes);

  const limitedCells = matrixSection(generated).match(/[◐❌]<\/span>(<sup>)?/g);
  assert.ok(limitedCells.length > 0);
  for (const cell of limitedCells) {
    assert.ok(cell.endsWith("<sup>"), `limited cell has no note: ${cell}`);
  }

  for (const { harnessId, capabilities } of facts.harnesses) {
    for (const domain of facts.enabledDomains) {
      const pending = [[domain, capabilities[domain]]];
      while (pending.length > 0) {
        const [path, value] = pending.pop();
        if (typeof value?.fidelity === "string") {
          if (value.fidelity !== compatibilityTypes.fidelities.EXACT) {
            assert.ok(
              compatibilityTypes.getCompatibilityCaveatMessage(
                value.caveatCode
              ),
              `${harnessId} ${path} is ${value.fidelity} without a caveat`
            );
          }
          continue;
        }
        for (const [key, child] of Object.entries(value ?? {})) {
          pending.push([`${path}.${key}`, child]);
        }
      }
    }
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
