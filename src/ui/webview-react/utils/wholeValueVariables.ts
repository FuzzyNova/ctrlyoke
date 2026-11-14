import {
  isVariableDefined,
  wholeValueVariableName,
} from "@root/utils/VariablePlaceholders";

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
