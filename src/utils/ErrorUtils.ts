/**
 * Error utility functions — pure helpers for extracting error messages.
 *
 * Centralizes the `error instanceof Error ? error.message : String(error)`
 * pattern that would otherwise be duplicated across the codebase.
 */

/**
 * Extract a readable message string from an unknown caught value.
 * Works with Error instances, strings, and anything else that can be stringified.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
