#!/usr/bin/env node

/**
 * sync-models.mjs - Sync model lists from ModelConstants.ts to package.json and schemas
 *
 * This script reads model constants from ModelConstants.ts and updates:
 * 1. package.json enum arrays for settings:
 *    - flightpath.copilotCliModel (uses COPILOT_CLI_MODEL_IDS - smaller set)
 *    - flightpath.copilotChatModel (uses COPILOT_MODELS keys - full set)
 *    - flightpath.claudeCliModel (uses CLAUDE_CLI_MODELS - Claude models)
 *    - flightpath.codexCliModel (uses CODEX_CLI_MODELS - Codex models)
 * 2. prompt-schema.json model examples (combines all models for autocomplete)
 *
 * IMPORTANT: Different providers support different model sets!
 * - Copilot CLI models come from `copilot help config` (smaller subset)
 * - Copilot Chat models come from VS Code's Language Model API (larger set)
 * - Claude CLI models come from Anthropic's Claude Code CLI (separate)
 * - Codex CLI models come from OpenAI's Codex CLI (separate)
 *
 * Usage:
 *   node scripts/sync-models.mjs             # Sync all models from ModelConstants.ts
 *   node scripts/sync-models.mjs --check     # Check if in sync (CI mode)
 *   node scripts/sync-models.mjs --discover  # Discover models from Copilot CLI
 *   node scripts/sync-models.mjs --import    # Import from discovered-models.json and update ModelConstants.ts
 *
 * Workflow for updating Chat models:
 *   1. Run extension (F5)
 *   2. Run "FlightPath: Export Discovered Models" command
 *   3. Run: npm run sync-models -- --import
 *   4. Run: npm run sync-models (to update package.json and schema)
 *
 * The script preserves formatting and only updates the enum arrays and schema examples.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const MODEL_CONSTANTS_PATH = resolve(ROOT_DIR, "src/utils/ModelConstants.ts");
const PACKAGE_JSON_PATH = resolve(ROOT_DIR, "package.json");
const DISCOVERED_MODELS_PATH = resolve(__dirname, "discovered-models.json");
const SCHEMA_PATH = resolve(ROOT_DIR, "schemas/prompt-schema.json");

/**
 * Parse COPILOT_MODELS (Chat models - full set) from ModelConstants.ts
 */
function parseChatModels(content) {
  // Find the COPILOT_MODELS object literal
  const modelBlockMatch = content.match(
    /export\s+const\s+COPILOT_MODELS[^=]*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s
  );

  if (!modelBlockMatch) {
    throw new Error("Could not find COPILOT_MODELS in ModelConstants.ts");
  }

  const modelBlock = modelBlockMatch[1];
  const modelIds = [];

  // Match both quoted keys ("key": ...) and unquoted keys (key: ...)
  // Handles: "model-id": "Name", 'model-id': 'Name', modelId: "Name"
  const keyRegex = /(?:["']([^"']+)["']|(\w+))\s*:/g;
  let match;

  while ((match = keyRegex.exec(modelBlock)) !== null) {
    // match[1] is quoted key, match[2] is unquoted key
    const key = match[1] || match[2];
    if (key) {
      modelIds.push(key);
    }
  }

  return modelIds;
}

/**
 * Parse COPILOT_CLI_MODEL_IDS (CLI models - smaller set) from ModelConstants.ts
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

  const chatModels = parseChatModels(content);
  const cliModels = parseCliModels(content);
  const claudeModels = parseClaudeModels(content);
  const codexModels = parseCodexModels(content);
  const qwenModels = parseStringArrayConstant(content, "QWEN_CLI_MODELS");
  const geminiModels = parseStringArrayConstant(content, "GEMINI_CLI_MODELS");
  const opencodeFallbackModels = parseStringArrayConstant(
    content,
    "OPENCODE_CLI_FALLBACK_MODELS"
  );

  console.log(`Found ${chatModels.length} Chat models in COPILOT_MODELS`);
  console.log(`Found ${cliModels.length} CLI models in COPILOT_CLI_MODEL_IDS`);
  console.log(
    `Found ${claudeModels.length} Claude models in CLAUDE_CLI_MODELS`
  );
  console.log(`Found ${codexModels.length} Codex models in CODEX_CLI_MODELS`);
  console.log(`Found ${qwenModels.length} Qwen models in QWEN_CLI_MODELS`);
  console.log(
    `Found ${geminiModels.length} Gemini models in GEMINI_CLI_MODELS`
  );
  console.log(
    `Found ${opencodeFallbackModels.length} OpenCode fallback models in OPENCODE_CLI_FALLBACK_MODELS`
  );

  return {
    chatModels,
    cliModels,
    claudeModels,
    codexModels,
    qwenModels,
    geminiModels,
    opencodeFallbackModels,
  };
}

/**
 * Auto-derive CODEX_CLI_MODEL_LABELS from CODEX_CLI_MODELS
 *
 * This ensures you only need to update CODEX_CLI_MODELS array, and the
 * labels are automatically generated.
 */
function updateCodexDerivedConstants(checkOnly = false) {
  console.log("\nUpdating Codex derived constants...");

  let content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");
  const codexModels = parseCodexModels(content);

  if (codexModels.length === 0) {
    console.log("  ⚠ No Codex models found, skipping");
    return;
  }

  let needsUpdate = false;

  // === Update CODEX_CLI_MODEL_LABELS (auto-generate from model IDs) ===
  const expectedLabels = {};
  codexModels.forEach((id) => {
    expectedLabels[id] = generateDisplayName(id);
  });

  // Parse current labels
  const labelsMatch = content.match(
    /export\s+const\s+CODEX_CLI_MODEL_LABELS[^=]*=\s*\{([^}]+)\}/s
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
      `  CODEX_CLI_MODEL_LABELS: ${Object.keys(currentLabels).length} → ${Object.keys(expectedLabels).length} entries`
    );

    if (!checkOnly) {
      const labelEntries = Object.entries(expectedLabels)
        .map(([id, label]) => `  "${id}": "${label}"`)
        .join(",\n");
      const newLabelsBlock = `export const CODEX_CLI_MODEL_LABELS: Record<string, string> = {\n${labelEntries},\n}`;

      content = content.replace(
        /export\s+const\s+CODEX_CLI_MODEL_LABELS[^=]*=\s*\{[^}]+\}/s,
        newLabelsBlock
      );
    }
  } else {
    console.log(`  CODEX_CLI_MODEL_LABELS: ✓ already in sync`);
  }

  if (needsUpdate && !checkOnly) {
    writeFileSync(MODEL_CONSTANTS_PATH, content);
    console.log("  ✓ ModelConstants.ts updated");
  } else if (needsUpdate && checkOnly) {
    console.log("\n✗ Codex derived constants are out of sync");
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
  { chatModels, cliModels, claudeModels, codexModels },
  checkOnly = false
) {
  const content = readFileSync(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(content);

  // Map setting keys to their model lists
  const settingsMap = {
    "flightpath.copilotCliModel": cliModels,
    "flightpath.copilotChatModel": chatModels,
    "flightpath.claudeCliModel": claudeModels,
    "flightpath.codexCliModel": codexModels,
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
 * Update model examples in prompt-schema.json
 * Combines all models from all providers for autocomplete
 */
function updateSchema(
  {
    chatModels,
    cliModels,
    claudeModels,
    codexModels,
    qwenModels = [],
    geminiModels = [],
    opencodeFallbackModels = [],
  },
  checkOnly = false
) {
  console.log("\nUpdating prompt-schema.json...");

  const content = readFileSync(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(content);

  // Combine all unique models from all providers
  const allModels = [
    ...new Set([
      "none",
      ...chatModels,
      ...cliModels,
      ...claudeModels,
      ...codexModels,
      ...qwenModels,
      ...geminiModels,
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
      console.log("  ✓ prompt-schema.json updated");
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
 * Discover models from Copilot CLI
 */
async function discoverFromCli() {
  console.log("Discovering models from Copilot CLI...\n");

  try {
    const { stdout } = await execAsync("copilot help config", {
      timeout: 10000,
    });

    // Parse the `model` section to extract choices
    const modelSectionMatch = stdout.match(
      /`model`[^`]+?((?:\s+-\s+"[^"]+"\r?\n)+)/i
    );

    if (modelSectionMatch) {
      const models = modelSectionMatch[1].match(/"([^"]+)"/g);
      if (models && models.length > 0) {
        const modelIds = models.map((m) => m.replace(/"/g, ""));
        console.log("CLI-supported models:");
        modelIds.forEach((m) => console.log(`  - "${m}"`));
        console.log(`\nTotal: ${modelIds.length} models`);
        console.log(
          "\nTo update ModelConstants.ts, copy these to COPILOT_CLI_MODEL_IDS"
        );
        return;
      }
    }

    console.log("Could not parse model list from 'copilot help config' output");
  } catch (error) {
    console.error("Failed to run 'copilot help config':", error.message);
    console.log("\nMake sure Copilot CLI is installed and in your PATH.");
  }
}

/**
 * Import models from discovered-models.json and update ModelConstants.ts
 *
 * This reads the JSON file exported by the "FlightPath: Export Discovered Models"
 * command and updates:
 * - COPILOT_MODELS object (chat models with display names)
 * - COPILOT_CLI_MODEL_IDS array (CLI-supported subset)
 */
function importDiscoveredModels() {
  console.log("Importing models from discovered-models.json...\n");

  if (!existsSync(DISCOVERED_MODELS_PATH)) {
    console.error("❌ discovered-models.json not found!");
    console.log("\nTo generate this file:");
    console.log("  1. Run the FlightPath extension (F5)");
    console.log('  2. Run command: "FlightPath: Export Discovered Models"');
    console.log("  3. Then run: npm run sync-models -- --import");
    process.exit(1);
  }

  // Read discovered models
  const discovered = JSON.parse(readFileSync(DISCOVERED_MODELS_PATH, "utf-8"));
  console.log(`Exported at: ${discovered.exportedAt}`);
  console.log(`Chat models: ${discovered.chatModelIds?.length || 0}`);
  console.log(`CLI models: ${discovered.cliModelIds?.length || 0}`);

  if (!discovered.chatModelIds || discovered.chatModelIds.length === 0) {
    console.error("\n❌ No chat models found in discovered-models.json");
    process.exit(1);
  }

  // Read current ModelConstants.ts
  let content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");

  // === Update COPILOT_MODELS ===
  // Extract existing display names to preserve them
  const existingLabels = {};
  const labelMatch = content.match(
    /export\s+const\s+COPILOT_MODELS[^=]*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s
  );
  if (labelMatch) {
    const kvRegex = /["']?([^"'\s:]+)["']?\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = kvRegex.exec(labelMatch[1])) !== null) {
      existingLabels[match[1]] = match[2];
    }
  }

  // Build the new COPILOT_MODELS entries
  const chatEntries = discovered.chatModelIds.map((id) => {
    const label = generateDisplayName(id, existingLabels);
    return `  "${id}": "${label}"`;
  });

  const newCopilotModelsBlock = `export const COPILOT_MODELS: Record<string, string> = {\n${chatEntries.join(",\n")},\n}`;

  content = content.replace(
    /export\s+const\s+COPILOT_MODELS[^=]*=\s*\{[^}]+(?:\{[^}]*\}[^}]*)*\}/s,
    newCopilotModelsBlock
  );

  console.log(
    `\n✓ Updated COPILOT_MODELS with ${discovered.chatModelIds.length} models`
  );
  const newChatModels = discovered.chatModelIds.filter(
    (id) => !existingLabels[id]
  );
  if (newChatModels.length > 0) {
    console.log("  New chat models:");
    newChatModels.forEach((id) => console.log(`    + ${id}`));
  }

  // === Update COPILOT_CLI_MODEL_IDS ===
  if (discovered.cliModelIds && discovered.cliModelIds.length > 0) {
    // Get current CLI model IDs for comparison
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

    // Build new CLI model IDs array
    const cliEntries = discovered.cliModelIds.map((id) => `  "${id}"`);
    const newCliBlock = `export const COPILOT_CLI_MODEL_IDS = [\n${cliEntries.join(",\n")},\n] as const`;

    content = content.replace(
      /export\s+const\s+COPILOT_CLI_MODEL_IDS\s*=\s*\[[\s\S]*?\]\s*as\s+const/,
      newCliBlock
    );

    console.log(
      `\n✓ Updated COPILOT_CLI_MODEL_IDS with ${discovered.cliModelIds.length} models`
    );
    const newCliModels = discovered.cliModelIds.filter(
      (id) => !currentCliIds.includes(id)
    );
    const removedCliModels = currentCliIds.filter(
      (id) => !discovered.cliModelIds.includes(id)
    );
    if (newCliModels.length > 0) {
      console.log("  New CLI models:");
      newCliModels.forEach((id) => console.log(`    + ${id}`));
    }
    if (removedCliModels.length > 0) {
      console.log("  Removed CLI models:");
      removedCliModels.forEach((id) => console.log(`    - ${id}`));
    }
  }

  // Write back
  writeFileSync(MODEL_CONSTANTS_PATH, content);

  console.log("\nNext step: Run 'npm run sync-models' to update package.json");
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const discover = args.includes("--discover");
  const importModels = args.includes("--import");

  console.log("FlightPath Model Sync\n");

  if (discover) {
    await discoverFromCli();
    return;
  }

  if (importModels) {
    importDiscoveredModels();
    return;
  }

  try {
    // First, auto-derive Codex constants from CODEX_CLI_MODELS
    // This ensures you only need to update the CODEX_CLI_MODELS array
    updateCodexDerivedConstants(checkOnly);

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
