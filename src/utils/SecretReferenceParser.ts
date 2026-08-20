import { isValidSecretName } from "../platform/SecretKey";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import { NOT_AFTER_BOUNDARY, NOT_BEFORE_BOUNDARY } from "./ReferenceBoundary";
import { maskFencedCodeBlocks } from "./FileReferenceParser";

/** A valid inline secret grant found in prompt text. */
export interface SecretReference {
  name: string;
  /** Offset of the `!` that starts the reference. */
  startOffset: number;
  /** Offset one past the end of the reference. */
  endOffset: number;
}

/**
 * Parse inline `!NAME` grants from prompt text.
 *
 * The boundary is shared with the existing context-reference scanners so a
 * bang inside a filename or prose is not treated as a trigger. The capture
 * deliberately allows an empty name and validates it through SecretKey: this
 * makes markdown image syntax (`![alt](url)`) fail closed without creating a
 * second copy of the managed-name rule.
 *
 * Triple-backtick fenced blocks are masked first, matching every other
 * reference trigger (`@`/`#`/`~`) — literal pasted text like `<!DOCTYPE>`
 * inside a fenced code/log excerpt must never be mistaken for a secret grant,
 * since an unresolvable name here hard-fails the whole run at preflight.
 */
export function parseSecretReferences(text: string): SecretReference[] {
  const references: SecretReference[] = [];
  const maskedText = maskFencedCodeBlocks(text);
  const regex = new RegExp(
    `${NOT_AFTER_BOUNDARY}!([A-Z0-9_]*)${NOT_BEFORE_BOUNDARY}`,
    "g"
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(maskedText)) !== null) {
    const name = match[1];
    if (!isValidSecretName(name)) {
      continue;
    }

    references.push({
      name,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return references;
}

/**
 * Return the grants available to one step. Inline prompt references and
 * references from the step's effective process maps are authoritative and
 * are unioned with the resolved declaration array.
 */
export function getEffectiveSecretGrants(
  step: WorkflowStep,
  resolvedSecrets: string[] | null | undefined,
  processMapSecretNames: readonly string[] = []
): string[] {
  const grants = new Set<string>();

  if ("prompt" in step) {
    for (const reference of parseSecretReferences(step.prompt)) {
      grants.add(reference.name);
    }
  }

  for (const name of resolvedSecrets ?? []) {
    if (isValidSecretName(name)) {
      grants.add(name);
    }
  }

  for (const name of processMapSecretNames) {
    if (isValidSecretName(name)) {
      grants.add(name);
    }
  }

  return [...grants];
}
