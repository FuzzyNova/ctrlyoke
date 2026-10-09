#!/usr/bin/env node

/**
 * Generate YAML schema from JSON schema
 *
 * This script auto-generates schemas/workflow-schema.yaml from schemas/workflow-schema.json
 * Ensures single source of truth for validation schema
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.join(__dirname, "..");
const jsonSchemaPath = path.join(rootDir, "schemas", "workflow-schema.json");
const yamlSchemaPath = path.join(rootDir, "schemas", "workflow-schema.yaml");

const TITLE_ACRONYMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["cli", "CLI"],
  ["env", "Env"],
  ["id", "ID"],
  ["ids", "IDs"],
  ["mcp", "MCP"],
  ["url", "URL"],
  ["usd", "USD"],
]);

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYWORDS = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
];
/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "patternProperties"];

/** Turn a property key such as `resumeSession` into `Resume Session`. */
export function humanizePropertyKey(key) {
  return key
    .replace(/^[_$]+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(
      (word) =>
        TITLE_ACRONYMS.get(word.toLowerCase()) ??
        word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ");
}

/**
 * Give every property subschema a `title` naming its key.
 *
 * The YAML language server titles a hover with the matched schema's own
 * `title`, falling back to the closest ancestor's (`closestTitle`). Without
 * per-property titles every key in a workflow file hovers as the enclosing
 * root branch ("Multiple Steps (or Working File)", "ctrlyoke Prompt Schema").
 * The titles live only in the generated YAML schema so the JSON source stays
 * free of ~200 redundant hand-maintained labels.
 */
export function addPropertyTitles(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      child.title === undefined
    ) {
      const title = humanizePropertyKey(key);
      if (title) child.title = title;
    }
    addPropertyTitles(child);
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) addPropertyTitles(schema[keyword]);
  for (const keyword of SUBSCHEMA_ARRAY_KEYWORDS) {
    for (const child of schema[keyword] ?? []) addPropertyTitles(child);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    for (const child of Object.values(schema[keyword] ?? {})) {
      addPropertyTitles(child);
    }
  }
}

function main() {
  try {
    // Read JSON schema
    const jsonSchema = JSON.parse(fs.readFileSync(jsonSchemaPath, "utf8"));
    addPropertyTitles(jsonSchema);

    // Convert to YAML with nice formatting
    const yamlSchema = yaml.dump(jsonSchema, {
      indent: 2,
      lineWidth: 100,
      noRefs: true,
      sortKeys: false,
    });

    // Write YAML schema
    fs.writeFileSync(yamlSchemaPath, yamlSchema, "utf8");

    console.log("✅ Generated schemas/workflow-schema.yaml from JSON schema");
  } catch (error) {
    console.error("❌ Failed to generate YAML schema:", error.message);
    process.exit(1);
  }
}

if (path.resolve(process.argv[1] ?? "") === __filename) main();
