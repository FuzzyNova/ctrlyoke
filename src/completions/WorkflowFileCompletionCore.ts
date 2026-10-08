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
import { getWorkflowPropertySnippet } from "./WorkflowPropertySnippets";
import {
  isRecord,
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

const FINAL_STEP_SESSION = PROMPT_PROPERTIES.FINAL_STEP;
const MODEL_NONE = "none";
const WORD_CHARACTER = /[\w.\-@$]/;
/** A plain YAML scalar that would parse as another type or special syntax. */
const YAML_UNSAFE_PLAIN =
  /^(?![A-Za-z_./@][\w./@-]*$)|^(true|false|null|yes|no|on|off|y|n)$/i;
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

/** The outline objects a key at this slot can come from, in priority order. */
function keySourceKinds(
  location: WorkflowLocation,
  root: unknown
): WorkflowObjectKind[] {
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
  if (isGroupSlot) {
    return [
      WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
      WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
      WORKFLOW_OBJECT_KINDS.PARALLEL_GROUP,
    ];
  }
  return isMemberSlot || isFinalStepSlot
    ? [WORKFLOW_OBJECT_KINDS.PROMPT_STEP, WORKFLOW_OBJECT_KINDS.SCRIPT_STEP]
    : [location.objectKind];
}

/** A workflow root holds both a single step's keys and a multi-step workflow's; the document picks. */
function rootKeyIsRelevant(root: unknown): (key: string) => boolean {
  const fields = isRecord(root) ? root : {};
  const promptKeys = Object.keys(
    WORKFLOW_SCHEMA_OUTLINE[WORKFLOW_OBJECT_KINDS.PROMPT_STEP]?.properties ?? {}
  );
  const scriptOnly = new Set(
    Object.keys(
      WORKFLOW_SCHEMA_OUTLINE[WORKFLOW_OBJECT_KINDS.SCRIPT_STEP]?.properties ??
        {}
    ).filter((key) => !promptKeys.includes(key))
  );
  const multiStepKeys: string[] = [
    PROMPT_PROPERTIES.STEPS,
    PROMPT_PROPERTIES.FINAL_STEP,
  ];
  const isMulti = multiStepKeys.some((key) => fields[key] !== undefined);
  const isScript =
    fields[PROMPT_PROPERTIES.SCRIPT] !== undefined ||
    fields[PROMPT_PROPERTIES.STEP_TYPE] === STEP_TYPES.SCRIPT;
  const isPrompt = fields[PROMPT_PROPERTIES.PROMPT] !== undefined;
  if (isMulti) {
    return (key) =>
      !scriptOnly.has(key) &&
      key !== PROMPT_PROPERTIES.PROMPT &&
      key !== PROMPT_PROPERTIES.STEP_TYPE;
  }
  if (isScript)
    return (key) =>
      !multiStepKeys.includes(key) && key !== PROMPT_PROPERTIES.PROMPT;
  if (isPrompt)
    return (key) => !multiStepKeys.includes(key) && !scriptOnly.has(key);
  return () => true;
}

function leadingKeyIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^(\s*)(-\s+)?/.exec(text.slice(lineStart, offset));
  const width = (match?.[1].length ?? 0) + (match?.[2]?.length ?? 0);
  return " ".repeat(width);
}

function keyInsertText(
  request: WorkflowFileCompletionRequest,
  key: string,
  property: WorkflowOutlineProperty,
  snippetText: string | undefined
): string {
  const { location, text, offset } = request;
  if (location.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_JSON) {
    return `"${key}": `;
  }
  const body =
    snippetText ?? (isCollectionOnly(property) ? `${key}:\n  ` : `${key}: `);
  return body.replace(/\n/g, `\n${leadingKeyIndent(text, offset)}`);
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

  for (const sourceKind of keySourceKinds(location, documentRoot)) {
    const outline: WorkflowObjectOutline | undefined =
      WORKFLOW_SCHEMA_OUTLINE[sourceKind];
    if (!outline) continue;
    for (const [key, property] of Object.entries(outline.properties)) {
      if (
        taken.has(key) ||
        offered.has(key) ||
        outline.forbiddenKeys.includes(key) ||
        !isRelevant(key)
      ) {
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
          snippet.insertSnippet
        ),
        detail: property.deprecated ? `Deprecated · ${detail}` : detail,
        documentation: property.description ?? snippet.documentation,
        sortText: sortKey(
          property.deprecated ? SORT_DEPRECATED : SORT_DYNAMIC,
          items.length
        ),
      });
    }
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
  const stepPath =
    ownerPath[0] === PROMPT_PROPERTIES.FINAL_STEP
      ? ownerPath.slice(0, 1)
      : ownerPath.slice(0, ownerPath[2] === PROMPT_PROPERTIES.PARALLEL ? 4 : 2);
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
    case PROMPT_PROPERTIES.PRIOR_CONTEXT:
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
      const final = isRecord(root) && root[FINAL_STEP_SESSION] !== undefined;
      return [
        ...(final
          ? [{ value: FINAL_STEP_SESSION, detail: "Session of the final step" }]
          : []),
        ...earlierSteps(root, ownerPath).map((step) => ({
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
  if (candidate.raw)
    return location.jsonString ? undefined : String(candidate.value);
  const { value } = candidate;
  const quoted =
    location.scalarStyle === YAML_SCALAR_STYLES.DOUBLE_QUOTED ||
    location.scalarStyle === YAML_SCALAR_STYLES.SINGLE_QUOTED;
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

function getValueItems(
  request: WorkflowFileCompletionRequest
): PlainCompletionItem[] {
  const { location, documentRoot } = request;
  const { key } = location;
  if (key === undefined) return [];
  const outline = WORKFLOW_SCHEMA_OUTLINE[location.objectKind];
  const property = outline?.properties[key];
  const { ownerPath } = splitValuePath(location.path);
  const isElement = typeof location.path[location.path.length - 1] === "number";

  const candidates = [
    ...getDynamicCandidates(request, ownerPath, key, isElement).map(
      (candidate, index) => ({ candidate, sort: sortKey(SORT_DYNAMIC, index) })
    ),
    ...(property && !isElement ? getOutlineCandidates(property) : []).map(
      (candidate, index) => ({ candidate, sort: sortKey(SORT_ENUM, index) })
    ),
  ];

  const existing = valueAt(documentRoot, [...ownerPath, key]);
  const present = new Set(
    Array.isArray(existing)
      ? existing.map((entry: unknown) => String(entry))
      : []
  );
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
      insertText,
      detail: candidate.detail,
      sortText: sort,
      filterText: candidate.raw ? undefined : identity,
    });
  }
  return items;
}

// --------------------------------------------------------------- entry ----

function getReplaceRange(
  request: WorkflowFileCompletionRequest
): WorkflowTextRange {
  const { text, offset, location } = request;
  const range = location.valueRange;
  if (
    location.role === WORKFLOW_LOCATION_ROLES.VALUE &&
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
 * script text, comments and unknown objects get none; the host routes those.
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
