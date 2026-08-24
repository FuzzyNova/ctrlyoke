/**
 * The syntax accepted by tool permission patterns.
 *
 * Keep this dependency-free because it is shared by extension-host and
 * webview code.
 */
export const TOOL_PATTERN_REGEX = /^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/;

export interface ToolPatternSyntaxIssues {
  /** Whether the pattern does not match TOOL_PATTERN_REGEX. */
  doesNotMatchPattern: boolean;
  /** Whether a wildcard appears without an argument-parentheses group. */
  hasWildcardOutsideParentheses: boolean;
  /** Whether an opening parenthesis has no closing parenthesis. */
  hasUnclosedParentheses: boolean;
  /** Whether the pattern contains an opening parenthesis. */
  hasOpeningParenthesis: boolean;
}

/**
 * Parse a tool pattern into its tool name and optional arguments.
 *
 * @returns [toolName, args] or null if the pattern does not match the
 * expected format.
 */
export function parseToolPattern(pattern: string): [string, string] | null {
  const match = pattern.match(TOOL_PATTERN_REGEX);
  if (!match) {
    return null;
  }

  return [match[1], match[2] || ""];
}

/**
 * Report the syntax findings used by permission-pattern consumers.
 *
 * The parenthesis checks intentionally mirror the mapper's existing behavior:
 * a wildcard is considered misplaced when there is no opening argument group,
 * and an opening parenthesis is considered unclosed when no closing
 * parenthesis appears anywhere in the pattern.
 */
export function inspectToolPatternSyntax(
  pattern: string
): ToolPatternSyntaxIssues {
  return {
    doesNotMatchPattern: parseToolPattern(pattern) === null,
    hasWildcardOutsideParentheses:
      pattern.includes("*") && !pattern.includes("("),
    hasUnclosedParentheses: pattern.includes("(") && !pattern.includes(")"),
    hasOpeningParenthesis: pattern.includes("("),
  };
}
