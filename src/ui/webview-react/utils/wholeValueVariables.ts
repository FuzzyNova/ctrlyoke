import {
  isVariableDefined,
  wholeValueVariableName,
} from "@root/utils/VariablePlaceholders";
import {
  VAR_SUBSTITUTION_KINDS,
  VAR_SUBSTITUTION_PATH_EACH_ITEM,
  VAR_SUBSTITUTION_PATH_EACH_KEY,
  VAR_SUBSTITUTION_POLICY,
  VAR_SUBSTITUTION_VIEWS,
  type VarSubstitutionPolicyEntry,
} from "@root/utils/VarSubstitutionPolicy";

/** A workflow's `vars` map. */
export type WorkflowVariables = Readonly<Record<string, string>>;

/** A whole-value `{{name}}` placeholder authored in a typed field. */
export type WorkflowVariablePlaceholder = `{{${string}}}`;

/** Whole-value workflow variables are resolved when the workflow runs. */
export function isWorkflowVariablePlaceholder(
  value: unknown
): value is WorkflowVariablePlaceholder {
  return wholeValueVariableName(value) !== undefined;
}

/** The variable named by a whole-value placeholder, if `value` is one. */
export function workflowVariableName(value: unknown): string | undefined {
  return wholeValueVariableName(value);
}

/** The current value of a whole-value placeholder in `vars`, if defined. */
export function resolveWorkflowVariable(
  value: unknown,
  vars: WorkflowVariables
): string | undefined {
  const name = wholeValueVariableName(value);
  return name !== undefined && isVariableDefined(vars, name)
    ? vars[name]
    : undefined;
}

/** Workflow-level views whose paths start at a workflow property. */
const WORKFLOW_PROPERTY_VIEWS: ReadonlySet<string> = new Set([
  VAR_SUBSTITUTION_VIEWS.WORKFLOW,
  VAR_SUBSTITUTION_VIEWS.RESOLVED_PROPERTIES,
]);

function pathHoldsPlaceholder(
  value: unknown,
  path: readonly string[]
): boolean {
  if (path.length === 0) return isWorkflowVariablePlaceholder(value);
  const [segment, ...rest] = path;
  if (segment === VAR_SUBSTITUTION_PATH_EACH_ITEM) {
    return (
      Array.isArray(value) &&
      value.some((item) => pathHoldsPlaceholder(item, rest))
    );
  }
  if (value === null || typeof value !== "object") return false;
  if (segment === VAR_SUBSTITUTION_PATH_EACH_KEY) {
    return Object.values(value).some((item) =>
      pathHoldsPlaceholder(item, rest)
    );
  }
  return (
    Object.prototype.hasOwnProperty.call(value, segment) &&
    pathHoldsPlaceholder((value as Record<string, unknown>)[segment], rest)
  );
}

/**
 * Whether a workflow-level property value holds a whole-value placeholder in
 * one of its `kind: value` fields. The settings schema types those fields
 * without `varPlaceholder`, so such a value cannot be promoted to a default.
 */
export function holdsValueFieldPlaceholder(
  property: string,
  value: unknown
): boolean {
  return (
    Object.values(VAR_SUBSTITUTION_POLICY) as VarSubstitutionPolicyEntry[]
  ).some(
    (entry) =>
      entry.kind === VAR_SUBSTITUTION_KINDS.VALUE &&
      WORKFLOW_PROPERTY_VIEWS.has(entry.view) &&
      entry.path[0] === property &&
      pathHoldsPlaceholder(value, entry.path.slice(1))
  );
}

/**
 * Parse the text of a number input that also accepts a typed `{{name}}`:
 * a whole-value placeholder is kept as written, anything else goes through
 * `parseNumber`.
 */
export function parseNumberOrVariable<T>(
  raw: string,
  parseNumber: (raw: string) => T
): T | WorkflowVariablePlaceholder {
  const trimmed = raw.trim();
  return isWorkflowVariablePlaceholder(trimmed) ? trimmed : parseNumber(raw);
}

/**
 * Typed step and workflow fields are declared with their resolved types, but
 * a `kind: value` field may hold an authored placeholder at runtime. This
 * hands such a value back to the typed field unchanged, so a save preserves
 * what the author wrote.
 */
export function asAuthoredValue<T>(value: T | WorkflowVariablePlaceholder): T {
  return value as T;
}

/** A step's `enabled` as the editor holds it: a flag or an authored placeholder. */
export type StepEnabledValue = boolean | WorkflowVariablePlaceholder;

/** Read an authored `enabled` (absent means enabled) without losing a placeholder. */
export function readStepEnabled(value: unknown): StepEnabledValue {
  return isWorkflowVariablePlaceholder(value) ? value : value !== false;
}

/**
 * The `enabled` patch for a save: a placeholder is written back as authored,
 * `false` is written, and `true` (the default) is omitted.
 */
export function stepEnabledPatch(value: StepEnabledValue): {
  enabled?: boolean;
} {
  if (isWorkflowVariablePlaceholder(value))
    return { enabled: asAuthoredValue<boolean>(value) };
  return value ? {} : { enabled: false };
}
