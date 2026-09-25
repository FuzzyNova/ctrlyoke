import { SCHEMA_DESCRIPTIONS } from "@root/types/generated/SchemaDescriptions";

export type SchemaPropertyValue =
  string | number | boolean | null | { readonly omit: true };

function writeLiteral(
  value: Exclude<SchemaPropertyValue, { omit: true }>
): string {
  return value === null ? "null" : String(value);
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
  const body = description ?? SCHEMA_DESCRIPTIONS[path];
  const property = `property: ${path}${value !== undefined ? ` = ${writeLiteral(value)}` : ""}`;
  return body ? `${body} ${property}` : property;
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
  return value === undefined
    ? `${label}, property ${path}`
    : `${label}, ${path}: ${writeLiteral(value)}`;
}
