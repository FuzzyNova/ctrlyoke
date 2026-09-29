import { COMPATIBILITY_DIAGNOSTIC_SEVERITIES } from "../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";

export const KEY_VALUE_KEY_KINDS = {
  VARIABLE: "variable",
  ENV: "env",
  HEADER: "header",
} as const;

export type KeyValueKeyKind =
  (typeof KEY_VALUE_KEY_KINDS)[keyof typeof KEY_VALUE_KEY_KINDS];

/** The name syntax accepted by VarSubstitutor's `{{name}}` placeholders. */
export const VARIABLE_NAME_PATTERN_SOURCE = "\\w+";
export const VARIABLE_NAME_PATTERN = new RegExp(
  `^${VARIABLE_NAME_PATTERN_SOURCE}$`
);

/** Return workflow-variable key errors shared by file parsing and CLI overrides. */
export function getVariableKeyErrors(keys: readonly string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    if (!VARIABLE_NAME_PATTERN.test(key)) {
      errors.push(`Variable name "${key}" must match ^\\w+$`);
    }
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      errors.push(getVariableCaseCollisionError(key));
    } else {
      seen.add(normalized);
    }
  }

  return errors;
}

/** Return the parser/editor diagnostic for a case-insensitive variable collision. */
export function getVariableCaseCollisionError(key: string): string {
  return `Variable names must not differ only by case ("${key}")`;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type KeyValueKeyDiagnostic = Pick<
  CompatibilityDiagnostic,
  "severity" | "message"
>;

function error(message: string): KeyValueKeyDiagnostic {
  return {
    severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
    message,
  };
}

function warning(message: string): KeyValueKeyDiagnostic {
  return {
    severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
    message,
  };
}

function hasCaseCollision(key: string, allKeys: readonly string[]): boolean {
  const normalizedKey = key.toLowerCase();
  return allKeys.some(
    (candidate) =>
      candidate !== key && candidate.toLowerCase() === normalizedKey
  );
}

function suggestedVariableName(key: string): string {
  return key.replace(/[^\w]+/g, "_") || "_";
}

/**
 * Validate one key against its key-kind vocabulary and its sibling keys.
 *
 * `value` is optional because the key-only rules do not need it. Pass the
 * current row value when checking whether an empty key will be discarded.
 */
export function validateKeyValueKey(
  kind: KeyValueKeyKind,
  key: string,
  allKeys: readonly string[],
  value?: string
): KeyValueKeyDiagnostic[] {
  const diagnostics: KeyValueKeyDiagnostic[] = [];

  // A half-typed row is the normal state right after "+ Add", so an empty key
  // gets only the "this row is not saved" advisory. Running the name-pattern
  // and duplicate rules over it would flag every freshly added row as an
  // error before the user has typed anything.
  if (key.length === 0) {
    if (value !== undefined && value.length > 0) {
      diagnostics.push(
        warning("This row will not be saved because its key is empty.")
      );
    }
    return diagnostics;
  }

  if (allKeys.filter((candidate) => candidate === key).length > 1) {
    diagnostics.push(error("This key is duplicated exactly."));
  }

  switch (kind) {
    case KEY_VALUE_KEY_KINDS.VARIABLE:
      if (!VARIABLE_NAME_PATTERN.test(key)) {
        diagnostics.push(
          error(
            `Variable names must match ^\\w+$; use "${suggestedVariableName(
              key
            )}" instead.`
          )
        );
      }
      if (hasCaseCollision(key, allKeys)) {
        diagnostics.push(error(getVariableCaseCollisionError(key)));
      }
      break;

    case KEY_VALUE_KEY_KINDS.ENV:
      if (!ENV_NAME_PATTERN.test(key)) {
        diagnostics.push(
          error(
            "Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores."
          )
        );
      }
      if (key !== key.toUpperCase()) {
        diagnostics.push(
          warning("Environment variable names are conventionally uppercase.")
        );
      }
      if (key.startsWith("CTRLYOKE_VAR_")) {
        diagnostics.push(
          warning(
            "This key shadows the workflow variable exported with the same CTRLYOKE_VAR_ name."
          )
        );
      }
      break;

    case KEY_VALUE_KEY_KINDS.HEADER:
      if (!HEADER_TOKEN_PATTERN.test(key)) {
        diagnostics.push(error("Header names must be RFC 7230 tokens."));
      }
      if (hasCaseCollision(key, allKeys)) {
        diagnostics.push(
          error("HTTP header names must not differ only by case.")
        );
      }
      break;
  }

  return diagnostics;
}
