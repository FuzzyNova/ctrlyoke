#!/usr/bin/env node

/**
 * Generate YAML schema from JSON schema
 *
 * This script auto-generates schemas/prompt-schema.yaml from schemas/prompt-schema.json
 * Ensures single source of truth for validation schema
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.join(__dirname, "..");
const jsonSchemaPath = path.join(rootDir, "schemas", "prompt-schema.json");
const yamlSchemaPath = path.join(rootDir, "schemas", "prompt-schema.yaml");

try {
  // Read JSON schema
  const jsonSchema = JSON.parse(fs.readFileSync(jsonSchemaPath, "utf8"));

  // Convert to YAML with nice formatting
  const yamlSchema = yaml.dump(jsonSchema, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });

  // Write YAML schema
  fs.writeFileSync(yamlSchemaPath, yamlSchema, "utf8");

  console.log("✅ Generated schemas/prompt-schema.yaml from JSON schema");
} catch (error) {
  console.error("❌ Failed to generate YAML schema:", error.message);
  process.exit(1);
}
