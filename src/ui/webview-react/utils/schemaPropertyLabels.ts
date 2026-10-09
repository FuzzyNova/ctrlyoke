import { SCHEMA_DESCRIPTIONS } from "@root/types/generated/SchemaDescriptions";

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
 * the shared schema help for the property it writes. Omit `path` for options
 * that are not schema-backed.
 */
export function schemaOptionTitle(
  label: string,
  optionDescription?: string,
  path?: string,
  value?: SchemaPropertyValue
): string {
  return tooltipParagraphs(
    label,
    optionDescription,
    path ? schemaTitle(path, value) : undefined
  );
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
