#!/usr/bin/env node

/**
 * sync-models.mjs - Sync model lists from ModelConstants.ts to package.json
 *
 * This script reads model constants from ModelConstants.ts and updates
 * the enum arrays in package.json for:
 * - flightpath.copilotCliModel (uses COPILOT_CLI_MODEL_IDS - smaller set)
 * - flightpath.copilotChatModel (uses COPILOT_MODELS keys - full set)
 *
 * IMPORTANT: Copilot CLI and Copilot Chat support DIFFERENT model sets!
 * - CLI models come from `copilot help config`
 * - Chat models come from VS Code's Language Model API
 *
 * Usage:
 *   node scripts/sync-models.mjs             # Sync from ModelConstants.ts to package.json
 *   node scripts/sync-models.mjs --check     # Check if in sync (CI mode)
 *   node scripts/sync-models.mjs --discover  # Discover models from Copilot CLI
 *   node scripts/sync-models.mjs --import    # Import from discovered-models.json and update ModelConstants.ts
 *
 * Workflow for updating Chat models:
 *   1. Run extension (F5)
 *   2. Run "FlightPath: Export Discovered Models" command
 *   3. Run: npm run sync-models -- --import
 *   4. Run: npm run sync-models (to update package.json)
 *
 * The script preserves package.json formatting and only updates the enum arrays.
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
 * Parse all model constants from ModelConstants.ts
 */
function parseModelConstants() {
  const content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");

  const chatModels = parseChatModels(content);
  const cliModels = parseCliModels(content);

  console.log(`Found ${chatModels.length} Chat models in COPILOT_MODELS`);
  console.log(`Found ${cliModels.length} CLI models in COPILOT_CLI_MODEL_IDS`);

  return { chatModels, cliModels };
}

/**
 * Update enum arrays in package.json
 */
function updatePackageJson({ chatModels, cliModels }, checkOnly = false) {
  const content = readFileSync(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(content);

  // Map setting keys to their model lists
  const settingsMap = {
    "flightpath.copilotCliModel": cliModels,
    "flightpath.copilotChatModel": chatModels,
  };

  let needsUpdate = false;

  for (const [settingKey, newEnum] of Object.entries(settingsMap)) {
    const setting = pkg.contributes?.configuration?.properties?.[settingKey];
    if (!setting) {
      console.warn(`Warning: Setting ${settingKey} not found in package.json`);
      continue;
    }

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
 * command and updates the COPILOT_MODELS object in ModelConstants.ts.
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
  const content = readFileSync(MODEL_CONSTANTS_PATH, "utf-8");

  // Build new COPILOT_MODELS object
  // We'll preserve display names where possible, generate new ones for new models
  const existingLabels = {};
  const labelMatch = content.match(
    /export\s+const\s+COPILOT_MODELS[^=]*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s
  );
  if (labelMatch) {
    // Extract existing key-value pairs
    const kvRegex = /["']?([^"'\s:]+)["']?\s*:\s*["']([^"']+)["']/g;
    let match;
    while ((match = kvRegex.exec(labelMatch[1])) !== null) {
      existingLabels[match[1]] = match[2];
    }
  }

  // Generate display names for new models
  function generateDisplayName(modelId) {
    // Check if we already have a label
    if (existingLabels[modelId]) {
      return existingLabels[modelId];
    }

    // Generate from ID: claude-sonnet-4.5 -> Claude Sonnet 4.5
    return modelId
      .split("-")
      .map((part) => {
        // Keep version numbers as-is
        if (/^\d/.test(part)) return part;
        // Capitalize first letter
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  // Build the new object entries
  const entries = discovered.chatModelIds.map((id) => {
    const label = generateDisplayName(id);
    return `  "${id}": "${label}"`;
  });

  // Create the new COPILOT_MODELS block
  const newBlock = `export const COPILOT_MODELS: Record<string, string> = {\n${entries.join(",\n")},\n}`;

  // Replace in content
  const newContent = content.replace(
    /export\s+const\s+COPILOT_MODELS[^=]*=\s*\{[^}]+(?:\{[^}]*\}[^}]*)*\}/s,
    newBlock
  );

  // Write back
  writeFileSync(MODEL_CONSTANTS_PATH, newContent);

  console.log(
    `\n✓ Updated COPILOT_MODELS with ${discovered.chatModelIds.length} models`
  );
  console.log("\nNew models added:");
  discovered.chatModelIds.forEach((id) => {
    if (!existingLabels[id]) {
      console.log(`  + ${id}`);
    }
  });

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
    const models = parseModelConstants();
    updatePackageJson(models, checkOnly);
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
