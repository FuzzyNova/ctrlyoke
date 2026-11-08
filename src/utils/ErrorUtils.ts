/**
 * Error utility functions — pure helpers for extracting error messages.
 *
 * Centralizes the `error instanceof Error ? error.message : String(error)`
 * pattern that would otherwise be duplicated across the codebase.
 */

import type { NodeErrorCode } from "../types/DashboardConstants";

/** Read a string Node.js error code from an unknown caught value. */
export function getErrnoCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

/** Check whether an unknown caught value has one of the supplied errno codes. */
export function hasErrnoCode(
  error: unknown,
  ...codes: readonly NodeErrorCode[]
): boolean {
  const code = getErrnoCode(error);
  return code !== undefined && codes.some((candidate) => candidate === code);
}

/**
 * Extract a readable message string from an unknown caught value.
 * Works with Error instances, strings, and anything else that can be stringified.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalize an unknown caught value to an Error while preserving Error identity. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * `Error.cause` is ES2022 and the webview tsconfig targets an older lib, so
 * this file declares the shape rather than relying on the ambient `Error`.
 */
interface ErrorWithCause extends Error {
  readonly cause?: unknown;
}

/**
 * Extract a readable message that also walks the `cause` chain.
 *
 * Use this when logging an error whose user-facing message deliberately hides
 * the real failure (for example a license error that says "try again" over a
 * credential-store write that failed for a specific reason) — the log is the
 * only place the underlying cause can still be recovered.
 */
export function getErrorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(getErrorMessage(current));
    current =
      current instanceof Error ? (current as ErrorWithCause).cause : undefined;
  }
  return messages.join(" <- ");
}
