#!/usr/bin/env node

/**
 * sync-models.mjs - Sync model lists from ModelConstants.ts to package.json and schemas
 *
 * This script reads model constants from ModelConstants.ts and updates:
 * 1. package.json enum arrays for settings:
 *    - ctrlyoke.copilotCliModel (uses COPILOT_CLI_MODEL_IDS)
 *    - ctrlyoke.claudeCliModel (uses CLAUDE_CLI_MODELS - Claude models)
 *    - ctrlyoke.codexCliModel (uses CODEX_CLI_MODELS - Codex models)
 * 2. workflow-schema.json model examples (combines all models for autocomplete)
 *
 * IMPORTANT: Different providers support different model sets!
 * - Copilot CLI models come from `copilot help config` (only source — there is
 *   no separate Chat-model superset; ctrlyoke doesn't query VS Code's Language
 *   Model API or support a chat harness)
 * - Claude CLI models come from Anthropic's Claude Code CLI (separate)
 * - Codex CLI models come from OpenAI's Codex CLI (separate)
 * - Antigravity CLI models come from `agy models` (separate; also the only
 *   source that gives verbatim display labels, so --discover writes both
 *   ANTIGRAVITY_CLI_MODELS and ANTIGRAVITY_CLI_MODEL_LABELS directly instead
 *   of auto-deriving labels by title-casing the ID)
 *
 * Usage:
 *   node scripts/sync-models.mjs             # Sync all models from ModelConstants.ts
 *   node scripts/sync-models.mjs --check     # Check if in sync (CI mode)
 *   node scripts/sync-models.mjs --discover  # Query `copilot help config` and `agy models`
 *                                             # directly and update COPILOT_CLI_MODEL_IDS /
 *                                             # ANTIGRAVITY_CLI_MODELS(+LABELS) from them
 *
 * Workflow for updating CLI models (authoritative, no extension needed):
 *   1. Run: npm run sync-models -- --discover  (updates COPILOT_CLI_MODEL_IDS and
 *      ANTIGRAVITY_CLI_MODELS/ANTIGRAVITY_CLI_MODEL_LABELS)
 *   2. Run: npm run sync-models (to update package.json and schema)
 *
 * The script preserves formatting and only updates the enum arrays and schema examples.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const MODEL_CONSTANTS_PATH = resolve(ROOT_DIR, "src/utils/ModelConstants.ts");
const PACKAGE_JSON_PATH = resolve(ROOT_DIR, "package.json");
const SCHEMA_PATH = resolve(ROOT_DIR, "schemas/workflow-schema.json");

/**
 * Parse COPILOT_CLI_MODEL_IDS (CLI models) from ModelConstants.ts
 */
function parseCliModels(content) {
  // Find the COPILOT_CLI_MODEL_IDS array literal
  const cliBlockMatch = content.match(
    /export\s+const\s+COPILOT_CLI_MODEL_IDS\s*=\s*\[([^\]]+)\]/s
  );

  if (!cliBlockMatch) {
    throw new Error(
      "Could not find COPILOT_CLI_MODEL_IDS in ModelConstants.ts"
    );
  }

  const arrayContent = cliBlockMatch[1];
  const modelIds = [];
  const stringRegex = /["']([^"']+)["']/g;
  let match;

  while ((match = stringRegex.exec(arrayContent)) !== null) {
    modelIds.push(match[1]);
  }

  return modelIds;
}

/**
 * Parse CLAUDE_CLI_MODELS (Claude CLI models) from ModelConstants.ts
 */
function parseClaudeModels(content) {
  // Find the CLAUDE_CLI_MODELS array literal (use [\s\S]*? to handle multiline)
  const claudeBlockMatch = content.match(
    /export\s+const\s+CLAUDE_CLI_MODELS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
  );

  if (!claudeBlockMatch) {
    throw new Error("Could not find CLAUDE_CLI_MODELS in ModelConstants.ts");
  }

  const arrayContent = claudeBlockMatch[1];
  const modelIds = [];
  const stringRegex = /["']([^"']+)["']/g;
  let match;

  while ((match = stringRegex.exec(arrayContent)) !== null) {
    modelIds.push(match[1]);
  }

  return modelIds;
}

/**
 * Parse a string array exported with `as const` from ModelConstants.ts
 */
function parseStringArrayConstant(content, constantName) {
  const blockMatch = content.match(
    new RegExp(
      `export\\s+const\\s+${constantName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`
    )
  );

  if (!blockMatch) {
    throw new Error(`Could not find ${constantName} in ModelConstants.ts`);
  }

  const arrayContent = blockMatch[1];
  const modelIds = [];
  const stringRegex = /["']([^"']+)["']/g;
  let match;

  while ((match = stringRegex.exec(arrayContent)) !== null) {
    modelIds.push(match[1]);
  }

  return modelIds;
}

/**
 * Parse CODEX_CLI_MODELS (Codex CLI models) from ModelConstants.ts
 */
function parseCodexModels(content) {
  return parseStringArrayConstant(content, "CODEX_CLI_MODELS");
}

/**
 * Parse all model constants from ModelConstants.ts
 */
function parseModelConstants() {
  const content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");

  const cliModels = parseCliModels(content);
  const claudeModels = parseClaudeModels(content);
  const codexModels = parseCodexModels(content);
  const qwenModels = parseStringArrayConstant(content, "QWEN_CLI_MODELS");
  const antigravityModels = parseStringArrayConstant(
    content,
    "ANTIGRAVITY_CLI_MODELS"
  );
  const opencodeFallbackModels = parseStringArrayConstant(
    content,
    "OPENCODE_CLI_FALLBACK_MODELS"
  );

  console.log(`Found ${cliModels.length} CLI models in COPILOT_CLI_MODEL_IDS`);
  console.log(
    `Found ${claudeModels.length} Claude models in CLAUDE_CLI_MODELS`
  );
  console.log(`Found ${codexModels.length} Codex models in CODEX_CLI_MODELS`);
  console.log(`Found ${qwenModels.length} Qwen models in QWEN_CLI_MODELS`);
  console.log(
    `Found ${antigravityModels.length} Antigravity models in ANTIGRAVITY_CLI_MODELS`
  );
  console.log(
    `Found ${opencodeFallbackModels.length} OpenCode fallback models in OPENCODE_CLI_FALLBACK_MODELS`
  );

  return {
    cliModels,
    claudeModels,
    codexModels,
    qwenModels,
    antigravityModels,
    opencodeFallbackModels,
  };
}

/**
 * Auto-derive a `<X>_MODEL_LABELS` map from its matching `<X>_MODELS`/`<X>_MODEL_IDS`
 * array in ModelConstants.ts, so only the ID array needs hand-editing.
 *
 * Shared by Codex and Copilot CLI models — both use the same "id -> generated
 * title-case label" convention.
 */
function updateDerivedLabels(
  modelsConstantName,
  labelsConstantName,
  checkOnly = false
) {
  console.log(`\nUpdating ${labelsConstantName}...`);

  let content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");
  const modelIds = parseStringArrayConstant(content, modelsConstantName);

  if (modelIds.length === 0) {
    console.log(`  ⚠ No ${modelsConstantName} models found, skipping`);
    return;
  }

  let needsUpdate = false;

  // Auto-generate the expected labels from the model IDs
  const expectedLabels = {};
  modelIds.forEach((id) => {
    expectedLabels[id] = generateDisplayName(id);
  });

  // Parse current labels
  const labelsMatch = content.match(
    new RegExp(
      `export\\s+const\\s+${labelsConstantName}[^=]*=\\s*\\{([^}]+)\\}`,
      "s"
    )
  );
  const currentLabels = {};
  if (labelsMatch) {
    const kvRegex = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = kvRegex.exec(labelsMatch[1])) !== null) {
      currentLabels[match[1]] = match[2];
    }
  }

  // Check if labels match
  const labelsDiffer =
    Object.keys(expectedLabels).length !== Object.keys(currentLabels).length ||
    Object.entries(expectedLabels).some(
      ([id, label]) => currentLabels[id] !== label
    );

  if (labelsDiffer) {
    needsUpdate = true;
    console.log(
      `  ${labelsConstantName}: ${Object.keys(currentLabels).length} → ${Object.keys(expectedLabels).length} entries`
    );

    if (!checkOnly) {
      const labelEntries = Object.entries(expectedLabels)
        .map(([id, label]) => `  "${id}": "${label}"`)
        .join(",\n");
      const newLabelsBlock = `export const ${labelsConstantName}: Record<string, string> = {\n${labelEntries},\n}`;

      content = content.replace(
        new RegExp(
          `export\\s+const\\s+${labelsConstantName}[^=]*=\\s*\\{[^}]+\\}`,
          "s"
        ),
        newLabelsBlock
      );
    }
  } else {
    console.log(`  ${labelsConstantName}: ✓ already in sync`);
  }

  if (needsUpdate && !checkOnly) {
    writeFileSync(MODEL_CONSTANTS_PATH, content);
    console.log("  ✓ ModelConstants.ts updated");
  } else if (needsUpdate && checkOnly) {
    console.log(`\n✗ ${labelsConstantName} is out of sync`);
    process.exit(1);
  }
}

/**
 * Generate display name from model ID (used for auto-derivation)
 * Moved to module scope so it can be used by both import and sync functions
 */
function generateDisplayName(modelId, existingLabels = {}) {
  // Check if we already have a label
  if (existingLabels[modelId]) {
    return existingLabels[modelId];
  }

  // Generate from ID
  return modelId
    .split("-")
    .map((part) => {
      // Keep version numbers as-is
      if (/^\d/.test(part)) return part;
      // GPT should be uppercase
      if (part.toLowerCase() === "gpt") return "GPT";
      // Capitalize first letter
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * Update enum arrays in package.json
 */
function updatePackageJson(
  { cliModels, claudeModels, codexModels },
  checkOnly = false
) {
  const content = readFileSync(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(content);

  // Map setting keys to their model lists
  const settingsMap = {
    "ctrlyoke.copilotCliModel": cliModels,
    "ctrlyoke.claudeCliModel": claudeModels,
    "ctrlyoke.codexCliModel": codexModels,
  };

  let needsUpdate = false;
  let foundSettings = 0;

  for (const [settingKey, newEnum] of Object.entries(settingsMap)) {
    const setting = pkg.contributes?.configuration?.properties?.[settingKey];
    if (!setting) {
      continue;
    }
    foundSettings++;

    const currentEnum = setting.enum || [];

    // Check if different
    const isDifferent =
      currentEnum.length !== newEnum.length ||
      !currentEnum.every((id, i) => id === newEnum[i]);

    if (isDifferent) {
      needsUpdate = true;
      console.log(
        `  ${settingKey}: ${currentEnum.length} → ${newEnum.length} models`
      );

      if (!checkOnly) {
        setting.enum = [...newEnum];
      }
    } else {
      console.log(`  ${settingKey}: ✓ already in sync`);
    }
  }

  if (foundSettings === 0) {
    console.log(
      "  package.json: no legacy model setting enums found, skipping"
    );
    return;
  }

  if (needsUpdate && !checkOnly) {
    // Write back with 2-space indentation (standard for package.json)
    writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.log("\n✓ package.json updated");
  } else if (needsUpdate && checkOnly) {
    console.log("\n✗ package.json is out of sync");
    console.log("Run 'npm run sync-models' to update");
    process.exit(1);
  } else {
    console.log("\n✓ All model lists are in sync");
  }
}

/**
 * Update model examples in workflow-schema.json
 * Combines all models from all providers for autocomplete
 */
function updateSchema(
  {
    cliModels,
    claudeModels,
    codexModels,
    qwenModels = [],
    antigravityModels = [],
    opencodeFallbackModels = [],
  },
  checkOnly = false
) {
  console.log("\nUpdating workflow-schema.json...");

  const content = readFileSync(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(content);

  // Combine all unique models from all providers
  const allModels = [
    ...new Set([
      "none",
      ...cliModels,
      ...claudeModels,
      ...codexModels,
      ...qwenModels,
      ...antigravityModels,
      ...opencodeFallbackModels,
    ]),
  ].sort();

  // Find the model property - it lives in executionProperties (shared mixin)
  const modelProperty =
    schema.definitions?.executionProperties?.properties?.model ||
    schema.definitions?.promptItem?.properties?.model;

  if (!modelProperty) {
    console.warn(
      "Warning: model property not found in schema (checked executionProperties and promptItem)"
    );
    return;
  }

  const currentExamples = modelProperty.examples || [];

  // Check if different
  const isDifferent =
    currentExamples.length !== allModels.length ||
    !currentExamples.every((id, i) => id === allModels[i]);

  if (isDifferent) {
    console.log(
      `  model examples: ${currentExamples.length} → ${allModels.length} models`
    );

    if (!checkOnly) {
      modelProperty.examples = allModels;

      // Write back with 2-space indentation
      writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
      console.log("  ✓ workflow-schema.json updated");
    }
  } else {
    console.log("  ✓ Schema examples already in sync");
  }

  if (isDifferent && checkOnly) {
    console.log("\n✗ Schema is out of sync");
    process.exit(1);
  }
}

/**
 * Discover models directly from `copilot help config` and write them straight
 * into COPILOT_CLI_MODEL_IDS in ModelConstants.ts.
 *
 * This is the sole authoritative source for Copilot CLI models — it queries
 * the CLI directly rather than any VS Code extension host API.
 */
async function discoverFromCli() {
  console.log("Discovering models from Copilot CLI...\n");

  let stdout;
  try {
    ({ stdout } = await execAsync("copilot help config", { timeout: 10000 }));
  } catch (error) {
    console.error("Failed to run 'copilot help config':", error.message);
    console.log("\nMake sure Copilot CLI is installed and in your PATH.");
    process.exit(1);
  }

  // Parse the `model` section to extract choices
  const modelSectionMatch = stdout.match(
    /`model`[^`]+?((?:\s+-\s+"[^"]+"\r?\n)+)/i
  );

  if (!modelSectionMatch) {
    console.error(
      "Could not parse model list from 'copilot help config' output"
    );
    process.exit(1);
  }

  const models = modelSectionMatch[1].match(/"([^"]+)"/g);
  const modelIds = models.map((m) => m.replace(/"/g, ""));

  console.log(`Found ${modelIds.length} CLI-supported models:`);
  modelIds.forEach((m) => console.log(`  - "${m}"`));

  const content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");
  const {
    content: updatedContent,
    added,
    removed,
  } = updateCopilotCliModelIds(content, modelIds);
  writeFileSync(MODEL_CONSTANTS_PATH, updatedContent);

  console.log(
    `\n✓ Updated COPILOT_CLI_MODEL_IDS with ${modelIds.length} models`
  );
  if (added.length > 0) {
    console.log("  New CLI models:");
    added.forEach((id) => console.log(`    + ${id}`));
  }
  if (removed.length > 0) {
    console.log("  Removed CLI models:");
    removed.forEach((id) => console.log(`    - ${id}`));
  }
}

/**
 * Replace the COPILOT_CLI_MODEL_IDS array in ModelConstants.ts source content
 * with `cliModelIds`, returning the updated content plus the added/removed
 * model IDs relative to what was previously there.
 */
function updateCopilotCliModelIds(content, cliModelIds) {
  const currentCliMatch = content.match(
    /export\s+const\s+COPILOT_CLI_MODEL_IDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
  );
  const currentCliIds = [];
  if (currentCliMatch) {
    const stringRegex = /["']([^"']+)["']/g;
    let match;
    while ((match = stringRegex.exec(currentCliMatch[1])) !== null) {
      currentCliIds.push(match[1]);
    }
  }

  const cliEntries = cliModelIds.map((id) => `  "${id}"`);
  const newCliBlock = `export const COPILOT_CLI_MODEL_IDS = [\n${cliEntries.join(",\n")},\n] as const`;

  const updatedContent = content.replace(
    /export\s+const\s+COPILOT_CLI_MODEL_IDS\s*=\s*\[[\s\S]*?\]\s*as\s+const/,
    newCliBlock
  );

  const added = cliModelIds.filter((id) => !currentCliIds.includes(id));
  const removed = currentCliIds.filter((id) => !cliModelIds.includes(id));

  return { content: updatedContent, added, removed };
}

/**
 * Run a command with stdin explicitly closed (`stdio: ["ignore", "pipe", "pipe"]`).
 *
 * `agy models` hangs indefinitely under Node's `exec`/`execFile` on Windows: those
 * leave the child's stdin open as an unwritten, unclosed pipe, and the `models`
 * subcommand specifically blocks reading it before printing anything (`agy --version`
 * is unaffected, confirming this is a stdin-read quirk of that one subcommand rather
 * than a general agy startup issue). Closing stdin up front avoids the hang.
 */
function execWithClosedStdin(command, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`
        )
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(
          new Error(`Command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`)
        );
      }
    });
  });
}

/**
 * Discover models directly from `agy models` and write them straight into
 * ANTIGRAVITY_CLI_MODELS + ANTIGRAVITY_CLI_MODEL_LABELS in ModelConstants.ts.
 *
 * Unlike Copilot, agy's output already includes verbatim display labels
 * (tab-separated `<id>\t<label>` per line), so labels are written as-is
 * rather than auto-derived by title-casing the ID.
 */
async function discoverAntigravityFromCli() {
  console.log("\nDiscovering models from Antigravity CLI ('agy models')...\n");

  let stdout;
  try {
    stdout = await execWithClosedStdin("agy", ["models"], 15000);
  } catch (error) {
    console.error("Failed to run 'agy models':", error.message);
    console.log("\nMake sure Antigravity CLI (agy) is installed and in your PATH.");
    process.exit(1);
  }

  const modelPairs = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [id, label] = trimmed.split("\t");
    if (id) {
      modelPairs.push([id, label ?? id]);
    }
  }

  if (modelPairs.length === 0) {
    console.error("Could not parse any models from 'agy models' output");
    process.exit(1);
  }

  console.log(`Found ${modelPairs.length} Antigravity-supported models:`);
  modelPairs.forEach(([id, label]) => console.log(`  - "${id}" -> "${label}"`));

  const content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");
  const {
    content: updatedContent,
    added,
    removed,
  } = updateAntigravityModelsAndLabels(content, modelPairs);
  writeFileSync(MODEL_CONSTANTS_PATH, updatedContent);

  console.log(
    `\n✓ Updated ANTIGRAVITY_CLI_MODELS/ANTIGRAVITY_CLI_MODEL_LABELS with ${modelPairs.length} models`
  );
  if (added.length > 0) {
    console.log("  New Antigravity models:");
    added.forEach((id) => console.log(`    + ${id}`));
  }
  if (removed.length > 0) {
    console.log("  Removed Antigravity models:");
    removed.forEach((id) => console.log(`    - ${id}`));
  }
}

/**
 * Replace the ANTIGRAVITY_CLI_MODELS and ANTIGRAVITY_CLI_MODEL_LABELS blocks in
 * ModelConstants.ts source content with `modelPairs` ([id, label] tuples,
 * in `agy models` order), returning the updated content plus the added/removed
 * model IDs relative to what was previously there.
 */
function updateAntigravityModelsAndLabels(content, modelPairs) {
  const currentIds = parseStringArrayConstant(content, "ANTIGRAVITY_CLI_MODELS");

  const modelIds = modelPairs.map(([id]) => id);
  const idEntries = modelIds.map((id) => `  "${id}"`);
  const newIdsBlock = `export const ANTIGRAVITY_CLI_MODELS = [\n${idEntries.join(",\n")},\n] as const`;

  let updatedContent = content.replace(
    /export\s+const\s+ANTIGRAVITY_CLI_MODELS\s*=\s*\[[\s\S]*?\]\s*as\s+const/,
    newIdsBlock
  );

  const labelEntries = modelPairs.map(
    ([id, label]) => `  "${id}": "${label}"`
  );
  const newLabelsBlock = `export const ANTIGRAVITY_CLI_MODEL_LABELS: Record<string, string> = {\n${labelEntries.join(",\n")},\n}`;

  updatedContent = updatedContent.replace(
    /export\s+const\s+ANTIGRAVITY_CLI_MODEL_LABELS[^=]*=\s*\{[^}]+\}/,
    newLabelsBlock
  );

  const added = modelIds.filter((id) => !currentIds.includes(id));
  const removed = currentIds.filter((id) => !modelIds.includes(id));

  return { content: updatedContent, added, removed };
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const discover = args.includes("--discover");

  console.log("ctrlyoke Model Sync\n");

  if (discover) {
    await discoverFromCli();
    await discoverAntigravityFromCli();
    console.log("\nNext step: Run 'npm run sync-models' to update package.json");
    return;
  }

  try {
    // First, auto-derive the Codex and Copilot label maps from their model ID arrays
    // This ensures you only need to update the CODEX_CLI_MODELS / COPILOT_CLI_MODEL_IDS arrays
    updateDerivedLabels(
      "CODEX_CLI_MODELS",
      "CODEX_CLI_MODEL_LABELS",
      checkOnly
    );
    updateDerivedLabels(
      "COPILOT_CLI_MODEL_IDS",
      "COPILOT_CLI_MODEL_LABELS",
      checkOnly
    );

    // Then parse and sync all models to package.json and schema
    const models = parseModelConstants();
    updatePackageJson(models, checkOnly);
    updateSchema(models, checkOnly);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
