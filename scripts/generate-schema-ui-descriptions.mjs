#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSchemaRefs } from "./generate-schema-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_PATH = resolve(ROOT, "schemas/settings-schema.json");
const WORKFLOW_PATH = resolve(ROOT, "schemas/workflow-schema.json");
const OUTPUT_PATH = resolve(ROOT, "src/types/generated/SchemaDescriptions.ts");
const CHECK_MODE = process.argv.includes("--check");
const HEADER =
  "// AUTO-GENERATED from schemas/settings-schema.json and schemas/workflow-schema.json. Do not edit by hand.";

function collectSchemaUiData(settingsSchema, workflowSchema) {
  const siblingSchemas = {
    "settings-schema.json": settingsSchema,
    "workflow.json": workflowSchema,
    "workflow-schema.json": workflowSchema,
  };
  const descriptions = {};
  const enums = {};
  const variants = {};

  /**
   * The literal that selects a composition branch: the branch's own `const`
   * (`worktree: false`), or the `const` of its discriminator property
   * (`worktree: { mode: managed }`). Branches without one are not options.
   */
  function variantKey(branch) {
    if (Object.hasOwn(branch, "const")) return String(branch.const);
    for (const property of Object.values(branch.properties ?? {})) {
      if (property && Object.hasOwn(property, "const")) {
        return String(property.const);
      }
    }
    return undefined;
  }

  function visit(raw, source, path, depth = 0) {
    if (!raw || typeof raw !== "object" || depth > 40) return;
    const schema = resolveSchemaRefs(raw, source, siblingSchemas);
    if (schema.description && !(path in descriptions)) {
      descriptions[path] = schema.description;
    }

    const values = [];
    if (Array.isArray(schema.enum)) values.push(...schema.enum);
    if (Object.hasOwn(schema, "const")) values.push(schema.const);
    if (values.length) {
      enums[path] = [...new Set([...(enums[path] ?? []), ...values])];
    }

    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      visit(child, source, path ? `${path}.${name}` : name, depth + 1);
    }
    if (schema.items) visit(schema.items, source, `${path}[]`, depth + 1);
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      visit(schema.additionalProperties, source, `${path}.*`, depth + 1);
    }
    for (const key of ["oneOf", "anyOf"]) {
      for (const alternative of schema[key] ?? []) {
        const branch = resolveSchemaRefs(alternative, source, siblingSchemas);
        const variant = variantKey(branch);
        if (path && variant !== undefined && branch.description) {
          variants[path] ??= {};
          variants[path][variant] ??= branch.description;
        }
      }
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      for (const alternative of schema[key] ?? []) {
        visit(alternative, source, path, depth + 1);
      }
    }
  }

  visit(settingsSchema, settingsSchema, "");
  visit(workflowSchema, workflowSchema, "");
  delete descriptions[""];
  delete enums[""];
  return {
    descriptions: Object.fromEntries(Object.entries(descriptions).sort()),
    enums: Object.fromEntries(Object.entries(enums).sort()),
    variants: Object.fromEntries(Object.entries(variants).sort()),
  };
}

export function buildSchemaDescriptionsModule(settingsSchema, workflowSchema) {
  const { descriptions, enums, variants } = collectSchemaUiData(
    settingsSchema,
    workflowSchema
  );
  return `${HEADER}\n\nexport const SCHEMA_DESCRIPTIONS: Readonly<Record<string, string>> = ${JSON.stringify(descriptions, null, 2)};\n\nexport const SCHEMA_ENUMS: Readonly<Record<string, readonly (string | number | boolean | null)[]>> = ${JSON.stringify(enums, null, 2)};\n\n/** Descriptions of oneOf/anyOf branches, keyed by property path, then by the literal that selects the branch. */\nexport const SCHEMA_VARIANT_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(variants, null, 2)};\n`;
}

function main() {
  const content = buildSchemaDescriptionsModule(
    JSON.parse(readFileSync(SETTINGS_PATH, "utf8")),
    JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"))
  );
  if (CHECK_MODE) {
    if (
      !existsSync(OUTPUT_PATH) ||
      readFileSync(OUTPUT_PATH, "utf8") !== content
    ) {
      console.error(
        "Schema UI descriptions are out of date. Run npm run generate-schema-ui-descriptions."
      );
      process.exitCode = 1;
      return;
    }
    console.log("Schema UI descriptions are up to date.");
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, content, "utf8");
  console.log(`Written: ${OUTPUT_PATH}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
