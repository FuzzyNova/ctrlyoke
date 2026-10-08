#!/usr/bin/env node

/**
 * Generates `src/types/generated/WorkflowSchemaOutline.ts`: for each schema
 * object kind a workflow file can hold at the cursor (root, prompt step,
 * `endCondition`, ...), the keys it accepts, each key's value kind, enum
 * values, default, description and deprecated flag, plus the keys the schema
 * forbids there.
 *
 * `SchemaDescriptions.ts` is a flat path -> description map and cannot say
 * which keys are valid in which object; this is its structural companion.
 * Completion, hover and diagnostics read this instead of the schema file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = resolve(ROOT, "schemas/workflow-schema.json");
const OUTPUT_PATH = resolve(
  ROOT,
  "src/types/generated/WorkflowSchemaOutline.ts"
);
const CHECK_MODE = process.argv.includes("--check");
const HEADER =
  "// AUTO-GENERATED from schemas/workflow-schema.json by scripts/generate-workflow-schema-outline.mjs. Do not edit by hand.";

/** Keys the execution engine writes; they are never authored. */
const RUNTIME_ONLY_KEYS = new Set([
  "_runtime",
  "startedAt",
  "definitionRevision",
  "parallelGroups",
]);

/**
 * Outline entry -> where its keys come from. The names are the values of
 * `WORKFLOW_OBJECT_KINDS` in DashboardConstants.ts (the generated module is
 * type-checked against that union, so a rename fails the build).
 */
const OBJECT_SOURCES = {
  workflowRoot: { pointers: ["#/oneOf/0", "#/oneOf/1"] },
  promptStep: {
    pointers: ["#/$defs/promptStep"],
    forbiddenFrom: ["#/$defs/workflowStep"],
  },
  scriptStep: {
    pointers: ["#/$defs/scriptStep"],
    forbiddenFrom: ["#/$defs/workflowStep"],
  },
  parallelGroup: { pointers: ["#/$defs/parallelGroupItem"] },
  endCondition: { pointers: ["#/$defs/endCondition"] },
  preCondition: { pointers: ["#/$defs/preCondition"] },
  toolPermissions: { pointers: ["#/$defs/toolPermissions"] },
  errorBehavior: { pointers: ["#/$defs/errorBehavior"] },
  hook: { pointers: ["#/$defs/userHookConfig"] },
  worktree: { pointers: ["#/$defs/worktreeConfig"] },
  templateMeta: { pointers: ["#/$defs/templateMetadata"] },
  // A `.prompt.md` file's frontmatter only carries the format version.
  promptFileFrontmatter: {
    pointers: ["#/oneOf/1"],
    only: ["schemaVersion"],
  },
};

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(schema, pointer) {
  return pointer
    .slice(2)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce(
      (node, part) =>
        isObject(node) || Array.isArray(node) ? node[part] : undefined,
      schema
    );
}

/** Follows `$ref`; sibling keywords (usually a more specific description) win. */
function deref(schema, node, depth = 0) {
  if (!isObject(node) || typeof node.$ref !== "string" || depth > 20) {
    return node;
  }
  const { $ref, ...siblings } = node;
  const target = resolvePointer(schema, $ref);
  if (!isObject(target)) return node;
  return { ...deref(schema, target, depth + 1), ...siblings };
}

/** Properties of an object schema, merged through `$ref`, `allOf` and `oneOf`/`anyOf`. */
function collectProperties(schema, raw, properties = new Map(), depth = 0) {
  if (depth > 20) return properties;
  const node = deref(schema, raw);
  if (!isObject(node)) return properties;
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    if (isObject(property) && !properties.has(key)) {
      properties.set(key, property);
    }
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of node[keyword] ?? []) {
      collectProperties(schema, branch, properties, depth + 1);
    }
  }
  return properties;
}

/** Keys an object cannot carry, from `not: { required: [key] }` branches. */
function collectForbiddenKeys(schema, raw, forbidden = new Set(), depth = 0) {
  if (depth > 20) return forbidden;
  const node = deref(schema, raw);
  if (!isObject(node)) return forbidden;
  const required = node.not?.required;
  if (Array.isArray(required) && required.length === 1) {
    forbidden.add(required[0]);
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of node[keyword] ?? []) {
      // A oneOf is a choice, not a restriction on every branch.
      if (keyword === "allOf")
        collectForbiddenKeys(schema, branch, forbidden, depth + 1);
    }
  }
  return forbidden;
}

const KIND_BY_SCHEMA_TYPE = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
};

/** Every value kind a property accepts, across its oneOf/anyOf alternatives. */
function collectValueKinds(schema, raw, kinds = new Set(), depth = 0) {
  if (depth > 20) return kinds;
  const node = deref(schema, raw);
  if (!isObject(node)) return kinds;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  for (const type of types) {
    if (KIND_BY_SCHEMA_TYPE[type]) kinds.add(KIND_BY_SCHEMA_TYPE[type]);
  }
  if (node.type === undefined && Object.hasOwn(node, "const")) {
    kinds.add(KIND_BY_SCHEMA_TYPE[typeof node.const] ?? "string");
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    for (const branch of node[keyword] ?? []) {
      collectValueKinds(schema, branch, kinds, depth + 1);
    }
  }
  return kinds;
}

/** Literal values (enum/const) a property accepts. The empty string is a UI sentinel, not a suggestion. */
function collectEnumValues(schema, raw, values = [], depth = 0) {
  if (depth > 20) return values;
  const node = deref(schema, raw);
  if (!isObject(node)) return values;
  const literals = [];
  if (Array.isArray(node.enum)) literals.push(...node.enum);
  if (Object.hasOwn(node, "const")) literals.push(node.const);
  for (const literal of literals) {
    if (literal !== "" && literal !== null && !values.includes(literal)) {
      values.push(literal);
    }
  }
  for (const keyword of ["oneOf", "anyOf"]) {
    for (const branch of node[keyword] ?? []) {
      collectEnumValues(schema, branch, values, depth + 1);
    }
  }
  return values;
}

function firstDefined(schema, raw, field, depth = 0) {
  if (depth > 20) return undefined;
  const node = deref(schema, raw);
  if (!isObject(node)) return undefined;
  if (node[field] !== undefined) return node[field];
  for (const keyword of ["oneOf", "anyOf"]) {
    for (const branch of node[keyword] ?? []) {
      const found = firstDefined(schema, branch, field, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function describeProperty(schema, raw) {
  const kinds = [...collectValueKinds(schema, raw)];
  const entry = {
    valueKind:
      kinds.length === 1 ? kinds[0] : kinds.length === 0 ? "string" : "oneOf",
  };
  if (kinds.length > 1) entry.alternatives = kinds;
  const enumValues = collectEnumValues(schema, raw);
  if (enumValues.length) entry.enum = enumValues;
  const defaultValue = firstDefined(schema, raw, "default");
  if (defaultValue !== undefined) entry.default = defaultValue;
  const description = firstDefined(schema, raw, "description");
  if (typeof description === "string") entry.description = description;
  if (firstDefined(schema, raw, "deprecated") === true) entry.deprecated = true;
  return entry;
}

export function buildWorkflowSchemaOutline(schema) {
  const outline = {};
  for (const [objectKind, source] of Object.entries(OBJECT_SOURCES)) {
    const properties = new Map();
    const forbidden = new Set();
    for (const pointer of source.pointers) {
      const node = resolvePointer(schema, pointer);
      if (!isObject(node)) {
        throw new Error(
          `Outline source ${pointer} (${objectKind}) not found in the workflow schema`
        );
      }
      collectProperties(schema, node, properties);
      collectForbiddenKeys(schema, node, forbidden);
    }
    for (const pointer of source.forbiddenFrom ?? []) {
      collectForbiddenKeys(schema, resolvePointer(schema, pointer), forbidden);
    }
    // A key the schema both lists and forbids is forbidden (`worktree` on a step).
    const keys = [...properties.keys()].filter(
      (key) =>
        !RUNTIME_ONLY_KEYS.has(key) &&
        !forbidden.has(key) &&
        (source.only === undefined || source.only.includes(key))
    );
    if (keys.length === 0) {
      throw new Error(`Outline for ${objectKind} resolved no keys`);
    }
    outline[objectKind] = {
      properties: Object.fromEntries(
        keys.map((key) => [key, describeProperty(schema, properties.get(key))])
      ),
      forbiddenKeys: [...forbidden].sort(),
    };
  }
  return outline;
}

export function buildWorkflowSchemaOutlineModule(schema) {
  const outline = buildWorkflowSchemaOutline(schema);
  return `${HEADER}

import type { WorkflowObjectKind } from "../DashboardConstants";

/** Value kinds a schema property can take; \`oneOf\` lists them in \`alternatives\`. */
export type WorkflowOutlineValueKind =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "oneOf";

export interface WorkflowOutlineProperty {
  readonly valueKind: WorkflowOutlineValueKind;
  /** The kinds accepted when \`valueKind\` is \`oneOf\`. */
  readonly alternatives?: readonly Exclude<WorkflowOutlineValueKind, "oneOf">[];
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: string | number | boolean | null;
  readonly description?: string;
  readonly deprecated?: true;
}

export interface WorkflowObjectOutline {
  /** Authorable keys, in schema order. Runtime-only fields are excluded. */
  readonly properties: Readonly<Record<string, WorkflowOutlineProperty>>;
  /** Keys the schema forbids in this object (e.g. \`worktree\` on a step). */
  readonly forbiddenKeys: readonly string[];
}

export const WORKFLOW_SCHEMA_OUTLINE: Readonly<
  Partial<Record<WorkflowObjectKind, WorkflowObjectOutline>>
> = ${JSON.stringify(outline, null, 2)};
`;
}

function main() {
  const content = buildWorkflowSchemaOutlineModule(
    JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"))
  );
  if (CHECK_MODE) {
    if (
      !existsSync(OUTPUT_PATH) ||
      readFileSync(OUTPUT_PATH, "utf8") !== content
    ) {
      console.error(
        "Workflow schema outline is out of date. Run npm run generate-workflow-schema-outline."
      );
      process.exitCode = 1;
      return;
    }
    console.log("Workflow schema outline is up to date.");
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, content, "utf8");
  console.log(`Written: ${OUTPUT_PATH}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
