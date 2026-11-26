import { escapeJsonStringFragment } from "../utils/JsonStringEscape";
import {
  YAML_SCALAR_STYLES,
  type WorkflowLocation,
} from "./WorkflowLocationTypes";

/** Rewrites completion text so it stays literal inside the string it lands in. */
export type InsertTextEscape = (text: string) => string;

/** Whether raw text in this workflow value can contain JSON-style escapes. */
export function usesJsonStyleEscapes(
  location: Pick<WorkflowLocation, "jsonString" | "scalarStyle">
): boolean {
  return (
    location.jsonString ||
    location.scalarStyle === YAML_SCALAR_STYLES.DOUBLE_QUOTED
  );
}

const escapeSingleQuoted: InsertTextEscape = (text) => text.replace(/'/g, "''");

/**
 * The escape for text inserted at `location`: JSON escaping inside a JSON
 * string or a YAML double-quoted scalar, a doubled `'` inside a single-quoted
 * scalar, and none for plain and block scalars or markdown, which take text
 * as typed.
 */
export function getWorkflowInsertEscape(
  location: Pick<WorkflowLocation, "jsonString" | "scalarStyle">
): InsertTextEscape | undefined {
  if (usesJsonStyleEscapes(location)) {
    return escapeJsonStringFragment;
  }
  if (location.scalarStyle === YAML_SCALAR_STYLES.SINGLE_QUOTED) {
    return escapeSingleQuoted;
  }
  return undefined;
}
