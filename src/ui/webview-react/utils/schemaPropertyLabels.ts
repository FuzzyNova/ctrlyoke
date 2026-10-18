import { SCHEMA_DESCRIPTIONS } from "@root/types/generated/SchemaDescriptions";
import type { DiscoveredFileLocationInfo } from "@root/types/WebviewMessageTypes";

export type SchemaPropertyValue =
  | string
  | number
  | boolean
  | null
  | { readonly omit: true }
  | { readonly writes: string };

function writeLiteral(
  value: Exclude<SchemaPropertyValue, { omit: true }>
): string {
  return value === null ? "null" : String(value);
}

/**
 * Join tooltip sections as blank-line-separated paragraphs. Native `title`
 * tooltips cannot be styled (no bold, no max-width), so paragraph breaks are
 * the only structure available to keep long help text scannable.
 */
export function tooltipParagraphs(
  ...sections: ReadonlyArray<string | undefined>
): string {
  return sections
    .map((section) => section?.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Build a schema tooltip ending in the file-relative property and value. */
export function schemaTitle(
  path: string,
  value?: SchemaPropertyValue,
  description?: string
): string {
  if (value && typeof value === "object" && "omit" in value) {
    return `omit ${path}`;
  }
  const pseudoWrite =
    value && typeof value === "object" && "writes" in value
      ? value.writes
      : undefined;
  const body = pseudoWrite ?? description ?? SCHEMA_DESCRIPTIONS[path];
  const property = `property: ${path}${value !== undefined && !pseudoWrite ? ` = ${writeLiteral(value)}` : ""}`;
  return tooltipParagraphs(body, property);
}

/**
 * Build one tooltip for a whole dropdown option row: the option's full
 * (possibly truncated on screen) label first, then its own description, then
 * the YAML it writes. The field's general schema help is deliberately left
 * out — the field label's tooltip already carries it, and repeating it made
 * every row tooltip a wall of text. Omit `path` for options that are not
 * schema-backed. `detail` (e.g. {@link discoveryLocationTitle}) goes between
 * the description and the YAML.
 */
export function schemaOptionTitle(
  label: string,
  optionDescription?: string,
  path?: string,
  value?: SchemaPropertyValue,
  detail?: string
): string {
  return tooltipParagraphs(
    label,
    optionDescription,
    detail,
    path ? schemaTitle(path, value, "") : undefined
  );
}

/**
 * Tooltip section naming where a discovered agent or skill is saved, plus
 * any same-named copies elsewhere. Workflows select by bare name and the
 * first copy wins (ctrlyoke folders first), so the others are listed as not
 * used, with how to choose one of them instead.
 */
export function discoveryLocationTitle(
  entry: DiscoveredFileLocationInfo
): string | undefined {
  if (!entry.displayPath) return undefined;
  const lines = [`Saved at: ${entry.displayPath}`];
  const copies = entry.shadowedCopies ?? [];
  for (const copy of copies) {
    lines.push(
      copy.identical
        ? `Identical copy: ${copy.displayPath}`
        : `Different copy, not used: ${copy.displayPath}`
    );
  }
  if (copies.some((copy) => !copy.identical)) {
    lines.push(
      "To use a different copy, move it into .ctrlyoke/ (workspace) or ~/.ctrlyoke/ (user). Workspace wins over user."
    );
  }
  return lines.join("\n");
}

/** Build an accessible option name that starts with its visible label. */
export function schemaAriaLabel(
  label: string,
  path: string,
  value?: SchemaPropertyValue
): string {
  if (value && typeof value === "object" && "omit" in value) {
    return `${label}, omit ${path}`;
  }
  if (value && typeof value === "object" && "writes" in value) {
    return `${label}, ${value.writes}`;
  }
  return value === undefined
    ? `${label}, property ${path}`
    : `${label}, ${path}: ${writeLiteral(value)}`;
}

/**
 * Build a field label's tooltip: the field name, its schema help (or
 * `fallbackDescription` when the schema has none), then the property path.
 */
export function schemaFieldTitle(
  label: string,
  path: string,
  fallbackDescription?: string
): string {
  return tooltipParagraphs(
    label,
    schemaTitle(
      path,
      undefined,
      SCHEMA_DESCRIPTIONS[path] ?? fallbackDescription
    )
  );
}
