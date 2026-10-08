import {
  END_CONDITION_PROPERTIES,
  PROMPT_PROPERTIES,
  STEP_TYPES,
  WORKFLOW_HOOK_PROPERTIES,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
  type WorkflowLocationRole,
  type WorkflowObjectKind,
} from "../types/DashboardConstants";

/** Path segments from the document root, e.g. `["steps", 2, "endCondition"]`. */
export type WorkflowPath = readonly (string | number)[];

/** Half-open character offsets into the document text. */
export interface WorkflowTextRange {
  readonly start: number;
  readonly end: number;
}

export const YAML_SCALAR_STYLES = {
  PLAIN: "plain",
  SINGLE_QUOTED: "singleQuoted",
  DOUBLE_QUOTED: "doubleQuoted",
  BLOCK: "block",
} as const;
export type YamlScalarStyle =
  (typeof YAML_SCALAR_STYLES)[keyof typeof YAML_SCALAR_STYLES];

export interface WorkflowLocation {
  readonly kind: CtrlYokeFileKind;
  /** The node under the cursor; for a new key not yet typed, the owning object. */
  readonly path: WorkflowPath;
  readonly role: WorkflowLocationRole;
  /** The schema object that owns `key` (or the new key being typed). */
  readonly objectKind: WorkflowObjectKind;
  /** Nearest enclosing object key; the one being edited for KEY, the owner of the value otherwise. */
  readonly key?: string;
  /** Keys already present in the owning object, minus the key under the cursor. */
  readonly siblingKeys: readonly string[];
  /** Scalar content (inside quotes, after a block header); the body for markdown. */
  readonly valueRange?: WorkflowTextRange;
  /** The cursor is inside a JSON string literal, so inserted text must be escaped. */
  readonly jsonString?: boolean;
  readonly scalarStyle?: YamlScalarStyle;
}

/**
 * Which keys of which objects hold prompt or script text. Add a new
 * prompt-bearing field here and every consumer (completions, chips, lint) sees it.
 */
export const WORKFLOW_TEXT_FIELDS: readonly {
  readonly objectKind: WorkflowObjectKind;
  readonly key: string;
  readonly role: WorkflowLocationRole;
}[] = [
  ...[
    WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
    WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
  ].map((objectKind) => ({
    objectKind,
    key: PROMPT_PROPERTIES.PROMPT,
    role: WORKFLOW_LOCATION_ROLES.PROMPT_TEXT,
  })),
  {
    objectKind: WORKFLOW_OBJECT_KINDS.END_CONDITION,
    key: END_CONDITION_PROPERTIES.RETRY_PROMPT,
    role: WORKFLOW_LOCATION_ROLES.PROMPT_TEXT,
  },
  {
    objectKind: WORKFLOW_OBJECT_KINDS.END_CONDITION,
    key: END_CONDITION_PROPERTIES.PASS_RETRY_PROMPT,
    role: WORKFLOW_LOCATION_ROLES.PROMPT_TEXT,
  },
  ...[
    WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
    WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
    WORKFLOW_OBJECT_KINDS.END_CONDITION,
    WORKFLOW_OBJECT_KINDS.PRE_CONDITION,
  ].map((objectKind) => ({
    objectKind,
    key: PROMPT_PROPERTIES.SCRIPT,
    role: WORKFLOW_LOCATION_ROLES.SCRIPT_TEXT,
  })),
  {
    objectKind: WORKFLOW_OBJECT_KINDS.HOOK,
    key: WORKFLOW_HOOK_PROPERTIES.COMMAND,
    role: WORKFLOW_LOCATION_ROLES.SCRIPT_TEXT,
  },
];

/** The role of a scalar value under `key` of an `objectKind` object. */
export function getTextRole(
  objectKind: WorkflowObjectKind,
  key: string | undefined
): WorkflowLocationRole {
  return (
    WORKFLOW_TEXT_FIELDS.find(
      (field) => field.objectKind === objectKind && field.key === key
    )?.role ?? WORKFLOW_LOCATION_ROLES.VALUE
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: WorkflowPath): unknown {
  let node = root;
  for (const segment of path) {
    if (Array.isArray(node) && typeof segment === "number") {
      node = node[segment];
    } else if (isRecord(node) && typeof segment === "string") {
      node = node[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/** How many leading segments address a step (0 = the workflow root itself). */
function stepPrefixLength(path: WorkflowPath): number {
  if (path[0] === PROMPT_PROPERTIES.FINAL_STEP) return 1;
  if (path[0] === PROMPT_PROPERTIES.STEPS && typeof path[1] === "number") {
    return path[2] === PROMPT_PROPERTIES.PARALLEL && typeof path[3] === "number"
      ? 4
      : 2;
  }
  return 0;
}

const NESTED_OBJECT_KINDS: Readonly<Record<string, WorkflowObjectKind>> = {
  [PROMPT_PROPERTIES.END_CONDITION]: WORKFLOW_OBJECT_KINDS.END_CONDITION,
  [PROMPT_PROPERTIES.PRE_CONDITION]: WORKFLOW_OBJECT_KINDS.PRE_CONDITION,
  [PROMPT_PROPERTIES.TOOL_PERMISSIONS]: WORKFLOW_OBJECT_KINDS.TOOL_PERMISSIONS,
  [PROMPT_PROPERTIES.ERROR_BEHAVIOR]: WORKFLOW_OBJECT_KINDS.ERROR_BEHAVIOR,
};
const ROOT_ONLY_OBJECT_KINDS: Readonly<Record<string, WorkflowObjectKind>> = {
  [PROMPT_PROPERTIES.WORKTREE]: WORKFLOW_OBJECT_KINDS.WORKTREE,
  [PROMPT_PROPERTIES.VARS]: WORKFLOW_OBJECT_KINDS.VARS,
  [PROMPT_PROPERTIES.TEMPLATE_META]: WORKFLOW_OBJECT_KINDS.TEMPLATE_META,
};

/**
 * Which schema object lives at `objectPath`, given the (possibly partial)
 * parsed document. On a step, `type: script`, or a `script` without a
 * `prompt`, makes a script step; a `parallel` list makes a group.
 */
export function classifyWorkflowObject(
  objectPath: WorkflowPath,
  root: unknown
): WorkflowObjectKind {
  const prefix = stepPrefixLength(objectPath);
  const rest = objectPath.slice(prefix);
  if (rest.length === 0) {
    const node = valueAt(root, objectPath);
    const fields = isRecord(node) ? node : {};
    // The root stays the root even in a single-step script workflow: it still
    // allows root-only keys (`worktree`, `maxSteps`) that a script step forbids.
    if (prefix === 0) return WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT;
    if (prefix === 2 && fields[PROMPT_PROPERTIES.PARALLEL] !== undefined) {
      return WORKFLOW_OBJECT_KINDS.PARALLEL_GROUP;
    }
    const isScript =
      fields[PROMPT_PROPERTIES.STEP_TYPE] === STEP_TYPES.SCRIPT ||
      (fields[PROMPT_PROPERTIES.STEP_TYPE] === undefined &&
        fields[PROMPT_PROPERTIES.SCRIPT] !== undefined &&
        fields[PROMPT_PROPERTIES.PROMPT] === undefined);
    return isScript
      ? WORKFLOW_OBJECT_KINDS.SCRIPT_STEP
      : WORKFLOW_OBJECT_KINDS.PROMPT_STEP;
  }
  const head = String(rest[0]);
  if (rest.length === 1) {
    return (
      NESTED_OBJECT_KINDS[head] ??
      (prefix === 0 ? ROOT_ONLY_OBJECT_KINDS[head] : undefined) ??
      WORKFLOW_OBJECT_KINDS.UNKNOWN
    );
  }
  if (
    rest.length === 2 &&
    head === PROMPT_PROPERTIES.HOOKS &&
    typeof rest[1] === "number"
  ) {
    return WORKFLOW_OBJECT_KINDS.HOOK;
  }
  return WORKFLOW_OBJECT_KINDS.UNKNOWN;
}

/** Keys of the object at `objectPath`, for `siblingKeys`. */
export function getObjectKeys(
  objectPath: WorkflowPath,
  root: unknown
): string[] {
  const node = valueAt(root, objectPath);
  return isRecord(node) ? Object.keys(node) : [];
}

/** Offset of the line break ending the line that holds `offset` (or the text end). */
export function lineEndFrom(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

/** Splits a value path at its nearest object key: `steps,0,skills,1` -> owner `steps,0`, key `skills`. */
export function splitValuePath(path: WorkflowPath): {
  ownerPath: WorkflowPath;
  key?: string;
} {
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index];
    if (typeof segment === "string") {
      return { ownerPath: path.slice(0, index), key: segment };
    }
  }
  return { ownerPath: [] };
}

export interface WorkflowLocationInput {
  readonly kind: CtrlYokeFileKind;
  /** The partially parsed document, used to classify objects and list keys. */
  readonly root: unknown;
  readonly ownerPath: WorkflowPath;
  readonly key?: string;
  /** The cursor is on a key (existing, partial, or a new one in `ownerPath`). */
  readonly isKey: boolean;
  /** Full path of the value, when it is not simply `ownerPath + key` (list items). */
  readonly valuePath?: WorkflowPath;
  /** The value is a string or still empty, so it can hold prompt or script text. */
  readonly textCapable?: boolean;
  readonly valueRange?: WorkflowTextRange;
  readonly jsonString?: boolean;
  readonly scalarStyle?: YamlScalarStyle;
  /** Overrides the derived role, e.g. NONE for a comment. */
  readonly role?: WorkflowLocationRole;
}

/** The one place a `WorkflowLocation` is assembled, so every format agrees. */
export function buildWorkflowLocation(
  input: WorkflowLocationInput
): WorkflowLocation {
  const objectKind = classifyWorkflowObject(input.ownerPath, input.root);
  const role =
    input.role ??
    (input.isKey
      ? WORKFLOW_LOCATION_ROLES.KEY
      : input.textCapable
        ? getTextRole(objectKind, input.key)
        : WORKFLOW_LOCATION_ROLES.VALUE);
  const path =
    input.isKey || input.key === undefined
      ? input.key === undefined
        ? input.ownerPath
        : [...input.ownerPath, input.key]
      : (input.valuePath ?? [...input.ownerPath, input.key]);
  return {
    kind: input.kind,
    path,
    role,
    objectKind,
    key: input.key,
    siblingKeys: getObjectKeys(input.ownerPath, input.root).filter(
      (sibling) => !(input.isKey && sibling === input.key)
    ),
    valueRange: input.valueRange,
    jsonString: input.jsonString,
    scalarStyle: input.scalarStyle,
  };
}
