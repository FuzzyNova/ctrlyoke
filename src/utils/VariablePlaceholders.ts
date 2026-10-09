import { maskCodeRanges } from "./FileReferenceParser";
import { VARIABLE_NAME_PATTERN_SOURCE } from "./KeyValueKeyKinds";

/** One `{{name}}` placeholder in a piece of text. */
export interface VariablePlaceholder {
  /** Offset of the opening `{{`. */
  from: number;
  /** Offset just past the closing `}}`. */
  to: number;
  name: string;
  /**
   * True inside a fenced code block, where substitution never happens. Inline
   * code does *not* protect a placeholder (see {@link findVariablePlaceholders}).
   */
  inFence: boolean;
}

/** Length of the `{{` and `}}` delimiters around a placeholder name. */
export const VARIABLE_PLACEHOLDER_DELIMITER_LENGTH = 2;

const PLACEHOLDER_SOURCE = `\\{\\{(${VARIABLE_NAME_PATTERN_SOURCE})\\}\\}`;

/**
 * Every `{{name}}` placeholder in `text`, in order. This is the one definition
 * of what gets substituted: `VarSubstitutor` substitutes exactly the entries
 * with `inFence: false`, and the dashboard editor styles, lints and spell-skips
 * the same ranges, so what the editor shows cannot drift from what runs.
 *
 * Only fenced code blocks protect a placeholder. Inline code spans do not:
 * vars are also substituted into script text, where backticks are shell
 * command substitution, and authors put vars inside inline code on purpose.
 */
export function findVariablePlaceholders(text: string): VariablePlaceholder[] {
  const placeholders: VariablePlaceholder[] = [];
  if (!text.includes("{{")) return placeholders;
  const maskedText = maskCodeRanges(text, { fencesOnly: true });
  const pattern = new RegExp(PLACEHOLDER_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    placeholders.push({
      from,
      to,
      name: match[1],
      inFence: maskedText.slice(from, to).includes("\x00"),
    });
  }
  return placeholders;
}

/** Whether `vars` defines `name` (own keys only, so `{{toString}}` stays unresolved). */
export function isVariableDefined(
  vars: Readonly<Record<string, unknown>>,
  name: string
): boolean {
  return Object.prototype.hasOwnProperty.call(vars, name);
}
