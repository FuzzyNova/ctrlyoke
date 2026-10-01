#!/usr/bin/env node

/**
 * Generate the public settings and workflow-schema reference pages.
 *
 * Every field, type, allowed value, constraint, and description comes from
 * schemas/settings-schema.json and schemas/workflow-schema.json. Settings
 * defaults come from the compiled CTRLYOKE_SETTINGS_DEFAULTS object, so the
 * pages never keep a second copy of either. Hand-written prose (examples,
 * how-to notes) lives in docs/reference/_partials/<page>/<section>.md and is
 * inlined under the matching section heading.
 *
 * Partials are for docs-only content: YAML examples, cross-links to guide
 * pages, and narrative that would be noise in an editor hover. A rule about
 * what a field accepts or how it behaves belongs in the schema description,
 * where IntelliSense, validation messages, and this page all read it. When the
 * page renders a schema shape poorly, fix the renderer here rather than
 * restating the shape in a partial. Never edit the generated pages directly.
 *
 * The generator fails when an authored field has no description, when a
 * workflow-schema definition is not assigned to a page section, or when a
 * partial names a section that no longer exists, so schema growth cannot
 * silently skip the docs.
 *
 * Usage:
 *   npm run generate-schema-docs
 *   npm run check:schema-docs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const REFERENCE_DIR = resolve(ROOT_DIR, "docs/reference");
const PARTIALS_DIR = resolve(REFERENCE_DIR, "_partials");
const SETTINGS_SCHEMA_PATH = resolve(ROOT_DIR, "schemas/settings-schema.json");
const WORKFLOW_SCHEMA_PATH = resolve(ROOT_DIR, "schemas/workflow-schema.json");
const COMPILED_SETTINGS_PATH = resolve(
  ROOT_DIR,
  "out/types/CtrlYokeSettings.js"
);
const require = createRequire(import.meta.url);
const CHECK_MODE = process.argv.includes("--check");

const GENERATED_HEADER =
  "<!-- AUTO-GENERATED from the JSON schemas — edit the schema descriptions or docs/reference/_partials/, then run `npm run generate-schema-docs` -->";

const INLINE_VALUE_MAX_LENGTH = 80;
const SHAPE_LABEL_MAX_KEYS = 3;

/** Phrases that belong in contributor docs, not in public field descriptions. */
const INTERNAL_DESCRIPTION_PATTERNS = [
  /\bdev\/(?:backlog|implemented|reference|research)\//,
  /\b[A-Z][A-Za-z]+\.[a-zA-Z]+\(\)/,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+_KEYS\b/,
  /\bctrlyoke\.[a-zA-Z]+ setting\b/,
  /\bVS Code settings\b/,
];

const SETTINGS_PAGE = "settings";
const WORKFLOW_PAGE = "workflow-schema";
const RUN_FILES_PAGE = "run-files";

/**
 * Workflow-schema definitions that only compose other definitions. Their
 * fields are documented through the sections that reference them.
 */
const STRUCTURAL_WORKFLOW_DEFINITIONS = new Set([
  "agent",
  "errorBehaviorDefault",
  "endConditionDefault",
  "maxStepsValue",
  "unlimitedValue",
  "mcpServerEntry",
  "preConditionDefault",
  "priorContext",
  "priorContextKeyword",
  "priorContextPromptNumbers",
  "priorContextPreviousCount",
  "secrets",
  "skills",
  "singleStepRoot",
  "toolPermissions",
  "workflowStep",
]);

const WORKFLOW_ROOT_PROPERTIES = "#/oneOf/1/allOf/2/properties";

/** Section layout for the two workflow-schema pages, in reading order. */
const WORKFLOW_PAGES = [
  {
    page: WORKFLOW_PAGE,
    title: "Workflow schema reference",
    description:
      "Every field a ctrlyoke workflow file accepts, generated from schemas/workflow-schema.json.",
    strict: true,
    sections: [
      {
        id: "workflow-file",
        title: "Workflow file",
        summary: "Root fields of a multi-step workflow file.",
        properties: [
          {
            pointer: WORKFLOW_ROOT_PROPERTIES,
            include: ["steps", "finalStep"],
          },
          { pointer: "#/$defs/workflowOnlyProperties/properties" },
          { pointer: "#/properties" },
        ],
        refs: ["#/$defs/workflowOnlyProperties"],
        linkSettingsDefaults: true,
      },
      {
        id: "execution-properties",
        title: "Execution properties",
        refs: ["#/$defs/executionProperties"],
        properties: [{ pointer: "#/$defs/executionProperties/properties" }],
        linkSettingsDefaults: true,
      },
      {
        id: "prompt-step",
        title: "Prompt step",
        summary: "A step that sends a prompt to a harness.",
        refs: ["#/$defs/promptStep"],
        properties: [{ pointer: "#/$defs/promptStep/allOf/1/properties" }],
      },
      {
        id: "script-step",
        title: "Script step",
        refs: ["#/$defs/scriptStep", "#/$defs/rootScriptStep"],
        properties: [{ pointer: "#/$defs/scriptStep/properties" }],
      },
      {
        id: "parallel-group",
        title: "Parallel group",
        refs: ["#/$defs/parallelGroupItem"],
        properties: [{ pointer: "#/$defs/parallelGroupItem/properties" }],
      },
      {
        id: "pre-condition",
        title: "Pre-condition",
        refs: ["#/$defs/preCondition"],
        properties: [{ pointer: "#/$defs/preCondition/properties" }],
      },
      {
        id: "end-condition",
        title: "End condition",
        refs: ["#/$defs/endCondition"],
        properties: [{ pointer: "#/$defs/endCondition/properties" }],
      },
      {
        id: "script-fields",
        title: "Shared script fields",
        refs: ["#/$defs/scriptProperties"],
        properties: [{ pointer: "#/$defs/scriptProperties/properties" }],
      },
      {
        id: "error-behavior",
        title: "Error behavior",
        refs: ["#/$defs/errorBehavior"],
        properties: [{ pointer: "#/$defs/errorBehavior/properties" }],
      },
      {
        id: "worktree",
        title: "Worktree",
        summary:
          "Where the workflow runs: the working checkout or a Git worktree.",
        refs: ["#/$defs/worktreeConfig"],
        schema: "#/$defs/worktreeConfig",
      },
      {
        id: "vars",
        title: "Variables",
        refs: ["#/$defs/varsConfig"],
        schema: "#/$defs/varsConfig",
      },
      {
        id: "hook-entry",
        title: "Hook entry",
        summary: "One user-defined hook in a `hooks` array.",
        refs: ["#/$defs/userHookConfig"],
        properties: [{ pointer: "#/$defs/userHookConfig/properties" }],
      },
      {
        id: "mcp-server-entry",
        title: "MCP server entry",
        refs: ["#/$defs/mcpServerConfig"],
        properties: [{ pointer: "#/$defs/mcpServerConfig/properties" }],
      },
      {
        id: "run-address",
        title: "Run address",
        summary: "Identifies one completed run for `priorContext` imports.",
        refs: ["#/$defs/workflowRunAddress"],
        properties: [{ pointer: "#/$defs/workflowRunAddress/properties" }],
      },
      {
        id: "harness-ids",
        title: "Harness IDs",
        summary: "The harnesses a workflow or step can select.",
        refs: ["#/$defs/harnessId"],
        schema: "#/$defs/harnessId",
      },
      {
        id: "template-metadata",
        title: "Template metadata",
        refs: ["#/$defs/templateMetadata"],
        properties: [{ pointer: "#/$defs/templateMetadata/properties" }],
      },
      {
        id: "template-variable",
        title: "Template variable",
        summary: "One entry in `_templateMeta.variables`.",
        refs: ["#/$defs/templateVariableMetadata"],
        properties: [
          { pointer: "#/$defs/templateVariableMetadata/properties" },
        ],
      },
      {
        id: "template-placeholder",
        title: "Template placeholder",
        refs: ["#/$defs/templatePlaceholder"],
        schema: "#/$defs/templatePlaceholder",
      },
    ],
  },
  {
    page: RUN_FILES_PAGE,
    title: "Run file reference",
    description:
      "Fields ctrlyoke writes into a run's working copy while it executes, generated from schemas/workflow-schema.json.",
    strict: false,
    sections: [
      {
        id: "run-file-root",
        title: "Run file root",
        summary: "Root fields present only in a run's working copy.",
        properties: [
          {
            pointer: WORKFLOW_ROOT_PROPERTIES,
            include: [
              "startedAt",
              "definitionRevision",
              "parallelGroups",
              "_runtime",
            ],
          },
        ],
      },
      {
        id: "workflow-runtime",
        title: "Workflow runtime",
        refs: ["#/$defs/runtimeMetadata"],
        properties: [{ pointer: "#/$defs/runtimeMetadata/properties" }],
      },
      {
        id: "step-runtime",
        title: "Step runtime",
        refs: ["#/$defs/promptRuntimeMetadata"],
        properties: [
          { pointer: "#/$defs/promptRuntimeMetadata/allOf/3/properties" },
        ],
      },
      {
        id: "parallel-group-topology",
        title: "Parallel group topology",
        refs: ["#/$defs/parallelGroupDefinition"],
        properties: [{ pointer: "#/$defs/parallelGroupDefinition/properties" }],
      },
      {
        id: "condition-evaluation",
        title: "Condition evaluation",
        refs: ["#/$defs/conditionEvaluationSummary"],
        properties: [
          { pointer: "#/$defs/conditionEvaluationSummary/properties" },
        ],
      },
      {
        id: "token-totals",
        title: "Token totals",
        refs: ["#/$defs/workflowTokenTotals"],
        properties: [{ pointer: "#/$defs/workflowTokenTotals/properties" }],
      },
      {
        id: "harness-token-totals",
        title: "Harness token totals",
        refs: ["#/$defs/harnessTokenTotals"],
        properties: [{ pointer: "#/$defs/harnessTokenTotals/properties" }],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

function code(text) {
  if (text.includes("{{")) {
    // VitePress compiles each page as a Vue template and, unlike fenced
    // blocks, inline code is not v-pre, so `{{name}}` would be interpolated.
    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return `<code v-pre>${escaped}</code>`;
  }
  return `\`${text}\``;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Render schema description text as Markdown. Descriptions are plain text
 * apart from backtick code spans, so everything outside code is escaped:
 * `<` would open an HTML/Vue tag, `{{ }}` is Vue interpolation, and `_`/`*`
 * would start emphasis.
 */
function prose(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? code(part.slice(1, -1))
        : part
            .replace(/\{\{[^}]*\}\}/g, (match) => `\u0000${match}\u0000`)
            .split("\u0000")
            .map((piece, pieceIndex) =>
              pieceIndex % 2 === 1
                ? code(piece)
                : piece
                    .replaceAll("\\", "\\\\")
                    .replaceAll("<", "&lt;")
                    .replaceAll("_", "\\_")
                    .replaceAll("*", "\\*")
            )
            .join("")
    )
    .join("");
}

function tableCell(text) {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function firstSentence(text) {
  const match = /^(.+?\.)(\s|$)/.exec(text);
  return match ? match[1] : text;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

export function schemaForPointer(schema, pointer, siblingSchemas = {}) {
  if (pointer.startsWith("#")) return schema;
  const separator = pointer.indexOf("#");
  const schemaFile = separator === -1 ? pointer : pointer.slice(0, separator);
  // A sibling on another published version is referenced as `../v<N>/<file>`
  // (see scripts/schema-bump.mjs); only the current sibling is loaded here.
  const pointerSchema = siblingSchemas[schemaFile.split("/").pop()];
  if (!pointerSchema) {
    throw new Error(`Unknown sibling schema reference: ${pointer}`);
  }
  return pointerSchema;
}

export function qualifyLocalReferences(schema, schemaFile) {
  if (Array.isArray(schema)) {
    return schema.map((value) => qualifyLocalReferences(value, schemaFile));
  }
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string" && value.startsWith("#")
        ? `${schemaFile}${value}`
        : qualifyLocalReferences(value, schemaFile),
    ])
  );
}

export function resolvePointer(schema, pointer, siblingSchemas = {}) {
  const pointerSchema = schemaForPointer(schema, pointer, siblingSchemas);
  const separator = pointer.indexOf("#");
  const localPointer = pointer.startsWith("#")
    ? pointer
    : separator === -1
      ? "#"
      : pointer.slice(separator);
  if (!localPointer.startsWith("#")) {
    throw new Error(`Only JSON pointers are supported: ${pointer}`);
  }
  return localPointer
    .slice(1)
    .split("/")
    .filter(Boolean)
    .reduce((node, segment) => {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (node === null || typeof node !== "object" || !(key in node)) {
        throw new Error(`Unresolvable schema pointer: ${pointer}`);
      }
      return node[key];
    }, pointerSchema);
}

/** Resolve a schema node's reference chain, including refs into sibling schemas. */
export function resolveSchemaRefs(rawSchema, schema, siblingSchemas = {}) {
  let current = rawSchema;
  let currentSchema = schema;
  const seen = new Set();
  while (current?.$ref) {
    const ref = current.$ref;
    if (seen.has(ref)) throw new Error(`Circular schema reference: ${ref}`);
    seen.add(ref);
    const separator = ref.indexOf("#");
    const schemaFile = ref.startsWith("#")
      ? undefined
      : ref.slice(0, separator);
    const resolvedSchema = schemaForPointer(currentSchema, ref, siblingSchemas);
    const referenced = resolvePointer(currentSchema, ref, siblingSchemas);
    const { $ref: _ref, ...siblings } = current;
    current = {
      ...(schemaFile
        ? qualifyLocalReferences(referenced, schemaFile)
        : referenced),
      ...siblings,
    };
    currentSchema = resolvedSchema;
  }
  return current;
}

function isRemoved(schema) {
  return (
    schema.not !== undefined &&
    typeof schema.not === "object" &&
    Object.keys(schema.not).length === 0
  );
}

function alternativesOf(schema) {
  return schema.oneOf ?? schema.anyOf ?? null;
}

class SchemaRenderer {
  /**
   * @param {object} schema - root schema document
   * @param {string} page - page being rendered, for relative links
   * @param {Map<string, { label: string, page: string, anchor: string }>} refTargets
   * @param {Record<string, object>} siblingSchemas
   */
  constructor(schema, page, refTargets, siblingSchemas = {}) {
    this.schema = schema;
    this.page = page;
    this.refTargets = refTargets;
    this.siblingSchemas = siblingSchemas;
    this.missingDescriptions = [];
    this.internalDescriptions = [];
  }

  href(target) {
    return target.page === this.page
      ? `#${target.anchor}`
      : `/reference/${target.page}#${target.anchor}`;
  }

  sectionTarget(schema) {
    return schema.$ref ? this.refTargets.get(schema.$ref) : undefined;
  }

  /** Inline every `$ref` that does not point at a documented section. */
  deref(schema) {
    if (this.refTargets.has(schema.$ref)) return schema;
    return resolveSchemaRefs(schema, this.schema, this.siblingSchemas);
  }

  typeLabel(raw) {
    const target = this.sectionTarget(raw);
    if (target) {
      return `[${target.label}](${this.href(target)})`;
    }
    const schema = this.deref(raw);
    if (isRemoved(schema)) {
      return "removed";
    }
    // A oneOf can constrain which property combination is valid without
    // changing the containing object's shape (for example, exactly one of
    // command/url). Keep documenting the declared object properties.
    if (schema.type === "object" && schema.properties) {
      return this.objectLabel(schema);
    }
    if ("const" in schema) {
      return code(JSON.stringify(schema.const));
    }
    if (schema.enum) {
      return code(
        schema.enum.map((value) => JSON.stringify(value)).join(" | ")
      );
    }
    const alternatives = alternativesOf(schema);
    if (alternatives) {
      return joinAlternatives(alternatives.map((alt) => this.typeLabel(alt)));
    }
    if (schema.allOf) {
      const parts = schema.allOf.filter((part) => part.not === undefined);
      if (parts.length === 1) {
        return this.typeLabel(parts[0]);
      }
    }
    const types = Array.isArray(schema.type)
      ? schema.type
      : schema.type
        ? [schema.type]
        : [];
    if (types.length > 1) {
      return joinAlternatives(types.map((type) => code(type)));
    }
    if (types[0] === "array") {
      if (!schema.items) {
        return code("array");
      }
      const primitive = this.primitiveName(schema.items);
      return primitive
        ? code(`${primitive}[]`)
        : `array of ${parenthesize(this.typeLabel(schema.items))}`;
    }
    if (types[0] === "object" || (types.length === 0 && schema.properties)) {
      return this.objectLabel(schema);
    }
    return code(types[0] ?? "any");
  }

  primitiveName(raw) {
    if (this.sectionTarget(raw)) {
      return null;
    }
    const schema = this.deref(raw);
    const plain =
      !schema.enum &&
      !("const" in schema) &&
      !alternativesOf(schema) &&
      ["string", "number", "integer", "boolean"].includes(schema.type);
    return plain ? schema.type : null;
  }

  objectLabel(schema) {
    if (schema.properties) {
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(schema.properties);
      const shown = entries
        .slice(0, SHAPE_LABEL_MAX_KEYS)
        .map(([key, prop]) =>
          "const" in prop
            ? `${key}: ${JSON.stringify(prop.const)}`
            : required.has(key)
              ? key
              : `${key}?`
        );
      if (entries.length > SHAPE_LABEL_MAX_KEYS) {
        shown.push("…");
      }
      return code(`{ ${shown.join(", ")} }`);
    }
    if (schema.additionalProperties && schema.additionalProperties !== true) {
      return `map of ${parenthesize(this.typeLabel(schema.additionalProperties))}`;
    }
    return code("object");
  }

  constraints(schema) {
    const parts = [];
    if (schema.minimum !== undefined) parts.push(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined) parts.push(`maximum ${schema.maximum}`);
    if (schema.minLength !== undefined) {
      parts.push(`at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined) {
      parts.push(`at most ${schema.maxLength} characters`);
    }
    if (schema.minItems !== undefined) {
      parts.push(`at least ${schema.minItems} item(s)`);
    }
    if (schema.pattern !== undefined) {
      parts.push(`pattern ${code(schema.pattern)}`);
    }
    return parts;
  }

  /**
   * Object shapes nested under a field: the field's own object form(s), the
   * item shape(s) of an array form, and the value shape(s) of a map form.
   * Shapes that are documented sections are linked instead of expanded.
   */
  containersOf(raw, suffix = "") {
    if (this.sectionTarget(raw)) {
      return [];
    }
    const schema = this.deref(raw);
    if (schema.type === "object" && schema.properties) {
      return [{ suffix, schema }];
    }
    const alternatives = alternativesOf(schema);
    if (alternatives) {
      return alternatives.flatMap((alt) => this.containersOf(alt, suffix));
    }
    if (schema.properties) {
      return [{ suffix, schema }];
    }
    if (schema.type === "array" && schema.items) {
      return this.containersOf(schema.items, `${suffix}[]`);
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      return this.containersOf(schema.additionalProperties, `${suffix}.*`);
    }
    return [];
  }

  isLeaf(raw) {
    return this.containersOf(raw).length === 0;
  }

  describe(raw) {
    const own = raw.description;
    if (own) return own;
    return this.sectionTarget(raw) ? undefined : this.deref(raw).description;
  }

  checkDescription(title, description, strict) {
    if (!description) {
      if (strict) this.missingDescriptions.push(`${this.page}: ${title}`);
      return;
    }
    if (
      INTERNAL_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))
    ) {
      this.internalDescriptions.push(`${this.page}: ${title}`);
    }
  }

  /**
   * @param {{ level: number, title: string, anchor: string, schema: object,
   *   required?: boolean, defaultValue?: unknown, notes?: string[],
   *   compact?: boolean, omitDescription?: boolean, strict: boolean }} field
   */
  renderField(field) {
    return [
      `${"#".repeat(field.level)} ${code(field.title)} {#${field.anchor}}`,
      "",
      ...this.renderFieldBody(field),
    ];
  }

  renderFieldBody(field) {
    const schema = this.deref(field.schema);
    const description = field.omitDescription
      ? undefined
      : this.describe(field.schema);
    if (!field.omitDescription) {
      this.checkDescription(field.title, description, field.strict);
    }

    const containers = this.containersOf(field.schema);
    const childCount = containers.reduce(
      (count, container) =>
        count + Object.keys(container.schema.properties).length,
      0
    );
    const compact =
      field.compact ||
      containers.every((container) =>
        Object.values(container.schema.properties).every(
          (child) => !this.describe(child) && this.isLeaf(child)
        )
      );
    const expandsChildren = childCount > 0 && !compact;

    const lines = [];
    const meta = [`**Type:** ${this.typeLabel(field.schema)}`];
    if (field.required) meta.push("**Required:** yes");
    const defaultValue =
      field.defaultValue !== undefined ? field.defaultValue : schema.default;
    const defaultBlock = [];
    if (defaultValue !== undefined && !expandsChildren) {
      const rendered = formatDefault(defaultValue);
      if (rendered.inline) {
        meta.push(`**Default:** ${rendered.inline}`);
      } else {
        defaultBlock.push(...rendered.block, "");
      }
    }
    const constraints = this.constraints(schema);
    if (constraints.length > 0) {
      meta.push(`**Constraints:** ${constraints.join(" · ")}`);
    }
    meta.push(...(field.notes ?? []));
    lines.push(...meta.map((line) => `- ${line}`), "");

    if (description) {
      lines.push(prose(description), "");
    }
    lines.push(...this.renderForms(schema));
    lines.push(...defaultBlock);

    if (childCount === 0) {
      return lines;
    }
    const variantLabels = discriminatorLabels(containers);
    for (const [index, container] of containers.entries()) {
      const variantLabel = variantLabels[index];
      if (variantLabel) {
        lines.push(`**When ${variantLabel}:**`, "");
      }
      lines.push(
        ...(compact
          ? this.renderCompactChildren(container)
          : this.renderExpandedChildren(field, container, variantLabel))
      );
    }
    return lines;
  }

  renderForms(schema) {
    const alternatives = alternativesOf(schema);
    if (
      !alternatives ||
      !alternatives.some((alt) => alt.description || this.deref(alt).pattern)
    ) {
      return [];
    }
    const lines = ["Accepted forms:", ""];
    for (const alt of alternatives) {
      const resolved = this.sectionTarget(alt) ? alt : this.deref(alt);
      const pattern = resolved.pattern
        ? ` matching ${code(resolved.pattern)}`
        : "";
      const description = alt.description ?? resolved.description;
      lines.push(
        `- ${this.typeLabel(alt)}${pattern}${description ? ` — ${prose(description)}` : ""}`
      );
    }
    lines.push("");
    return lines;
  }

  renderCompactChildren(container) {
    const required = new Set(container.schema.required ?? []);
    const discriminator = discriminatorKey(container.schema);
    const lines = ["Fields:", ""];
    for (const [name, child] of Object.entries(container.schema.properties)) {
      if (name === discriminator) continue;
      const description = this.describe(child);
      const parts = [code(name), this.typeLabel(child)];
      if (required.has(name)) parts.push("required");
      lines.push(
        `- ${parts.join(" · ")}${description ? ` — ${prose(description)}` : ""}`
      );
    }
    lines.push("");
    return lines;
  }

  renderExpandedChildren(field, container, variantLabel) {
    const required = new Set(container.schema.required ?? []);
    const discriminator = discriminatorKey(container.schema);
    const variantSlug = variantLabel
      ? `-${slug(String(container.schema.properties[discriminator].const))}`
      : "";
    const itemSlug = container.suffix
      ? `-${slug(container.suffix) || "items"}`
      : "";
    const lines = [];
    for (const [name, child] of Object.entries(container.schema.properties)) {
      if (variantLabel && name === discriminator) continue;
      const childDefault =
        container.suffix === "" && isPlainObject(field.defaultValue)
          ? field.defaultValue[name]
          : undefined;
      lines.push(
        ...this.renderField({
          level: variantLabel ? Math.min(field.level + 1, 6) : field.level,
          title: `${field.title}${container.suffix}.${name}`,
          anchor: `${field.anchor}${itemSlug}${variantSlug}-${slug(name)}`,
          schema: child,
          required: required.has(name),
          defaultValue: childDefault,
          strict: field.strict,
        })
      );
    }
    return lines;
  }
}

function joinAlternatives(labels) {
  return [...new Set(labels)].join(" or ");
}

function parenthesize(label) {
  return label.includes(" or ") ? `(${label})` : label;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function discriminatorKey(objectSchema) {
  return Object.entries(objectSchema.properties).find(
    ([, prop]) => "const" in prop
  )?.[0];
}

function discriminatorLabels(containers) {
  if (containers.length < 2) {
    return containers.map(() => undefined);
  }
  return containers.map((container) => {
    const key = discriminatorKey(container.schema);
    return key
      ? `${code(key)} is ${code(JSON.stringify(container.schema.properties[key].const))}`
      : undefined;
  });
}

function formatDefault(value) {
  if (typeof value === "string" && value.length > INLINE_VALUE_MAX_LENGTH) {
    return { block: defaultDetails("text", value) };
  }
  const json = JSON.stringify(value);
  if (json.length <= INLINE_VALUE_MAX_LENGTH) {
    return { inline: code(json) };
  }
  return { block: defaultDetails("json", JSON.stringify(value, null, 2)) };
}

function defaultDetails(language, body) {
  return [
    "<details><summary>Default value</summary>",
    "",
    `\`\`\`${language}`,
    body,
    "```",
    "",
    "</details>",
  ];
}

// ---------------------------------------------------------------------------
// Partials
// ---------------------------------------------------------------------------

class Partials {
  constructor(page) {
    this.page = page;
    this.dir = resolve(PARTIALS_DIR, page);
    this.used = new Set();
  }

  get(name) {
    const path = resolve(this.dir, `${name}.md`);
    if (!existsSync(path)) return [];
    this.used.add(name);
    return [readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim(), ""];
  }

  orphans() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md"))
      .filter((name) => !this.used.has(name))
      .map((name) => `docs/reference/_partials/${this.page}/${name}.md`);
  }
}

function renderPage({ title, description, sections, partials, body }) {
  return [
    "---",
    `description: ${JSON.stringify(description)}`,
    "editLink: false",
    "---",
    "",
    GENERATED_HEADER,
    "",
    `# ${title}`,
    "",
    ...partials.get("intro"),
    "| Section | Purpose |",
    "| --- | --- |",
    ...sections.map(
      (section) =>
        `| [${section.title}](#${section.id}) | ${tableCell(prose(firstSentence(section.summary ?? "")))} |`
    ),
    "",
    ...body,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

export function loadSettingsDefaults() {
  if (!existsSync(COMPILED_SETTINGS_PATH)) {
    throw new Error(
      `Compiled settings not found at ${COMPILED_SETTINGS_PATH}. Run "npm run compile-tests" first.`
    );
  }
  return require(COMPILED_SETTINGS_PATH).CTRLYOKE_SETTINGS_DEFAULTS;
}

function buildSettingsPage(
  settingsSchema,
  defaults,
  workflowFieldAnchors,
  workflowSchema
) {
  const refTargets = new Map(
    Object.keys(settingsSchema.$defs ?? {}).map((name) => [
      `#/$defs/${name}`,
      { label: name, page: SETTINGS_PAGE, anchor: `type-${slug(name)}` },
    ])
  );
  const renderer = new SchemaRenderer(
    settingsSchema,
    SETTINGS_PAGE,
    refTargets,
    {
      "workflow.json": workflowSchema,
      "workflow-schema.json": workflowSchema,
    }
  );
  const partials = new Partials(SETTINGS_PAGE);

  const grouped = [];
  const topLevel = [];
  for (const [key, prop] of Object.entries(settingsSchema.properties)) {
    (renderer.deref(prop).properties ? grouped : topLevel).push([key, prop]);
  }

  const sections = [];
  const body = [];
  for (const [key, prop] of grouped) {
    const section = {
      id: slug(key),
      title: code(key),
      summary: prop.description,
    };
    sections.push(section);
    renderer.checkDescription(key, prop.description, true);
    body.push(`## ${code(key)} {#${section.id}}`, "");
    if (prop.description) body.push(prose(prop.description), "");
    body.push(...partials.get(section.id));
    for (const [name, child] of Object.entries(
      renderer.deref(prop).properties
    )) {
      const workflowAnchor =
        key === "defaults" ? workflowFieldAnchors.get(name) : undefined;
      body.push(
        ...renderer.renderField({
          level: 3,
          title: `${key}.${name}`,
          anchor: slug(`${key}-${name}`),
          schema: child,
          defaultValue: defaults[key]?.[name],
          strict: true,
          compact: workflowAnchor !== undefined,
          notes: workflowAnchor
            ? [
                `**Workflow field:** [${code(name)}](/reference/${WORKFLOW_PAGE}#${workflowAnchor}) — a workflow or step value overrides this default`,
              ]
            : [],
        })
      );
    }
  }

  if (topLevel.length > 0) {
    const section = {
      id: "top-level",
      title: "Top-level settings",
      summary: "Settings that sit directly at the root of settings.json.",
    };
    sections.push(section);
    body.push(`## ${section.title} {#${section.id}}`, "");
    body.push(...partials.get(section.id));
    for (const [name, prop] of topLevel) {
      body.push(
        ...renderer.renderField({
          level: 3,
          title: name,
          anchor: slug(name),
          schema: prop,
          defaultValue: defaults[name],
          strict: true,
        })
      );
    }
  }

  const definitions = Object.entries(settingsSchema.$defs ?? {});
  if (definitions.length > 0) {
    const section = {
      id: "shared-types",
      title: "Shared types",
      summary: "Value shapes referenced by more than one setting.",
    };
    sections.push(section);
    body.push(`## ${section.title} {#${section.id}}`, "");
    body.push(...partials.get(section.id));
    for (const [name, definition] of definitions) {
      body.push(
        `### ${name} {#${refTargets.get(`#/$defs/${name}`).anchor}}`,
        "",
        ...renderer.renderFieldBody({
          level: 4,
          title: name,
          anchor: `type-${slug(name)}`,
          schema: definition,
          strict: true,
        })
      );
    }
  }

  const markdown = renderPage({
    title: "Settings reference",
    description:
      "Every setting in .ctrlyoke/settings.json, generated from schemas/settings-schema.json.",
    sections,
    partials,
    body,
  });
  return { markdown, renderer, partials };
}

// ---------------------------------------------------------------------------
// Workflow-schema pages
// ---------------------------------------------------------------------------

function workflowRefTargets() {
  const targets = new Map();
  for (const { page, sections } of WORKFLOW_PAGES) {
    for (const section of sections) {
      for (const ref of section.refs ?? []) {
        targets.set(ref, { label: section.title, page, anchor: section.id });
      }
    }
  }
  return targets;
}

function sectionProperties(workflowSchema, section) {
  return (section.properties ?? []).flatMap(({ pointer, include }) => {
    const properties = resolvePointer(workflowSchema, pointer);
    const parent = resolvePointer(
      workflowSchema,
      pointer.replace(/\/properties$/, "")
    );
    const required = new Set(parent?.required ?? []);
    return Object.entries(properties)
      .filter(([name]) => !include || include.includes(name))
      .map(([name, schema]) => ({
        name,
        schema,
        required: required.has(name),
      }));
  });
}

/** Anchors of workflow fields that settings `defaults.*` entries mirror. */
function workflowFieldAnchors(workflowSchema) {
  const anchors = new Map();
  for (const { sections } of WORKFLOW_PAGES) {
    for (const section of sections.filter((s) => s.linkSettingsDefaults)) {
      for (const { name } of sectionProperties(workflowSchema, section)) {
        anchors.set(name, slug(`${section.id}-${name}`));
      }
    }
  }
  return anchors;
}

/**
 * A section whose schema composes another documented section through `allOf`
 * accepts those fields too, but the section's own property pointer only lists
 * the local additions. Name the inherited sections so the page does not read as
 * if the composed fields were missing.
 */
function inheritedSectionLines(renderer, refSchema) {
  const inherited = (refSchema?.allOf ?? [])
    .map((part) => renderer.sectionTarget(part))
    .filter(Boolean);
  if (inherited.length === 0) return [];
  const links = inherited.map(
    (target) => `[${target.label}](${renderer.href(target)})`
  );
  return [`Also includes every field from ${links.join(" and ")}.`, ""];
}

function buildWorkflowPage(
  workflowSchema,
  settingsSchema,
  pageConfig,
  refTargets
) {
  const renderer = new SchemaRenderer(
    workflowSchema,
    pageConfig.page,
    refTargets
  );
  const partials = new Partials(pageConfig.page);
  const settingsDefaults = settingsSchema.properties.defaults.properties;
  const body = [];
  const sections = [];

  for (const section of pageConfig.sections) {
    const refSchema = section.refs?.[0]
      ? resolvePointer(workflowSchema, section.refs[0])
      : undefined;
    const description = refSchema?.description ?? section.summary;
    sections.push({ ...section, summary: section.summary ?? description });
    renderer.checkDescription(section.title, description, pageConfig.strict);
    body.push(`## ${section.title} {#${section.id}}`, "");
    if (description) body.push(prose(description), "");
    body.push(...inheritedSectionLines(renderer, refSchema));
    body.push(...partials.get(section.id));

    if (section.schema) {
      body.push(
        ...renderer.renderFieldBody({
          level: 2,
          title: section.id,
          anchor: section.id,
          schema: resolvePointer(workflowSchema, section.schema),
          strict: pageConfig.strict,
          omitDescription: true,
        })
      );
      continue;
    }

    for (const { name, schema, required } of sectionProperties(
      workflowSchema,
      section
    )) {
      body.push(
        ...renderer.renderField({
          level: 3,
          title: name,
          anchor: slug(`${section.id}-${name}`),
          schema,
          required,
          strict: pageConfig.strict,
          notes:
            section.linkSettingsDefaults && settingsDefaults[name]
              ? [
                  `**Settings default:** [${code(`defaults.${name}`)}](/reference/${SETTINGS_PAGE}#${slug(`defaults-${name}`)})`,
                ]
              : [],
        })
      );
    }
  }

  const markdown = renderPage({
    title: pageConfig.title,
    description: pageConfig.description,
    sections,
    partials,
    body,
  });
  return { markdown, renderer, partials };
}

/** Every definition and every split property list must land on a page. */
function workflowCoverageErrors(workflowSchema) {
  const errors = [];
  const sections = WORKFLOW_PAGES.flatMap(({ sections }) => sections);
  const claimedPointers = sections.flatMap((section) => [
    ...(section.refs ?? []),
    ...(section.schema ? [section.schema] : []),
    ...(section.properties ?? []).map(({ pointer }) => pointer),
  ]);
  for (const name of Object.keys(workflowSchema.$defs)) {
    const pointer = `#/$defs/${name}`;
    const claimed = claimedPointers.some(
      (claim) => claim === pointer || claim.startsWith(`${pointer}/`)
    );
    if (!claimed && !STRUCTURAL_WORKFLOW_DEFINITIONS.has(name)) {
      errors.push(
        `workflow-schema definition "${name}" is not assigned to a docs section in scripts/generate-schema-docs.mjs`
      );
    }
  }

  const includesByPointer = new Map();
  for (const section of sections) {
    for (const { pointer, include } of section.properties ?? []) {
      if (!include) continue;
      const names = includesByPointer.get(pointer) ?? new Set();
      include.forEach((name) => names.add(name));
      includesByPointer.set(pointer, names);
    }
  }
  for (const [pointer, included] of includesByPointer) {
    for (const name of Object.keys(resolvePointer(workflowSchema, pointer))) {
      if (!included.has(name)) {
        errors.push(
          `workflow-schema property "${name}" at ${pointer} is not assigned to a docs section in scripts/generate-schema-docs.mjs`
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildSchemaDocumentation({
  settingsSchema,
  workflowSchema,
  settingsDefaults,
}) {
  const refTargets = workflowRefTargets();
  const results = [
    {
      path: resolve(REFERENCE_DIR, `${SETTINGS_PAGE}.md`),
      ...buildSettingsPage(
        settingsSchema,
        settingsDefaults,
        workflowFieldAnchors(workflowSchema),
        workflowSchema
      ),
    },
    ...WORKFLOW_PAGES.map((pageConfig) => ({
      path: resolve(REFERENCE_DIR, `${pageConfig.page}.md`),
      ...buildWorkflowPage(
        workflowSchema,
        settingsSchema,
        pageConfig,
        refTargets
      ),
    })),
  ];

  const errors = [
    ...workflowCoverageErrors(workflowSchema),
    ...results.flatMap(({ renderer }) =>
      renderer.missingDescriptions.map(
        (field) => `missing description: ${field}`
      )
    ),
    ...results.flatMap(({ partials }) =>
      partials
        .orphans()
        .map((path) => `partial has no matching section: ${path}`)
    ),
  ];
  const warnings = results.flatMap(({ renderer }) =>
    renderer.internalDescriptions.map(
      (field) => `description reads like contributor notes: ${field}`
    )
  );
  return {
    pages: results.map(({ path, markdown }) => ({ path, markdown })),
    errors,
    warnings,
  };
}

export function loadSchemaDocumentationInputs() {
  return {
    settingsSchema: JSON.parse(readFileSync(SETTINGS_SCHEMA_PATH, "utf8")),
    workflowSchema: JSON.parse(readFileSync(WORKFLOW_SCHEMA_PATH, "utf8")),
    settingsDefaults: loadSettingsDefaults(),
  };
}

function main() {
  const { pages, errors, warnings } = buildSchemaDocumentation(
    loadSchemaDocumentationInputs()
  );
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  if (CHECK_MODE) {
    const stale = pages.filter(
      ({ path, markdown }) =>
        !existsSync(path) || readFileSync(path, "utf8") !== markdown
    );
    if (stale.length > 0) {
      for (const { path } of stale) {
        console.error(`Schema reference page is out of date: ${path}`);
      }
      console.error("Run npm run generate-schema-docs to regenerate it.");
      process.exitCode = 1;
      return;
    }
    console.log("Schema reference pages are up to date.");
    return;
  }

  for (const { path, markdown } of pages) {
    writeFileSync(path, markdown, "utf8");
    console.log(`Written: ${path}`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
