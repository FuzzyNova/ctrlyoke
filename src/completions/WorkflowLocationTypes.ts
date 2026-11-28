import { isRecord } from "../utils/JsonTypeGuards";
import {
  END_CONDITION_PROPERTIES,
  PROMPT_PROPERTIES,
  STEP_TYPES,
  WORKFLOW_HOOK_PROPERTIES,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type WorkflowFileKind,
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
  readonly kind: WorkflowFileKind;
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
  /** Inside a YAML flow collection (`{ ... }`, `[ ... ]`), where only single-line flow syntax is valid. */
  readonly inFlowCollection?: boolean;
  /**
   * Inside a sub-workflow step's inline `workflow` definition, which is the
   * first step of a new child run: step numbers, sessions and `$previous`-style
   * references cannot reach the parent run from here (D13).
   */
  readonly inlineDefinition?: boolean;
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
  ...[
    WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
    WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP,
  ].map((objectKind) => ({
    objectKind,
    key: PROMPT_PROPERTIES.WORKFLOW_REF,
    role: WORKFLOW_LOCATION_ROLES.WORKFLOW_FILE_PATH,
  })),
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

export function valueAt(root: unknown, path: WorkflowPath): unknown {
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

function isSubWorkflowNode(node: unknown): boolean {
  return (
    isRecord(node) && node[PROMPT_PROPERTIES.STEP_TYPE] === STEP_TYPES.WORKFLOW
  );
}

/**
 * The step a path is inside. A `type: workflow` step's `workflow` object is an
 * inline definition, a step of its own, so it extends the prefix by one.
 */
function locateStep(
  path: WorkflowPath,
  root: unknown
): { readonly length: number; readonly inline: boolean } {
  const length = stepPrefixLength(path);
  const inline =
    path[length] === PROMPT_PROPERTIES.WORKFLOW_REF &&
    isSubWorkflowNode(valueAt(root, path.slice(0, length)));
  return inline ? { length: length + 1, inline } : { length, inline };
}

/** The path of the inline sub-workflow definition `path` is in, if any (D13). */
export function getInlineDefinitionPath(
  path: WorkflowPath,
  root: unknown
): WorkflowPath | undefined {
  const step = locateStep(path, root);
  return step.inline ? path.slice(0, step.length) : undefined;
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
 * parsed document. On a step, `type: workflow` makes a sub-workflow step,
 * `type: script`, or a `script` without a `prompt`, makes a script step, and a
 * `parallel` list makes a group. A sub-workflow step's inline `workflow`
 * object is a prompt or script step by the same rules (D13).
 */
export function classifyWorkflowObject(
  objectPath: WorkflowPath,
  root: unknown
): WorkflowObjectKind {
  const { length: prefix, inline } = locateStep(objectPath, root);
  const rest = objectPath.slice(prefix);
  if (rest.length === 0) {
    const node = valueAt(root, objectPath);
    const fields = isRecord(node) ? node : {};
    // The root stays the root even in a single-step script workflow: it still
    // allows root-only keys (`worktree`, `maxSteps`) that a script step forbids.
    if (prefix === 0) return WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT;
    if (!inline) {
      if (prefix === 2 && fields[PROMPT_PROPERTIES.PARALLEL] !== undefined) {
        return WORKFLOW_OBJECT_KINDS.PARALLEL_GROUP;
      }
      if (isSubWorkflowNode(fields)) {
        return WORKFLOW_OBJECT_KINDS.SUB_WORKFLOW_STEP;
      }
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
  // A sub-workflow step's only object-valued key is its inline `workflow`,
  // which `locateStep` already treated as a step.
  if (
    !inline &&
    prefix > 0 &&
    isSubWorkflowNode(valueAt(root, objectPath.slice(0, prefix)))
  ) {
    return WORKFLOW_OBJECT_KINDS.UNKNOWN;
  }
  const head = String(rest[0]);
  if (rest.length === 1) {
    return (
      NESTED_OBJECT_KINDS[head] ??
      (prefix === 0 ? ROOT_ONLY_OBJECT_KINDS[head] : undefined) ??
      // An inline definition's only workflow-only key (D13).
      (inline && head === PROMPT_PROPERTIES.WORKTREE
        ? WORKFLOW_OBJECT_KINDS.WORKTREE
        : undefined) ??
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
function getObjectKeys(objectPath: WorkflowPath, root: unknown): string[] {
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
  readonly kind: WorkflowFileKind;
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
  readonly inFlowCollection?: boolean;
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
    inFlowCollection: input.inFlowCollection || undefined,
    inlineDefinition:
      getInlineDefinitionPath(input.ownerPath, input.root) !== undefined ||
      undefined,
  };
}
