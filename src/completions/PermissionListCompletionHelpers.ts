import { COPILOT_TO_CLAUDE_MAP } from "../core/harness/shared/CliToolPermissionMapper";

/** Completion item shape used by the tool permission list editor. */
export interface PermissionListCompletionItem {
  label: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  kind?: number;
  filterText?: string;
}

/** Backward-compatible short name used by the shared message contract. */
export type PermissionCompletionItem = PermissionListCompletionItem;

export interface PermissionCompletionContext {
  /** Start of the line containing the cursor. */
  lineStart: number;
  /** End of the line containing the cursor, excluding its newline. */
  lineEnd: number;
  /** Start of the text that a completion replaces. */
  replacementStart: number;
  /** Current line text, without its newline. */
  line: string;
  /** Current line text from its first non-whitespace character through the cursor. */
  beforeCursor: string;
}

const SHELL_ARGUMENT_STARTERS = [
  "git:*",
  "npm:*",
  "npx:*",
  "docker:*",
  "curl:*",
  "*",
] as const;

function clampPosition(text: string, position: number): number {
  return Math.max(0, Math.min(position, text.length));
}

/** Locate the current permission-list line and its completion replacement range. */
export function parsePermissionCompletionContext(
  text: string,
  position: number
): PermissionCompletionContext {
  const cursor = clampPosition(text, position);
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const nextNewline = text.indexOf("\n", cursor);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const line = text.slice(lineStart, lineEnd);
  const linePrefix = text.slice(lineStart, cursor);
  const leadingWhitespace = linePrefix.match(/^\s*/)?.[0].length ?? 0;
  const replacementStart = lineStart + leadingWhitespace;

  return {
    lineStart,
    lineEnd,
    replacementStart,
    line,
    beforeCursor: linePrefix.slice(leadingWhitespace),
  };
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}

function buildToolCandidates(): PermissionListCompletionItem[] {
  return Object.keys(COPILOT_TO_CLAUDE_MAP).map((toolName) => ({
    label: toolName,
    insertText: toolName,
    detail: "Tool permission",
    sortText: "10",
  }));
}

function buildShellCandidates(): PermissionListCompletionItem[] {
  return Object.keys(COPILOT_TO_CLAUDE_MAP)
    .filter((toolName) => toolName === "shell" || toolName === "bash")
    .flatMap((toolName) =>
      SHELL_ARGUMENT_STARTERS.map((argument) => ({
        label: `${toolName}(${argument})`,
        // Leave the cursor inside the parentheses so the user can continue
        // refining the pattern before adding the closing parenthesis.
        insertText: `${toolName}(${argument}`,
        detail: `${toolName} permission pattern`,
        sortText: "20",
      }))
    );
}

/**
 * Get permission-pattern completions for the line containing the cursor.
 * Each candidate replaces the current line's typed prefix, never the whole
 * multi-line document.
 */
export function getPermissionListCompletions(
  text: string,
  position: number
): PermissionListCompletionItem[] {
  const context = parsePermissionCompletionContext(text, position);
  const candidates = [...buildToolCandidates(), ...buildShellCandidates()];
  const beforeCursor = context.beforeCursor;
  const filtered = candidates.filter((candidate) =>
    matchesPrefix(candidate.insertText, beforeCursor)
  );

  return filtered.sort((a, b) => {
    const sortA = `${a.sortText ?? "50"}:${a.label}`;
    const sortB = `${b.sortText ?? "50"}:${b.label}`;
    return sortA.localeCompare(sortB);
  });
}

/** Alias with a shorter name for callers that do not need the implementation name. */
export const getPermissionCompletions = getPermissionListCompletions;
