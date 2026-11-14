/** Phases in which workflow variable fields are resolved. */
export const VAR_SUBSTITUTION_PHASES = {
  RUN_START: "run-start",
  DISPATCH: "dispatch",
} as const;
export type VarSubstitutionPhase =
  (typeof VAR_SUBSTITUTION_PHASES)[keyof typeof VAR_SUBSTITUTION_PHASES];

export const VAR_SUBSTITUTION_KINDS = { TEXT: "text", VALUE: "value" } as const;
export type VarSubstitutionKind =
  (typeof VAR_SUBSTITUTION_KINDS)[keyof typeof VAR_SUBSTITUTION_KINDS];
export const VAR_SUBSTITUTION_UNRESOLVED = {
  ADVISORY: "advisory",
  ERROR: "error",
} as const;
export type VarSubstitutionUnresolved =
  (typeof VAR_SUBSTITUTION_UNRESOLVED)[keyof typeof VAR_SUBSTITUTION_UNRESOLVED];

/**
 * The object a policy entry's `path` is relative to. Each `VarSubstitutor`
 * entry point walks exactly one view, so a field is substituted once.
 */
export const VAR_SUBSTITUTION_VIEWS = {
  /** The workflow root (`PromptFile`). */
  WORKFLOW: "workflow",
  /** The workflow's `worktree` object. */
  WORKFLOW_WORKTREE: "workflow.worktree",
  /** The settings' `defaults.worktree` object. */
  DEFAULT_WORKTREE: "defaults.worktree",
  /** One queue step or the `finalStep`. */
  STEP: "step",
  /** A step's resolved execution properties (`ResolvedProperties`). */
  RESOLVED_PROPERTIES: "resolvedProperties",
  /** A script step as it is dispatched. */
  SCRIPT_STEP: "scriptStep",
  /** Prompt text: the authored prompt, a prompt-file path, or the loaded file. */
  PROMPT_TEXT: "promptText",
} as const;
export type VarSubstitutionView =
  (typeof VAR_SUBSTITUTION_VIEWS)[keyof typeof VAR_SUBSTITUTION_VIEWS];

/** Path segment matching every item of an array. */
export const VAR_SUBSTITUTION_PATH_EACH_ITEM = "[]";
/** Path segment matching every value of a string map. */
export const VAR_SUBSTITUTION_PATH_EACH_KEY = "*";

/** Extra check for a `text` field whose substituted value has a fixed shape. */
export interface VarSubstitutionTextPostValidator {
  /** What a valid value looks like, for the failure message. */
  readonly expected: string;
  /** The value to use, or `undefined` when the substituted text is invalid. */
  readonly convert: (value: string) => unknown;
}

interface VarSubstitutionEntryBase {
  readonly phase: VarSubstitutionPhase;
  readonly fencedCodeProtected: boolean;
  readonly unresolved: VarSubstitutionUnresolved;
  readonly view: VarSubstitutionView;
  /** Property path inside `view`; `[]` and `*` match every item or map value. */
  readonly path: readonly string[];
  /**
   * For a `*` map: the sibling property of the map listing keys that stay
   * literal (agent-supplied preset param values).
   */
  readonly literalKeysFrom?: string;
}

export interface VarSubstitutionTextEntry extends VarSubstitutionEntryBase {
  readonly kind: typeof VAR_SUBSTITUTION_KINDS.TEXT;
  readonly postValidate?: VarSubstitutionTextPostValidator;
}

export interface VarSubstitutionValueEntry extends VarSubstitutionEntryBase {
  readonly kind: typeof VAR_SUBSTITUTION_KINDS.VALUE;
  /**
   * JSON pointer into `workflow-schema.json` of the field's original
   * sub-schema (the non-placeholder `oneOf` branch). The coerced value is
   * validated against it and the failure message is built from it.
   */
  readonly schema: string;
}

export type VarSubstitutionPolicyEntry =
  VarSubstitutionTextEntry | VarSubstitutionValueEntry;

const { RUN_START, DISPATCH } = VAR_SUBSTITUTION_PHASES;
const { ADVISORY, ERROR } = VAR_SUBSTITUTION_UNRESOLVED;
const VIEW = VAR_SUBSTITUTION_VIEWS;
const EACH_ITEM = VAR_SUBSTITUTION_PATH_EACH_ITEM;
const EACH_KEY = VAR_SUBSTITUTION_PATH_EACH_KEY;
const MCP_LITERAL_ENV_KEYS = "mcpLiteralEnvKeys";

function textField(
  phase: VarSubstitutionPhase,
  unresolved: VarSubstitutionUnresolved,
  view: VarSubstitutionView,
  path: readonly string[],
  options: Pick<
    VarSubstitutionTextEntry,
    "fencedCodeProtected" | "literalKeysFrom" | "postValidate"
  > = { fencedCodeProtected: false }
): VarSubstitutionTextEntry {
  return {
    phase,
    kind: VAR_SUBSTITUTION_KINDS.TEXT,
    unresolved,
    view,
    path,
    ...options,
  };
}

function valueField(
  phase: VarSubstitutionPhase,
  view: VarSubstitutionView,
  path: readonly string[],
  schema: string
): VarSubstitutionValueEntry {
  return {
    phase,
    kind: VAR_SUBSTITUTION_KINDS.VALUE,
    fencedCodeProtected: false,
    unresolved: ERROR,
    view,
    path,
    schema,
  };
}

/** A dispatch `value` field of the resolved execution properties. */
function resolvedValue(
  path: readonly string[],
  schema: string
): VarSubstitutionValueEntry {
  return valueField(DISPATCH, VIEW.RESOLVED_PROPERTIES, path, schema);
}

const PROMPT_TEXT_OPTIONS = { fencedCodeProtected: true } as const;
const LITERAL_ENV_OPTIONS = {
  fencedCodeProtected: false,
  literalKeysFrom: MCP_LITERAL_ENV_KEYS,
} as const;

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const RUN_REF_PATTERN = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const PRIOR_CONTEXT_RUN: VarSubstitutionTextPostValidator = {
  expected: "an integer or run reference",
  convert: (value) =>
    POSITIVE_INTEGER_PATTERN.test(value)
      ? Number(value)
      : RUN_REF_PATTERN.test(value)
        ? value
        : undefined,
};

const SCRIPT_PROPERTY = (name: string): string =>
  `/$defs/scriptProperties/properties/${name}/oneOf/0`;
const EXECUTION_PROPERTY = (name: string): string =>
  `/$defs/executionProperties/properties/${name}/oneOf/0`;
const HARNESS_ID_SCHEMA = "/$defs/harnessId";

export const VAR_SUBSTITUTION_POLICY = {
  "worktree.branch": textField(RUN_START, ERROR, VIEW.WORKFLOW_WORKTREE, [
    "branch",
  ]),
  "worktree.base": textField(RUN_START, ERROR, VIEW.WORKFLOW_WORKTREE, [
    "base",
  ]),
  "worktree.directory": textField(RUN_START, ERROR, VIEW.WORKFLOW_WORKTREE, [
    "directory",
  ]),
  "defaults.worktree.branch": textField(
    RUN_START,
    ERROR,
    VIEW.DEFAULT_WORKTREE,
    ["branch"]
  ),
  "defaults.worktree.base": textField(RUN_START, ERROR, VIEW.DEFAULT_WORKTREE, [
    "base",
  ]),
  "defaults.worktree.directory": textField(
    RUN_START,
    ERROR,
    VIEW.DEFAULT_WORKTREE,
    ["directory"]
  ),
  harness: valueField(RUN_START, VIEW.WORKFLOW, ["harness"], HARNESS_ID_SCHEMA),
  "steps[].harness": valueField(
    RUN_START,
    VIEW.STEP,
    ["harness"],
    HARNESS_ID_SCHEMA
  ),
  "steps[].enabled": valueField(
    RUN_START,
    VIEW.STEP,
    ["enabled"],
    "/$defs/promptStep/allOf/1/properties/enabled/oneOf/0"
  ),
  maxSteps: valueField(
    RUN_START,
    VIEW.WORKFLOW,
    ["maxSteps"],
    "/$defs/maxStepsValue"
  ),
  "steps[].prompt": textField(
    DISPATCH,
    ADVISORY,
    VIEW.PROMPT_TEXT,
    [],
    PROMPT_TEXT_OPTIONS
  ),
  "steps[].model": textField(DISPATCH, ADVISORY, VIEW.RESOLVED_PROPERTIES, [
    "model",
  ]),
  "steps[].name": textField(DISPATCH, ERROR, VIEW.STEP, ["name"]),
  "steps[].expected": textField(DISPATCH, ERROR, VIEW.STEP, ["expected"]),
  "steps[].shell": textField(DISPATCH, ERROR, VIEW.STEP, ["shell"]),
  "steps[].agent": textField(DISPATCH, ERROR, VIEW.STEP, ["agent"]),
  "steps[].skills[]": textField(DISPATCH, ERROR, VIEW.STEP, [
    "skills",
    EACH_ITEM,
  ]),
  "steps[].sessionId": textField(DISPATCH, ERROR, VIEW.STEP, ["sessionId"]),
  "steps[].priorContext.workflow": textField(DISPATCH, ERROR, VIEW.STEP, [
    "priorContext",
    "workflow",
  ]),
  "steps[].priorContext.run": textField(
    DISPATCH,
    ERROR,
    VIEW.STEP,
    ["priorContext", "run"],
    { fencedCodeProtected: false, postValidate: PRIOR_CONTEXT_RUN }
  ),
  "steps[].executionMode": valueField(
    DISPATCH,
    VIEW.STEP,
    ["executionMode"],
    EXECUTION_PROPERTY("executionMode")
  ),
  "steps[].timeoutSec": valueField(
    DISPATCH,
    VIEW.STEP,
    ["timeoutSec"],
    SCRIPT_PROPERTY("timeoutSec")
  ),
  "steps[].compareSource": valueField(
    DISPATCH,
    VIEW.STEP,
    ["compareSource"],
    SCRIPT_PROPERTY("compareSource")
  ),
  "steps[].operator": valueField(
    DISPATCH,
    VIEW.STEP,
    ["operator"],
    SCRIPT_PROPERTY("operator")
  ),
  "steps[].ignoreCase": valueField(
    DISPATCH,
    VIEW.STEP,
    ["ignoreCase"],
    SCRIPT_PROPERTY("ignoreCase")
  ),
  "steps[].onPass": valueField(
    DISPATCH,
    VIEW.STEP,
    ["onPass"],
    "/$defs/scriptStep/properties/onPass/oneOf/0"
  ),
  "steps[].onFail": valueField(
    DISPATCH,
    VIEW.STEP,
    ["onFail"],
    "/$defs/scriptStep/properties/onFail/oneOf/0"
  ),
  "steps[].errorBehavior.onError": valueField(
    DISPATCH,
    VIEW.STEP,
    ["errorBehavior", "onError"],
    "/$defs/errorBehavior/properties/onError/oneOf/0"
  ),
  "steps[].errorBehavior.maxRetries": valueField(
    DISPATCH,
    VIEW.STEP,
    ["errorBehavior", "maxRetries"],
    "/$defs/errorBehavior/properties/maxRetries/oneOf/0"
  ),
  "steps[].errorBehavior.retryDelaySec": valueField(
    DISPATCH,
    VIEW.STEP,
    ["errorBehavior", "retryDelaySec"],
    "/$defs/errorBehavior/properties/retryDelaySec/oneOf/0"
  ),
  "steps[].additionalArgs": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["additionalArgs"]
  ),
  // Inherited execution properties. These walk the resolved properties, so
  // one entry covers a value authored on the step, the finalStep, the
  // workflow root or the settings `defaults`.
  executionMode: resolvedValue(
    ["executionMode"],
    EXECUTION_PROPERTY("executionMode")
  ),
  resumeSession: resolvedValue(
    ["resumeSession"],
    EXECUTION_PROPERTY("resumeSession")
  ),
  priorContextDetail: resolvedValue(
    ["priorContextDetail"],
    EXECUTION_PROPERTY("priorContextDetail")
  ),
  "errorBehavior.onError": resolvedValue(
    ["errorBehavior", "onError"],
    "/$defs/errorBehavior/properties/onError/oneOf/0"
  ),
  "errorBehavior.maxRetries": resolvedValue(
    ["errorBehavior", "maxRetries"],
    "/$defs/errorBehavior/properties/maxRetries/oneOf/0"
  ),
  "errorBehavior.retryDelaySec": resolvedValue(
    ["errorBehavior", "retryDelaySec"],
    "/$defs/errorBehavior/properties/retryDelaySec/oneOf/0"
  ),
  "preCondition.onPass": resolvedValue(
    ["preCondition", "onPass"],
    "/$defs/preCondition/properties/onPass/oneOf/0"
  ),
  "preCondition.onFail": resolvedValue(
    ["preCondition", "onFail"],
    "/$defs/preCondition/properties/onFail/oneOf/0"
  ),
  "preCondition.timeoutSec": resolvedValue(
    ["preCondition", "timeoutSec"],
    SCRIPT_PROPERTY("timeoutSec")
  ),
  "preCondition.compareSource": resolvedValue(
    ["preCondition", "compareSource"],
    SCRIPT_PROPERTY("compareSource")
  ),
  "preCondition.operator": resolvedValue(
    ["preCondition", "operator"],
    SCRIPT_PROPERTY("operator")
  ),
  "preCondition.ignoreCase": resolvedValue(
    ["preCondition", "ignoreCase"],
    SCRIPT_PROPERTY("ignoreCase")
  ),
  "endCondition.maxRetries": resolvedValue(
    ["endCondition", "maxRetries"],
    "/$defs/endCondition/properties/maxRetries/oneOf/0"
  ),
  "endCondition.onPass": resolvedValue(
    ["endCondition", "onPass"],
    "/$defs/endCondition/properties/onPass/oneOf/0"
  ),
  "endCondition.onFail": resolvedValue(
    ["endCondition", "onFail"],
    "/$defs/endCondition/properties/onFail/oneOf/0"
  ),
  "endCondition.timeoutSec": resolvedValue(
    ["endCondition", "timeoutSec"],
    SCRIPT_PROPERTY("timeoutSec")
  ),
  "endCondition.compareSource": resolvedValue(
    ["endCondition", "compareSource"],
    SCRIPT_PROPERTY("compareSource")
  ),
  "endCondition.operator": resolvedValue(
    ["endCondition", "operator"],
    SCRIPT_PROPERTY("operator")
  ),
  "endCondition.ignoreCase": resolvedValue(
    ["endCondition", "ignoreCase"],
    SCRIPT_PROPERTY("ignoreCase")
  ),
  "hooks[].command": textField(DISPATCH, ADVISORY, VIEW.RESOLVED_PROPERTIES, [
    "hooks",
    EACH_ITEM,
    "command",
  ]),
  "hooks[].env.*": textField(DISPATCH, ADVISORY, VIEW.RESOLVED_PROPERTIES, [
    "hooks",
    EACH_ITEM,
    "env",
    EACH_KEY,
  ]),
  "preCondition.script": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["preCondition", "script"]
  ),
  "preCondition.env.*": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["preCondition", "env", EACH_KEY],
    LITERAL_ENV_OPTIONS
  ),
  "endCondition.script": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["endCondition", "script"]
  ),
  "endCondition.env.*": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["endCondition", "env", EACH_KEY],
    LITERAL_ENV_OPTIONS
  ),
  "endCondition.retryPrompt": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["endCondition", "retryPrompt"],
    PROMPT_TEXT_OPTIONS
  ),
  "endCondition.passRetryPrompt": textField(
    DISPATCH,
    ADVISORY,
    VIEW.RESOLVED_PROPERTIES,
    ["endCondition", "passRetryPrompt"],
    PROMPT_TEXT_OPTIONS
  ),
  "scriptStep.script": textField(DISPATCH, ADVISORY, VIEW.SCRIPT_STEP, [
    "script",
  ]),
  "scriptStep.env.*": textField(
    DISPATCH,
    ADVISORY,
    VIEW.SCRIPT_STEP,
    ["env", EACH_KEY],
    LITERAL_ENV_OPTIONS
  ),
  "worktree.setup": textField(DISPATCH, ADVISORY, VIEW.WORKFLOW_WORKTREE, [
    "setup",
  ]),
  "defaults.worktree.setup": textField(
    DISPATCH,
    ADVISORY,
    VIEW.DEFAULT_WORKTREE,
    ["setup"]
  ),
} as const satisfies Record<string, VarSubstitutionPolicyEntry>;

export type VarSubstitutionPolicyField = keyof typeof VAR_SUBSTITUTION_POLICY;

/** Fields deliberately excluded from substitution, with the policy reason. */
export const VAR_SUBSTITUTION_EXCLUDED_FIELDS = [
  {
    path: "trustedExternalRoots",
    reason: "Approval is keyed to the authored value.",
  },
  {
    path: "secrets",
    reason: "Secret grant approval is keyed to authored grant names.",
  },
  {
    path: "toolPermissions",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "sandbox",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "sandboxMode",
    reason: "Permission posture must match the reviewed value.",
  },
  {
    path: "mcpServers",
    reason: "Entries launch programs and carry authored secret grants.",
  },
  {
    path: "conditions",
    reason: "Preset definitions and parameter names are author-only contracts.",
  },
  { path: "vars", reason: "Variables are not recursively expanded." },
] as const;
