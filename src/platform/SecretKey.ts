import { createHash } from "node:crypto";
import * as path from "node:path";
import { foldPathForCompare } from "../utils/PathCasing";

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Human-readable description of `SECRET_NAME_PATTERN`, shown to users instead of the raw
 * regex. Names are restricted to this shape so a declaration is always a legal env var name
 * and so the `!NAME` prompt-completion trigger (`PromptCompletionProvider`/`CodeMirrorEditor`)
 * never fires on ordinary lowercase prose or Markdown `![alt]` image syntax after a `!`.
 */
export const SECRET_NAME_REQUIREMENT_TEXT =
  "Secret name must start with a capital letter and contain only capital letters, numbers, or underscores.";

const USER_SECRET_PREFIX = "ctrlyoke.secret.user";
const WORKSPACE_SECRET_PREFIX = "ctrlyoke.secret.ws";
const USER_SECRET_METADATA_PREFIX = "ctrlyoke.secret.meta.user";
const WORKSPACE_SECRET_METADATA_PREFIX = "ctrlyoke.secret.meta.ws";
const WORKSPACE_HASH_LENGTH = 12;
const WORKSPACE_HASH_PATTERN = /^[0-9a-f]{12}$/i;

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

/** Build the user-scoped key for a managed secret. */
export function userSecretKey(name: string): string {
  validateSecretName(name);
  return `${USER_SECRET_PREFIX}.${name}`;
}

/** Build a workspace-scoped key from the stable workspace hash. */
export function workspaceSecretKey(
  workspaceHash: string,
  name: string
): string {
  validateSecretName(name);
  if (!WORKSPACE_HASH_PATTERN.test(workspaceHash)) {
    throw new Error(
      `Invalid workspace secret hash "${workspaceHash}". Expected 12 hexadecimal characters.`
    );
  }
  return `${WORKSPACE_SECRET_PREFIX}.${workspaceHash.toLowerCase()}.${name}`;
}

/** Hash a workspace root for use with workspace-scoped secret keys. */
export function workspaceSecretHash(workspaceRoot: string): string {
  const canonicalRoot = foldPathForCompare(path.resolve(workspaceRoot));
  return createHash("sha256")
    .update(canonicalRoot, "utf8")
    .digest("hex")
    .slice(0, WORKSPACE_HASH_LENGTH);
}

/** Build a workspace-scoped key directly from a workspace root. */
export function workspaceSecretKeyForRoot(
  workspaceRoot: string,
  name: string
): string {
  return workspaceSecretKey(workspaceSecretHash(workspaceRoot), name);
}

/** Build the user-scoped metadata key for a managed secret. */
export function userSecretMetadataKey(name: string): string {
  validateSecretName(name);
  return `${USER_SECRET_METADATA_PREFIX}.${name}`;
}

/** Build a workspace-scoped metadata key from the stable workspace hash. */
export function workspaceSecretMetadataKey(
  workspaceHash: string,
  name: string
): string {
  validateSecretName(name);
  if (!WORKSPACE_HASH_PATTERN.test(workspaceHash)) {
    throw new Error(
      `Invalid workspace secret hash "${workspaceHash}". Expected 12 hexadecimal characters.`
    );
  }
  return `${WORKSPACE_SECRET_METADATA_PREFIX}.${workspaceHash.toLowerCase()}.${name}`;
}

/** Build a workspace-scoped metadata key directly from a workspace root. */
export function workspaceSecretMetadataKeyForRoot(
  workspaceRoot: string,
  name: string
): string {
  return workspaceSecretMetadataKey(workspaceSecretHash(workspaceRoot), name);
}

/** Return whether a SecretStore key belongs to a managed secret or its metadata. */
export function isManagedSecretStorageKey(key: string): boolean {
  for (const prefix of [USER_SECRET_PREFIX, USER_SECRET_METADATA_PREFIX]) {
    if (key.startsWith(`${prefix}.`)) {
      return isValidSecretName(key.slice(prefix.length + 1));
    }
  }
  for (const prefix of [
    WORKSPACE_SECRET_PREFIX,
    WORKSPACE_SECRET_METADATA_PREFIX,
  ]) {
    if (key.startsWith(`${prefix}.`)) {
      const [hash, name, ...rest] = key.slice(prefix.length + 1).split(".");
      return (
        rest.length === 0 &&
        WORKSPACE_HASH_PATTERN.test(hash) &&
        name !== undefined &&
        isValidSecretName(name)
      );
    }
  }
  return false;
}
