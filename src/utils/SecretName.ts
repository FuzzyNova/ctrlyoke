/**
 * The rules for a managed secret's name. Free of Node built-ins so the dashboard
 * can validate names with the same pattern the extension and CLI enforce;
 * storage keys built from a name live in `platform/SecretKey.ts`.
 */

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Human-readable description of `SECRET_NAME_PATTERN`, shown to users instead of the raw
 * regex. Names are restricted to this shape so a declaration is always a legal env var name
 * and so the `!NAME` prompt-completion trigger (`PromptCompletionProvider`/`CodeMirrorEditor`)
 * never fires on ordinary lowercase prose or Markdown `![alt]` image syntax after a `!`.
 */
export const SECRET_NAME_REQUIREMENT_TEXT =
  "Secret name must start with a capital letter and contain only capital letters, numbers, or underscores.";

export type SecretName = string & { readonly __secretName: unique symbol };

/** Return whether a value is a legal managed secret name. */
export function isValidSecretName(value: string): value is SecretName {
  return SECRET_NAME_PATTERN.test(value);
}

/** Validate a managed secret name and throw an actionable error if invalid. */
export function validateSecretName(value: string): asserts value is SecretName {
  if (!isValidSecretName(value)) {
    throw new Error(
      `Invalid secret name "${value}". ${SECRET_NAME_REQUIREMENT_TEXT}`
    );
  }
}
