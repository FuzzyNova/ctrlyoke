import {
  COMPLETION_ITEM_KINDS,
  CTRLYOKE_FILE_KINDS,
  HARNESS_IDS,
  isHarnessId,
  MCP_SERVER_IDS,
  PROMPT_PROPERTIES,
  STEP_TYPES,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type WorkflowObjectKind,
} from "../types/DashboardConstants";
import {
  WORKFLOW_SCHEMA_OUTLINE,
  type WorkflowObjectOutline,
  type WorkflowOutlineProperty,
} from "../types/generated/WorkflowSchemaOutline";
import { escapeJsonStringFragment } from "../utils/JsonStringEscape";
import type { PlainCompletionItem } from "./CompletionCore";
import { isAfterJsonValue } from "./WorkflowLocationJson";
import {
  getWorkflowPropertySnippet,
  type WorkflowPropertySnippet,
} from "./WorkflowPropertySnippets";
import { isRecord } from "../utils/JsonTypeGuards";
import {
  isParentRunPriorContext,
  isParentRunSessionId,
} from "../types/CtrlYokeTypes";
import {
  classifyWorkflowObject,
  getInlineDefinitionPath,
  splitValuePath,
  valueAt,
  YAML_SCALAR_STYLES,
  type WorkflowLocation,
  type WorkflowPath,
  type WorkflowTextRange,
} from "./WorkflowLocationTypes";

/**
 * Key and value completion items for a ctrlyoke workflow file. Pure: no
 * `vscode`, no `fs`, so the hosted editor and VS Code share it. Prompt-token,
 * script, permission, branch and path completions are host-backed and stay out
 * of this module; the caller routes those by `location.role`.
 */

/** The dynamic option lists a host supplies; everything else comes from the outline. */
export interface WorkflowValueDataSource {
  /** Model ids for a harness; empty when the harness has no list. */
  getModels(harness: string): readonly WorkflowModelOption[];
  getAgents(): readonly string[];
  getSkills(): readonly string[];
  /** Registered MCP server ids. The built-in `ctrlyoke` server is added by the core. */
  getMcpServers(): readonly string[];
  getSecretNames(): readonly string[];
  /** The harness a step without `harness` runs on (the `defaults.harness` setting). */
  getDefaultHarness(): string | undefined;
}

export interface WorkflowModelOption {
  readonly id: string;
  readonly label?: string;
}

export interface WorkflowFileCompletionRequest {
  /** The whole file, as given to `getWorkflowLocation`. */
  readonly text: string;
  readonly offset: number;
  readonly location: WorkflowLocation;
  /** `parseWorkflowDocumentRoot(text, kind)`: the partially parsed document. */
  readonly documentRoot: unknown;
  readonly data: WorkflowValueDataSource;
}

export interface WorkflowFileCompletions {
  readonly items: PlainCompletionItem[];
  /** The text the chosen item replaces, so adapters need no word-boundary logic of their own. */
  readonly replaceRange: WorkflowTextRange;
}

const OUTLINE_VALUE_KINDS = {
  OBJECT: "object",
  ARRAY: "array",
  NULL: "null",
  BOOLEAN: "boolean",
  ONE_OF: "oneOf",
} as const;

/** The keys whose values come from a host data source, and the objects that own them. */
const DYNAMIC_VALUE_OWNERS: readonly WorkflowObjectKind[] = [
  WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
  WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
  WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
];

/** The step kinds a queue item, parallel member or `finalStep` can be. */
const STEP_KINDS: readonly WorkflowObjectKind[] = [
  WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
  WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
  WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP,
];

/** An inline sub-workflow definition is one prompt or script step (D13). */
const INLINE_STEP_KINDS: readonly WorkflowObjectKind[] = [
  WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
  WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
];

/**
 * Root keys only a multi-step workflow accepts. The single-step script and
 * workflow roots reject `conditions` and `worktreePresets` too (D8); only a
 * single-prompt root takes every workflow-only key.
 */
const MULTI_STEP_ONLY_KEYS: readonly string[] = [
  PROMPT_PROPERTIES.STEPS,
  PROMPT_PROPERTIES.FINAL_STEP,
];
const NON_PROMPT_ROOT_EXCLUDED_KEYS: readonly string[] = [
  ...MULTI_STEP_ONLY_KEYS,
  PROMPT_PROPERTIES.CONDITIONS,
  PROMPT_PROPERTIES.WORKTREE_PRESETS,
];

const FINAL_STEP_SESSION = PROMPT_PROPERTIES.FINAL_STEP;
const MODEL_NONE = "none";
const WORD_CHARACTER = /[\w.\-@$]/;
/**
 * A plain YAML scalar that would parse as another type or special syntax. `@`
 * is reserved as a first character, and a leading `.` reads `.inf`/`.nan` as numbers.
 */
const YAML_UNSAFE_PLAIN =
  /^(?![A-Za-z_/][\w./@-]*$)|^(true|false|null|yes|no|on|off|y|n)$/i;
const SORT_DYNAMIC = "0";
const SORT_ENUM = "1";
const SORT_DEPRECATED = "9";

function sortKey(group: string, index: number): string {
  return `${group}_${String(index).padStart(3, "0")}`;
}

function toKeyOwnerPath(location: WorkflowLocation): WorkflowPath {
  return location.key !== undefined &&
    location.role === WORKFLOW_LOCATION_ROLES.KEY
    ? location.path.slice(0, -1)
    : location.path;
}

// ---------------------------------------------------------------- keys ----

function isCollectionOnly(property: WorkflowOutlineProperty): boolean {
  const collection = (kind: string): boolean =>
    kind === OUTLINE_VALUE_KINDS.OBJECT || kind === OUTLINE_VALUE_KINDS.ARRAY;
  if (property.valueKind === OUTLINE_VALUE_KINDS.ONE_OF) {
    const alternatives = property.alternatives ?? [];
    return (
      alternatives.some(collection) &&
      alternatives.every(
        (kind) => collection(kind) || kind === OUTLINE_VALUE_KINDS.NULL
      )
    );
  }
  return collection(property.valueKind);
}

/**
 * Every kind the step object at `ownerPath` could be, whatever it holds so far.
 * Empty when `ownerPath` is not a step slot (the root, a nested object).
 */
function stepSlotKinds(
  ownerPath: WorkflowPath,
  root: unknown
): readonly WorkflowObjectKind[] {
  const inlinePath = getInlineDefinitionPath(ownerPath, root);
  if (inlinePath) {
    return inlinePath.length === ownerPath.length ? INLINE_STEP_KINDS : [];
  }
  const isGroupSlot =
    ownerPath.length === 2 &&
    ownerPath[0] === PROMPT_PROPERTIES.STEPS &&
    typeof ownerPath[1] === "number";
  const isMemberSlot =
    ownerPath.length === 4 &&
    ownerPath[0] === PROMPT_PROPERTIES.STEPS &&
    ownerPath[2] === PROMPT_PROPERTIES.PARALLEL;
  const isFinalStepSlot =
    ownerPath.length === 1 && ownerPath[0] === PROMPT_PROPERTIES.FINAL_STEP;
  if (isGroupSlot) return [...STEP_KINDS, WORKFLOW_OBJECT_KINDS.PARALLEL_GROUP];
  return isMemberSlot || isFinalStepSlot ? STEP_KINDS : [];
}

/** The outline objects a key at this slot can come from, in priority order. */
function keySourceKinds(
  location: WorkflowLocation,
  root: unknown
): readonly WorkflowObjectKind[] {
  const ownerPath = toKeyOwnerPath(location);
  if (location.objectKind !== WORKFLOW_OBJECT_KINDS.PROMPT_STEP) {
    return [location.objectKind];
  }
  const node = valueAt(root, ownerPath);
  const fields = isRecord(node) ? node : {};
  const undecided = [
    PROMPT_PROPERTIES.PROMPT,
    PROMPT_PROPERTIES.SCRIPT,
    PROMPT_PROPERTIES.STEP_TYPE,
    PROMPT_PROPERTIES.PARALLEL,
  ].every((key) => fields[key] === undefined);
  if (!undecided) return [location.objectKind];
  const slotKinds = stepSlotKinds(ownerPath, root);
  return slotKinds.length > 0 ? slotKinds : [location.objectKind];
}

/** Keys an object owns beyond its outline: an inline definition's `worktree` (D13). */
function extraKeySources(
  ownerPath: WorkflowPath,
  root: unknown
): { readonly key: string; readonly sourceKind: WorkflowObjectKind }[] {
  const inlinePath = getInlineDefinitionPath(ownerPath, root);
  return inlinePath && inlinePath.length === ownerPath.length
    ? [
        {
          key: PROMPT_PROPERTIES.WORKTREE,
          sourceKind: WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
        },
      ]
    : [];
}

/** Keys only a sub-workflow step declares; offered on no other step. */
function subWorkflowOnlyKeys(): Set<string> {
  const outlineKeys = (kind: WorkflowObjectKind): string[] =>
    Object.keys(WORKFLOW_SCHEMA_OUTLINE[kind]?.properties ?? {});
  const shared = new Set([
    ...outlineKeys(WORKFLOW_OBJECT_KINDS.PROMPT_STEP),
    ...outlineKeys(WORKFLOW_OBJECT_KINDS.SCRIPT_STEP),
  ]);
  return new Set(
    outlineKeys(WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP).filter(
      (key) => !shared.has(key)
    )
  );
}

/** A workflow root holds both a single step's keys and a multi-step workflow's; the document picks. */
function rootKeyIsRelevant(root: unknown): (key: string) => boolean {
  const fields = isRecord(root) ? root : {};
  const promptKeys = Object.keys(
    WORKFLOW_SCHEMA_OUTLINE[WORKFLOW_OBJECT_KINDS.PROMPT_STEP]?.properties ?? {}
  );
  const scriptKeys = Object.keys(
    WORKFLOW_SCHEMA_OUTLINE[WORKFLOW_OBJECT_KINDS.SCRIPT_STEP]?.properties ?? {}
  );
  const subWorkflowKeys = Object.keys(
    WORKFLOW_SCHEMA_OUTLINE[WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP]
      ?.properties ?? {}
  );
  const scriptOnly = new Set(
    scriptKeys.filter((key) => !promptKeys.includes(key))
  );
  const promptOnly = new Set(
    promptKeys.filter((key) => !scriptKeys.includes(key))
  );
  const subWorkflowOnly = subWorkflowOnlyKeys();
  /** Keys of some step kind, which a root of another kind must not offer. */
  const stepKeys = new Set([...promptKeys, ...scriptKeys, ...subWorkflowKeys]);
  const isMulti = MULTI_STEP_ONLY_KEYS.some((key) => fields[key] !== undefined);
  const isWorkflow =
    fields[PROMPT_PROPERTIES.STEP_TYPE] === STEP_TYPES.WORKFLOW;
  const isScript =
    !isWorkflow &&
    (fields[PROMPT_PROPERTIES.SCRIPT] !== undefined ||
      fields[PROMPT_PROPERTIES.STEP_TYPE] === STEP_TYPES.SCRIPT);
  const isPrompt = fields[PROMPT_PROPERTIES.PROMPT] !== undefined;
  if (isMulti) {
    return (key) =>
      !scriptOnly.has(key) &&
      !subWorkflowOnly.has(key) &&
      key !== PROMPT_PROPERTIES.PROMPT &&
      key !== PROMPT_PROPERTIES.STEP_TYPE;
  }
  // `rootWorkflowStep`: the sub-workflow step's keys plus the root-only keys.
  if (isWorkflow)
    return (key) =>
      !NON_PROMPT_ROOT_EXCLUDED_KEYS.includes(key) &&
      (subWorkflowKeys.includes(key) || !stepKeys.has(key));
  if (isScript)
    return (key) =>
      !NON_PROMPT_ROOT_EXCLUDED_KEYS.includes(key) &&
      !promptOnly.has(key) &&
      !subWorkflowOnly.has(key);
  if (isPrompt)
    return (key) =>
      !MULTI_STEP_ONLY_KEYS.includes(key) &&
      !scriptOnly.has(key) &&
      !subWorkflowOnly.has(key);
  return () => true;
}

function leadingKeyIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^(\s*)(-\s+)?/.exec(text.slice(lineStart, offset));
  const width = (match?.[1].length ?? 0) + (match?.[2]?.length ?? 0);
  return " ".repeat(width);
}

/** True when the key being completed already has its `:` (renaming an existing key). */
function hasKeyColon(text: string, replaceEnd: number): boolean {
  return /^[ \t]*:/.test(text.slice(replaceEnd));
}

/**
 * `, ` when a JSON key or list item lands right after a complete value (no
 * comma typed yet), so the insert leaves valid JSON. Empty everywhere else.
 */
function jsonSeparator(
  request: WorkflowFileCompletionRequest,
  replaceStart: number
): string {
  const { location, text } = request;
  return location.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON &&
    !location.jsonString &&
    isAfterJsonValue(text, replaceStart)
    ? ", "
    : "";
}

function keyInsertText(
  request: WorkflowFileCompletionRequest,
  key: string,
  property: WorkflowOutlineProperty,
  snippet: WorkflowPropertySnippet,
  keyOnly: boolean,
  separator: string
): string {
  const { location, text, offset } = request;
  // A key that implies a step kind brings its `type` along on an untyped step.
  const stepType =
    snippet.impliesStepType !== undefined &&
    !keyOnly &&
    !location.siblingKeys.includes(PROMPT_PROPERTIES.STEP_TYPE)
      ? snippet.impliesStepType
      : undefined;
  if (location.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON) {
    if (keyOnly) return `${separator}"${key}"`;
    const typed =
      stepType === undefined
        ? ""
        : `"${PROMPT_PROPERTIES.STEP_TYPE}": ${JSON.stringify(stepType)}, `;
    return `${separator}${typed}"${key}": `;
  }
  if (keyOnly) return key;
  // A flow mapping (`{ prompt: hi, § }`) cannot hold a block snippet.
  if (location.inFlowCollection) {
    return stepType === undefined
      ? `${key}: `
      : `${PROMPT_PROPERTIES.STEP_TYPE}: ${stepType}, ${key}: `;
  }
  const body =
    snippet.insertSnippet ??
    (isCollectionOnly(property) ? `${key}:\n  ` : `${key}: `);
  const typed =
    stepType === undefined
      ? body
      : `${PROMPT_PROPERTIES.STEP_TYPE}: ${stepType}\n${body}`;
  return typed.replace(/\n/g, `\n${leadingKeyIndent(text, offset)}`);
}

function getKeyItems(
  request: WorkflowFileCompletionRequest
): PlainCompletionItem[] {
  const { location, documentRoot } = request;
  const taken = new Set(location.siblingKeys);
  const offered = new Set<string>();
  const items: PlainCompletionItem[] = [];
  const isRelevant =
    location.objectKind === WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT
      ? rootKeyIsRelevant(documentRoot)
      : () => true;
  const replaceRange = getReplaceRange(request);
  const keyOnly = hasKeyColon(request.text, replaceRange.end);
  const separator = jsonSeparator(request, replaceRange.start);

  const candidates: {
    readonly key: string;
    readonly property: WorkflowOutlineProperty;
    readonly sourceKind: WorkflowObjectKind;
  }[] = [];
  for (const sourceKind of keySourceKinds(location, documentRoot)) {
    const outline: WorkflowObjectOutline | undefined =
      WORKFLOW_SCHEMA_OUTLINE[sourceKind];
    if (!outline) continue;
    for (const [key, property] of Object.entries(outline.properties)) {
      if (!outline.forbiddenKeys.includes(key)) {
        candidates.push({ key, property, sourceKind });
      }
    }
  }
  for (const { key, sourceKind } of extraKeySources(
    toKeyOwnerPath(location),
    documentRoot
  )) {
    const property = WORKFLOW_SCHEMA_OUTLINE[sourceKind]?.properties[key];
    if (property) candidates.push({ key, property, sourceKind });
  }

  for (const { key, property, sourceKind } of candidates) {
    if (taken.has(key) || offered.has(key) || !isRelevant(key)) {
      continue;
    }
    offered.add(key);
    const snippet = getWorkflowPropertySnippet(sourceKind, key);
    const detail =
      snippet.detail ?? property.enum?.join(" | ") ?? property.valueKind;
    items.push({
      label: key,
      kind: COMPLETION_ITEM_KINDS.PROPERTY,
      insertText: keyInsertText(
        request,
        key,
        property,
        snippet,
        keyOnly,
        separator
      ),
      detail: property.deprecated ? `Deprecated · ${detail}` : detail,
      documentation: property.description ?? snippet.documentation,
      sortText: sortKey(
        property.deprecated ? SORT_DEPRECATED : SORT_DYNAMIC,
        items.length
      ),
    });
  }
  return items;
}

// -------------------------------------------------------------- values ----

type ValueCandidate = {
  readonly value: string | number | boolean;
  readonly label?: string;
  readonly detail?: string;
  /** Inserted exactly as given, e.g. `[1]`; never quoted or escaped. */
  readonly raw?: true;
};

interface FlatStep {
  readonly path: WorkflowPath;
  /** 1-based, counted after parallel groups are flattened, as the loader does. */
  readonly number: number;
  readonly group?: number;
  readonly node: Record<string, unknown>;
}

function flattenSteps(root: unknown): FlatStep[] {
  const steps = isRecord(root) ? root[PROMPT_PROPERTIES.STEPS] : undefined;
  if (!Array.isArray(steps)) return [];
  const flat: FlatStep[] = [];
  steps.forEach((entry: unknown, index) => {
    if (!isRecord(entry)) return;
    const members = entry[PROMPT_PROPERTIES.PARALLEL];
    if (Array.isArray(members)) {
      members.forEach((member: unknown, memberIndex) => {
        if (!isRecord(member)) return;
        flat.push({
          path: [
            PROMPT_PROPERTIES.STEPS,
            index,
            PROMPT_PROPERTIES.PARALLEL,
            memberIndex,
          ],
          number: flat.length + 1,
          group: index,
          node: member,
        });
      });
      return;
    }
    flat.push({
      path: [PROMPT_PROPERTIES.STEPS, index],
      number: flat.length + 1,
      node: entry,
    });
  });
  return flat;
}

function describeStep(step: FlatStep): string {
  const { name, prompt, script } = step.node;
  if (typeof name === "string" && name.trim()) return name.trim();
  const body = typeof prompt === "string" ? prompt : script;
  if (typeof body === "string" && body.trim()) {
    const firstLine = body.trim().split(/\r?\n/, 1)[0];
    return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
  }
  return `Step ${step.number}`;
}

/** The steps a numeric `priorContext` or `sessionId` at `ownerPath` may point at. */
function earlierSteps(root: unknown, ownerPath: WorkflowPath): FlatStep[] {
  const steps = flattenSteps(root);
  if (ownerPath[0] === PROMPT_PROPERTIES.FINAL_STEP) return steps;
  const current = steps.find((step) =>
    step.path.every((segment, index) => ownerPath[index] === segment)
  );
  if (!current) return [];
  // A member cannot point at another member of its own group.
  return steps.filter(
    (step) =>
      step.number < current.number &&
      (current.group === undefined || step.group !== current.group)
  );
}

function effectiveHarness(
  root: unknown,
  ownerPath: WorkflowPath,
  data: WorkflowValueDataSource
): string | undefined {
  // An inline definition inherits the parent's workflow harness, not the
  // wrapping step's (which has none), when it is materialized (D13).
  const stepPath =
    getInlineDefinitionPath(ownerPath, root) ??
    (ownerPath[0] === PROMPT_PROPERTIES.FINAL_STEP
      ? ownerPath.slice(0, 1)
      : ownerPath.slice(
          0,
          ownerPath[2] === PROMPT_PROPERTIES.PARALLEL ? 4 : 2
        ));
  const step = valueAt(root, stepPath);
  const candidates = [
    isRecord(step) ? step[PROMPT_PROPERTIES.HARNESS] : undefined,
    isRecord(root) ? root[PROMPT_PROPERTIES.HARNESS] : undefined,
    data.getDefaultHarness(),
  ];
  return candidates.find((candidate): candidate is string =>
    isHarnessId(candidate)
  );
}

function getDynamicCandidates(
  request: WorkflowFileCompletionRequest,
  ownerPath: WorkflowPath,
  key: string,
  isElement: boolean
): ValueCandidate[] {
  const { location, documentRoot: root, data } = request;
  if (!DYNAMIC_VALUE_OWNERS.includes(location.objectKind)) return [];
  const names = (values: readonly string[]): ValueCandidate[] =>
    values.map((value) => ({ value }));

  switch (key) {
    case PROMPT_PROPERTIES.HARNESS:
      return names(Object.values(HARNESS_IDS));
    case PROMPT_PROPERTIES.MODEL: {
      const harness = effectiveHarness(root, ownerPath, data);
      const models = harness ? data.getModels(harness) : [];
      return [
        { value: MODEL_NONE, detail: "Skip the --model flag" },
        ...models.map((model) => ({
          value: model.id,
          detail:
            model.label && model.label !== model.id ? model.label : harness,
        })),
      ];
    }
    case PROMPT_PROPERTIES.AGENT:
      return names(data.getAgents());
    case PROMPT_PROPERTIES.SKILLS:
      return isElement ? names(data.getSkills()) : [];
    case PROMPT_PROPERTIES.MCP_SERVERS:
      return isElement
        ? names([
            ...new Set([MCP_SERVER_IDS.CTRLYOKE, ...data.getMcpServers()]),
          ])
        : [];
    case PROMPT_PROPERTIES.SECRETS:
      return isElement ? names(data.getSecretNames()) : [];
    // Step numbers inside an inline definition would address the child run,
    // where they select nothing (D13).
    case PROMPT_PROPERTIES.PRIOR_CONTEXT:
      if (location.inlineDefinition) return [];
      return earlierSteps(root, ownerPath).map((step) =>
        isElement
          ? { value: step.number, detail: describeStep(step) }
          : {
              value: `[${step.number}]`,
              label: `[${step.number}]`,
              detail: describeStep(step),
              raw: true,
            }
      );
    case PROMPT_PROPERTIES.SESSION_ID: {
      if (location.inlineDefinition) return [];
      const final = isRecord(root) && root[FINAL_STEP_SESSION] !== undefined;
      return [
        ...(final
          ? [{ value: FINAL_STEP_SESSION, detail: "Session of the final step" }]
          : []),
        // Only a prompt step has a session to resume: a script step has none,
        // and a workflow step's sessions belong to its child run (D12).
        ...earlierSteps(root, ownerPath)
          .filter(
            (step) =>
              classifyWorkflowObject(step.path, root) ===
              WORKFLOW_OBJECT_KINDS.PROMPT_STEP
          )
          .map((step) => ({
            value: step.number,
            detail: describeStep(step),
          })),
      ];
    }
    default:
      return [];
  }
}

function getOutlineCandidates(
  property: WorkflowOutlineProperty
): ValueCandidate[] {
  const candidates: ValueCandidate[] = (property.enum ?? []).map((value) => ({
    value,
    detail: value === property.default ? "default" : undefined,
  }));
  const kinds = [property.valueKind, ...(property.alternatives ?? [])];
  if (kinds.includes(OUTLINE_VALUE_KINDS.BOOLEAN)) {
    for (const value of [true, false]) {
      candidates.push({
        value,
        detail: value === property.default ? "default" : undefined,
      });
    }
  }
  return candidates;
}

function formatValue(
  candidate: ValueCandidate,
  location: WorkflowLocation
): string | undefined {
  const quoted =
    location.scalarStyle === YAML_SCALAR_STYLES.DOUBLE_QUOTED ||
    location.scalarStyle === YAML_SCALAR_STYLES.SINGLE_QUOTED;
  // `[1]` is structure; inside any string it would become text.
  if (candidate.raw)
    return location.jsonString || quoted ? undefined : String(candidate.value);
  const { value } = candidate;
  if (location.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON) {
    if (location.jsonString) {
      // Inside a string only text fits; a number would change the value's type.
      return typeof value === "string"
        ? escapeJsonStringFragment(value)
        : undefined;
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "string") return quoted ? undefined : String(value);
  if (location.scalarStyle === YAML_SCALAR_STYLES.DOUBLE_QUOTED) {
    return escapeJsonStringFragment(value);
  }
  if (location.scalarStyle === YAML_SCALAR_STYLES.SINGLE_QUOTED) {
    return value.replace(/'/g, "''");
  }
  return YAML_UNSAFE_PLAIN.test(value) ? JSON.stringify(value) : value;
}

/**
 * The outline definitions of `key` in the object at `ownerPath`. A step's
 * `type` lists every kind its slot allows, so a step can be switched to
 * `script` or `workflow`; an inline definition adds its `worktree`.
 */
function getOwnedProperties(
  location: WorkflowLocation,
  ownerPath: WorkflowPath,
  key: string,
  root: unknown
): WorkflowOutlineProperty[] {
  const kinds =
    key === PROMPT_PROPERTIES.STEP_TYPE &&
    stepSlotKinds(ownerPath, root).length > 0
      ? stepSlotKinds(ownerPath, root)
      : [location.objectKind];
  const properties = kinds.map(
    (kind) => WORKFLOW_SCHEMA_OUTLINE[kind]?.properties[key]
  );
  for (const extra of extraKeySources(ownerPath, root)) {
    if (extra.key === key) {
      properties.push(
        WORKFLOW_SCHEMA_OUTLINE[extra.sourceKind]?.properties[key]
      );
    }
  }
  return properties.filter(
    (property): property is WorkflowOutlineProperty => property !== undefined
  );
}

/** A literal that would select parent-run steps or sessions from an inline definition (D13). */
function crossesRunBoundary(
  key: string,
  value: ValueCandidate["value"]
): boolean {
  switch (key) {
    case PROMPT_PROPERTIES.PRIOR_CONTEXT:
      return isParentRunPriorContext(value);
    case PROMPT_PROPERTIES.SESSION_ID:
      return isParentRunSessionId(value);
    default:
      return false;
  }
}

function getValueItems(
  request: WorkflowFileCompletionRequest
): PlainCompletionItem[] {
  const { location, documentRoot } = request;
  const { key } = location;
  if (key === undefined) return [];
  const { ownerPath } = splitValuePath(location.path);
  const isElement = typeof location.path[location.path.length - 1] === "number";
  const outlineCandidates = isElement
    ? []
    : getOwnedProperties(location, ownerPath, key, documentRoot).flatMap(
        getOutlineCandidates
      );

  const candidates = [
    ...getDynamicCandidates(request, ownerPath, key, isElement).map(
      (candidate, index) => ({ candidate, sort: sortKey(SORT_DYNAMIC, index) })
    ),
    ...outlineCandidates
      .filter(
        (candidate) =>
          !location.inlineDefinition ||
          !crossesRunBoundary(key, candidate.value)
      )
      .map((candidate, index) => ({
        candidate,
        sort: sortKey(SORT_ENUM, index),
      })),
  ];

  const existing = valueAt(documentRoot, [...ownerPath, key]);
  const present = new Set(
    Array.isArray(existing)
      ? existing.map((entry: unknown) => String(entry))
      : []
  );
  // Only a list item can follow another value; a property value follows `:`.
  const separator = isElement
    ? jsonSeparator(request, getReplaceRange(request).start)
    : "";
  const seen = new Set<string>();
  const items: PlainCompletionItem[] = [];
  for (const { candidate, sort } of candidates) {
    const identity = String(candidate.value);
    if (seen.has(identity) || (isElement && present.has(identity))) continue;
    const insertText = formatValue(candidate, location);
    if (insertText === undefined) continue;
    seen.add(identity);
    items.push({
      label: candidate.label ?? identity,
      kind: sort.startsWith(SORT_DYNAMIC)
        ? COMPLETION_ITEM_KINDS.VALUE
        : COMPLETION_ITEM_KINDS.ENUM_MEMBER,
      insertText: separator + insertText,
      detail: candidate.detail,
      sortText: sort,
      filterText: candidate.raw ? undefined : identity,
    });
  }
  return items;
}

// ---------------------------------------------------------- file paths ----

/**
 * A path a plain YAML scalar cannot hold as typed: a leading indicator
 * character, or `: `/` #` inside it. `./x.ctrlyoke.yaml` stays plain.
 */
const YAML_UNSAFE_PLAIN_PATH = /^[-?:,[\]{}#&*!|>'"%@`\s]|:\s|\s#|\s$/;

/**
 * The text a host inserts for a workflow file path at a `WORKFLOW_FILE_PATH`
 * location, so the document still parses to that path: escaped inside a
 * string, quoted where a bare value would be another type or invalid.
 */
export function formatWorkflowFilePathInsert(
  filePath: string,
  location: WorkflowLocation
): string {
  if (
    location.kind !== CTRLYOKE_FILE_KINDS.WORKFLOW_JSON &&
    location.scalarStyle !== YAML_SCALAR_STYLES.DOUBLE_QUOTED &&
    location.scalarStyle !== YAML_SCALAR_STYLES.SINGLE_QUOTED &&
    !YAML_UNSAFE_PLAIN_PATH.test(filePath)
  ) {
    return filePath;
  }
  return formatValue({ value: filePath }, location) ?? filePath;
}

// --------------------------------------------------------------- entry ----

function getReplaceRange(
  request: WorkflowFileCompletionRequest
): WorkflowTextRange {
  const { text, offset, location } = request;
  const range = location.valueRange;
  if (
    (location.role === WORKFLOW_LOCATION_ROLES.VALUE ||
      location.role === WORKFLOW_LOCATION_ROLES.WORKFLOW_FILE_PATH) &&
    range &&
    range.start <= offset &&
    offset <= range.end &&
    !text.slice(range.start, range.end).includes("\n")
  ) {
    return range;
  }
  let start = offset;
  while (start > 0 && WORD_CHARACTER.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && WORD_CHARACTER.test(text[end])) end++;
  // A JSON key replaces its quotes too, so `"ha|"` becomes `"harness": `.
  if (
    location.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON &&
    location.role === WORKFLOW_LOCATION_ROLES.KEY
  ) {
    if (text[start - 1] === '"') start--;
    if (text[end] === '"') end++;
  }
  return { start, end };
}

/**
 * Key items at a key position and value items at a value position. Prompt and
 * script text, workflow file paths, comments and unknown objects get none; the
 * host routes those. A `WORKFLOW_FILE_PATH` result still carries the range a
 * host's path items replace.
 */
export function getWorkflowFileCompletions(
  request: WorkflowFileCompletionRequest
): WorkflowFileCompletions {
  const { role } = request.location;
  let items: PlainCompletionItem[] = [];
  if (role === WORKFLOW_LOCATION_ROLES.KEY) items = getKeyItems(request);
  else if (role === WORKFLOW_LOCATION_ROLES.VALUE)
    items = getValueItems(request);
  return { items, replaceRange: getReplaceRange(request) };
}
