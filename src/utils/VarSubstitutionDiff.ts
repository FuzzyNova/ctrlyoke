import type { SubstitutedFieldPreview } from "../types/ExecutionPreviewTypes";
import { isRecord } from "./JsonTypeGuards";
import { findVariablePlaceholders } from "./VariablePlaceholders";

/** Keys never compared: runtime bookkeeping. */
const DEFAULT_SKIPPED_KEYS: ReadonlySet<string> = new Set(["_runtime"]);

/**
 * Every leaf where `authored` holds placeholder text and `substituted` holds
 * something else, in walk order. `VarSubstitutor` decides what changes; this
 * only reports it, so the list cannot drift from the substitution policy.
 */
export function diffSubstitutedFields(
  authored: unknown,
  substituted: unknown,
  options: { prefix?: string; skipKeys?: readonly string[] } = {}
): SubstitutedFieldPreview[] {
  const skipped = new Set([
    ...DEFAULT_SKIPPED_KEYS,
    ...(options.skipKeys ?? []),
  ]);
  const found: SubstitutedFieldPreview[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (left === right) return;
    if (typeof left === "string") {
      if (findVariablePlaceholders(left, false).length > 0)
        found.push({ path, authored: left, value: String(right) });
      return;
    }
    if (Array.isArray(left)) {
      if (!Array.isArray(right)) return;
      left.forEach((item, index) =>
        walk(item, right[index], `${path}[${index}]`)
      );
      return;
    }
    if (!isRecord(left) || !isRecord(right)) return;
    for (const key of Object.keys(left)) {
      if (skipped.has(key)) continue;
      walk(left[key], right[key], path ? `${path}.${key}` : key);
    }
  };
  walk(authored, substituted, options.prefix ?? "");
  return found;
}

/** `lists` concatenated, keeping the first entry for each path. */
export function mergeSubstitutedFields(
  ...lists: readonly SubstitutedFieldPreview[][]
): SubstitutedFieldPreview[] {
  const seen = new Set<string>();
  return lists.flat().filter((field) => {
    if (seen.has(field.path)) return false;
    seen.add(field.path);
    return true;
  });
}
