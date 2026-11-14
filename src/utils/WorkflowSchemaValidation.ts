import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { isRecord } from "./JsonTypeGuards";
import { Log } from "./Log";

/**
 * The bundled workflow schema compiled once per process on one Ajv instance.
 * `PromptFileParser` validates whole documents with it and `VarSubstitutor`
 * validates substituted values against sub-schemas of the same instance, so
 * neither copies schema rules and neither depends on the other being loaded.
 */
export interface CompiledWorkflowSchema {
  readonly schema: Record<string, unknown>;
  readonly ajv: Ajv;
  readonly strictValidator: ValidateFunction;
  readonly relaxedValidator: ValidateFunction;
}

const compiledBySchemaPath = new Map<string, CompiledWorkflowSchema>();
const pointerValidators = new WeakMap<
  CompiledWorkflowSchema,
  Map<string, ValidateFunction>
>();

function resolveWorkflowSchemaPath(): string {
  // The bundled entry points (esbuild, __dirname === out/) get schemas copied
  // to out/schemas/. The tsc-compiled output (__dirname === out/utils/) has no
  // such copy, so fall back to the sibling out/schemas/ directory.
  const candidatePaths = [
    path.join(__dirname, "schemas", "workflow-schema.json"),
    path.join(__dirname, "..", "schemas", "workflow-schema.json"),
  ];
  const schemaPath = candidatePaths.find((candidate) =>
    fs.existsSync(candidate)
  );
  if (!schemaPath) {
    throw new Error(
      `workflow-schema.json not found in any of: ${candidatePaths.join(", ")}`
    );
  }
  return path.resolve(schemaPath);
}

/**
 * The strict schema without `unevaluatedProperties: false`, used to tell
 * unknown-key closures apart from real schema failures.
 */
function createRelaxedSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const relaxed = structuredClone(schema);
  // The strict schema is already registered by its $id on this Ajv
  // instance. The relaxed variant is an in-memory validation helper and
  // must not claim that same globally addressable schema identity.
  delete relaxed.$id;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value.unevaluatedProperties === false) {
      delete value.unevaluatedProperties;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(relaxed);
  return relaxed;
}

/** Load and compile the bundled workflow schema; throws when it is missing. */
export function loadCompiledWorkflowSchema(): CompiledWorkflowSchema {
  const schemaPath = resolveWorkflowSchemaPath();
  let compiled = compiledBySchemaPath.get(schemaPath);
  if (compiled) return compiled;
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  compiled = {
    schema,
    ajv,
    strictValidator: ajv.compile(schema),
    relaxedValidator: ajv.compile(createRelaxedSchema(schema)),
  };
  compiledBySchemaPath.set(schemaPath, compiled);
  Log.debug("[WorkflowSchemaValidation] JSON schema loaded successfully");
  return compiled;
}

/** Validate `value` against the workflow sub-schema at JSON pointer `pointer`. */
export function validateWorkflowSchemaValue(
  pointer: string,
  value: unknown
): boolean {
  const compiled = loadCompiledWorkflowSchema();
  let validators = pointerValidators.get(compiled);
  if (!validators) {
    validators = new Map();
    pointerValidators.set(compiled, validators);
  }
  let validate = validators.get(pointer);
  if (!validate) {
    validate = compiled.ajv.compile({
      $ref: `${String(compiled.schema.$id)}#${pointer}`,
    });
    validators.set(pointer, validate);
  }
  return validate(value) as boolean;
}

/** The schema node at JSON pointer `pointer` (`#`-less), or `undefined`. */
export function getWorkflowSchemaNode(pointer: string): unknown {
  return resolveSchemaPointer(loadCompiledWorkflowSchema().schema, pointer);
}

function resolveSchemaPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (node, segment) =>
        isRecord(node) || Array.isArray(node)
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      root
    );
}

const LOCAL_REF_PREFIX = "#";
/** JSON Schema `type` keywords the value description understands. */
const SCHEMA_TYPES = {
  BOOLEAN: "boolean",
  INTEGER: "integer",
  NUMBER: "number",
  STRING: "string",
} as const;

/**
 * Describe the values a workflow sub-schema accepts, for validation messages:
 * `a number greater than 0`, `one of "headless", "interactive"`, ….
 */
export function describeWorkflowSchemaValue(pointer: string): string {
  const root = loadCompiledWorkflowSchema().schema;
  const describe = (node: unknown): string => {
    if (!isRecord(node)) return "a valid value";
    if (typeof node.$ref === "string" && node.$ref.startsWith(LOCAL_REF_PREFIX))
      return describe(
        resolveSchemaPointer(root, node.$ref.slice(LOCAL_REF_PREFIX.length))
      );
    const choices = node.oneOf ?? node.anyOf;
    if (Array.isArray(choices)) return choices.map(describe).join(" or ");
    if ("const" in node) return JSON.stringify(node.const);
    if (Array.isArray(node.enum))
      return node.enum.length === 1
        ? JSON.stringify(node.enum[0])
        : `one of ${node.enum.map((value) => JSON.stringify(value)).join(", ")}`;
    if (node.type === SCHEMA_TYPES.BOOLEAN) return "true or false";
    if (
      node.type === SCHEMA_TYPES.INTEGER ||
      node.type === SCHEMA_TYPES.NUMBER
    ) {
      const noun =
        node.type === SCHEMA_TYPES.INTEGER ? "an integer" : "a number";
      const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = node;
      if (typeof minimum === "number" && typeof maximum === "number")
        return `${noun} from ${minimum} to ${maximum}`;
      const bounds = [
        typeof exclusiveMinimum === "number"
          ? `greater than ${exclusiveMinimum}`
          : undefined,
        typeof minimum === "number" ? `of at least ${minimum}` : undefined,
        typeof exclusiveMaximum === "number"
          ? `less than ${exclusiveMaximum}`
          : undefined,
        typeof maximum === "number" ? `of at most ${maximum}` : undefined,
      ].filter((bound): bound is string => bound !== undefined);
      return [noun, bounds.join(" and ")].filter(Boolean).join(" ");
    }
    if (node.type === SCHEMA_TYPES.STRING) return "a string";
    return "a valid value";
  };
  return describe(resolveSchemaPointer(root, pointer));
}
