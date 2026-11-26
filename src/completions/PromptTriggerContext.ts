/**
 * Which prompt-token completion is active at the cursor: the trigger, the text
 * typed after it, and where it starts. Shared by the VS Code completion
 * provider and the dashboard's CodeMirror editor, so both open the same list
 * in the same places, and only where the runtime parsers would resolve the
 * finished reference.
 *
 * Pure: the webview bundle imports it, so no `vscode` or Node imports.
 */
import {
  COMPLETION_TRIGGERS,
  type CompletionTrigger,
} from "../types/DashboardConstants";
import { findPartialSlashTokenStart } from "../utils/CtrlYokeSlashTokens";
import { findWordStartTriggerIndex } from "../utils/ReferenceBoundary";
import type { InsertTextEscape } from "./WorkflowInsertEscape";

/** The triggers a typed character can open (everything but `path`). */
export type PromptTokenTrigger = Exclude<
  CompletionTrigger,
  typeof COMPLETION_TRIGGERS.PATH
>;

export interface PromptTriggerContext {
  trigger: PromptTokenTrigger;
  /**
   * Text after the trigger, as completion sources match it. For an `@` path
   * opened with a JSON-escaped quote (`@\"my dir/`), the escaping backslash is
   * dropped so the query reads `"my dir/`, the same as in an unescaped string.
   */
  query: string;
  /** Index of the trigger character within the text before the cursor. */
  index: number;
}

/**
 * What may follow each trigger. A query outside its pattern means the user is
 * not typing that reference, so no list opens.
 */
const QUERY_PATTERNS: Record<PromptTokenTrigger, RegExp> = {
  // Paths, `selection:` ranges and `sym:` names: anything but a space (handled
  // below), a quote, a backtick or an escape.
  [COMPLETION_TRIGGERS.HASH]: /^[^\s"'`\\]*$/u,
  // Git change references: `diff`, `staged`, `stash:N` or a commit hash. This
  // keeps `~/Documents` from opening the list.
  [COMPLETION_TRIGGERS.TILDE]: /^[a-zA-Z0-9:_]*$/,
  [COMPLETION_TRIGGERS.DOLLAR]: /^[a-zA-Z0-9:,-]*$/,
  // Secret names are uppercase-only. This also keeps Markdown image syntax
  // (`![alt](url)`) from opening the secret list.
  [COMPLETION_TRIGGERS.BANG]: /^[A-Z0-9_]*$/,
  [COMPLETION_TRIGGERS.SLASH]: /^[a-zA-Z0-9:._-]*$/,
  // `@` is checked by the quoted-path rule instead.
  [COMPLETION_TRIGGERS.AT]: /^/,
};

const WORD_START_TRIGGERS = [
  COMPLETION_TRIGGERS.AT,
  COMPLETION_TRIGGERS.HASH,
  COMPLETION_TRIGGERS.TILDE,
  COMPLETION_TRIGGERS.DOLLAR,
  COMPLETION_TRIGGERS.BANG,
] as const;

/** JSON-style escapes that decode to a control character (a word boundary). */
const CONTROL_ESCAPES = new Set(["b", "f", "n", "r", "t"]);

/**
 * Decode the JSON-style escapes in a JSON string or YAML double-quoted scalar
 * without changing offsets: each escape becomes padding followed by the
 * character it decodes to, so the boundary scan sees what the runtime parser
 * sees (`\n@` starts a word; `\\@`, `\/@` and `A@` do not). Scanning left
 * to right consumes `\\` as a pair, so `\\n` stays a backslash and an `n`.
 */
function decodeEscapesInPlace(text: string): string {
  return text.replace(/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/gu, (match: string) => {
    const code = match[1];
    const decoded = CONTROL_ESCAPES.has(code)
      ? " "
      : code === "u"
        ? String.fromCharCode(Number.parseInt(match.slice(2), 16))
        : code;
    return " ".repeat(match.length - 1) + decoded;
  });
}

/**
 * Find the prompt-token completion context at the end of `textBefore` (the
 * line up to the cursor). The rightmost trigger wins, and `/` uses the same
 * start boundary as the runtime slash-token parser, so `./x` and URLs never
 * open the `/skill:` list. Pass the escape of the string being edited, so an
 * `@` path opened with an escaped quote is recognised.
 */
export function findPromptTriggerContext(
  textBefore: string,
  escape?: InsertTextEscape,
  jsonStyleEscapes = false
): PromptTriggerContext | null {
  const boundaryText = jsonStyleEscapes
    ? decodeEscapesInPlace(textBefore)
    : textBefore;
  let trigger: PromptTokenTrigger | undefined;
  let index = findPartialSlashTokenStart(boundaryText);
  if (index !== -1) trigger = COMPLETION_TRIGGERS.SLASH;
  for (const candidate of WORD_START_TRIGGERS) {
    const candidateIndex = findWordStartTriggerIndex(boundaryText, candidate);
    if (candidateIndex > index) {
      index = candidateIndex;
      trigger = candidate;
    }
  }
  if (trigger === undefined) return null;

  const typed = textBefore.slice(index + 1);
  const query =
    trigger === COMPLETION_TRIGGERS.AT && escape && typed.startsWith('\\"')
      ? typed.slice(1)
      : typed;
  // A space ends the reference, except inside an `@"path with spaces`.
  const isInsideQuotedPath =
    trigger === COMPLETION_TRIGGERS.AT &&
    query.startsWith('"') &&
    !query.slice(1).includes('"');
  if (query.includes(" ") && !isInsideQuotedPath) return null;
  if (!QUERY_PATTERNS[trigger].test(query)) return null;

  return { trigger, query, index };
}
