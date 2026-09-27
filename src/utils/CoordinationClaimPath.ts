import { foldPathForCompare } from "./PathCasing";

/**
 * Normalize a coordination claim path into its filesystem-aware comparison
 * form. The returned value is for comparisons only; persisted/displayed paths
 * must retain the original casing supplied by the participant.
 */
export function claimPathForCompare(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  return foldPathForCompare(normalized);
}
